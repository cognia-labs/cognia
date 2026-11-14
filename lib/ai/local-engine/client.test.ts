const deviceService = {
  getCapabilities: jest.fn(() => ({ canPullModels: true })),
  getStatus: jest.fn(),
  listModels: jest.fn(),
  pullModel: jest.fn(),
  deleteModel: jest.fn(),
  stopModel: jest.fn(),
}
jest.mock("@cognia/provider-core/providers/local-provider-service", () => ({
  ...jest.requireActual("@cognia/provider-core/providers/local-provider-service"),
  createLocalProviderService: jest.fn(() => deviceService),
  checkAllProvidersInstallation: jest.fn(),
}))
jest.mock("@cognia/provider-core/providers/ollama", () => ({
  probeOllamaModelCapabilities: jest.fn(),
}))
jest.mock("../execution-host", () => ({
  getRemoteExecutionHost: jest.fn(),
  isSameExecutionHost: jest.fn(),
}))

import {
  checkAllProvidersInstallation,
  createLocalProviderService,
  LocalProviderRequestError,
} from "@cognia/provider-core/providers/local-provider-service"
import { probeOllamaModelCapabilities } from "@cognia/provider-core/providers/ollama"
import { getRemoteExecutionHost, isSameExecutionHost } from "../execution-host"
import {
  checkLocalEngineInstallations,
  createLocalEngineClient,
  getLocalEngineTarget,
  getThisDeviceLocalEngineTarget,
  HOST_PULL_POLL_MS,
  LocalEngineHostChangedError,
  localEngineTargetKey,
  probeLocalEngineModelCapabilities,
} from "./client"

const call = jest.fn()
const host = {
  kind: "desktop-remote" as const,
  transport: { call, subscribe: jest.fn() } as never,
  label: "Build box",
  scopeKey: "scope-one",
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getRemoteExecutionHost).mockReturnValue(null)
  jest.mocked(isSameExecutionHost).mockReturnValue(true)
})

describe("on this device", () => {
  it("uses the local service and reports this device as the target", async () => {
    deviceService.getStatus.mockResolvedValue({ connected: true })
    const client = createLocalEngineClient("ollama", { baseUrl: "http://localhost:11434" })
    expect(client.target).toEqual({ kind: "this-device" })
    await expect(client.getStatus()).resolves.toEqual({ connected: true })
    expect(createLocalProviderService).toHaveBeenCalledWith("ollama", {
      baseUrl: "http://localhost:11434",
    })
    expect(call).not.toHaveBeenCalled()
  })

  it("probes installations and capabilities here", async () => {
    jest.mocked(checkAllProvidersInstallation).mockResolvedValue([])
    await checkLocalEngineInstallations({ ollama: "http://localhost:11500" })
    expect(checkAllProvidersInstallation).toHaveBeenCalledWith({ ollama: "http://localhost:11500" })
    jest.mocked(probeOllamaModelCapabilities).mockResolvedValue({ inferred: true } as never)
    const caps = await probeLocalEngineModelCapabilities("http://localhost:11434", ["a"])
    expect(caps.get("a")).toEqual({ inferred: true })
  })
})

describe("on the execution Host", () => {
  beforeEach(() => jest.mocked(getRemoteExecutionHost).mockReturnValue(host))

  it("names the Host and keeps one snapshot per route", () => {
    const first = getLocalEngineTarget()
    expect(first).toEqual({ kind: "host", label: "Build box", scopeKey: "scope-one" })
    expect(getLocalEngineTarget()).toBe(first)
    expect(localEngineTargetKey(first)).toBe("scope-one")
    expect(localEngineTargetKey(getThisDeviceLocalEngineTarget())).toBe("this-device")
  })

  it("asks the Host with the configured endpoint, never the local service", async () => {
    call.mockResolvedValue({ ok: true, value: [{ id: "llama3" }] })
    const client = createLocalEngineClient("ollama", {
      baseUrl: " http://localhost:11434 ",
      apiKey: " ",
      customHeaders: {},
    })
    await expect(client.listModels()).resolves.toEqual([{ id: "llama3" }])
    expect(call).toHaveBeenCalledWith("provider_local_engine_read", {
      op: "models",
      providerId: "ollama",
      baseUrl: "http://localhost:11434",
    })
    expect(createLocalProviderService).not.toHaveBeenCalled()
  })

  it("rebuilds the engine's error from the Host answer", async () => {
    call.mockResolvedValue({
      ok: false,
      error: { code: "authentication_failed", message: "HTTP 401", status: 401 },
    })
    const error = await createLocalEngineClient("vllm")
      .listModels()
      .catch((e) => e)
    expect(error).toBeInstanceOf(LocalProviderRequestError)
    expect(error).toMatchObject({ code: "authentication_failed", status: 401 })
    call.mockResolvedValue({ ok: false, error: { code: "request_failed", message: "boom" } })
    await expect(createLocalEngineClient("vllm").listModels()).rejects.toThrow("boom")
    call.mockResolvedValue({ unexpected: true })
    await expect(createLocalEngineClient("vllm").listModels()).rejects.toThrow("invalid")
  })

  it("reads an unreachable Host as an offline engine", async () => {
    call.mockRejectedValue(new Error("Host unreachable"))
    await expect(createLocalEngineClient("ollama").getStatus()).resolves.toEqual({
      connected: false,
      error: "Host unreachable",
    })
  })

  it("drops an answer that arrives after the route changed", async () => {
    call.mockImplementation(async () => {
      jest.mocked(isSameExecutionHost).mockReturnValue(false)
      return { ok: true, value: { connected: true } }
    })
    await expect(createLocalEngineClient("ollama").getStatus()).rejects.toBeInstanceOf(
      LocalEngineHostChangedError
    )
  })

  it("reports delete and stop support from the Host", async () => {
    call.mockResolvedValue({ ok: true, value: { supported: true } })
    await expect(createLocalEngineClient("ollama").deleteModel("m")).resolves.toBe(true)
    expect(call).toHaveBeenLastCalledWith("provider_local_engine_mutate", {
      op: "delete",
      model: "m",
      providerId: "ollama",
    })
    call.mockResolvedValue({ ok: true, value: { supported: false } })
    await expect(createLocalEngineClient("ollama").stopModel("m")).resolves.toBe(false)
  })

  it("polls a Host pull until it settles, forwarding each new progress line", async () => {
    jest.useFakeTimers()
    try {
      const job = (state: string, updatedAt: number, completed?: number) => ({
        jobId: "job",
        providerId: "ollama",
        model: "llama3",
        state,
        startedAt: 0,
        updatedAt,
        ...(completed === undefined
          ? {}
          : { progress: { model: "llama3", status: "pulling", completed, total: 10 } }),
      })
      call
        .mockResolvedValueOnce({ ok: true, value: { supported: true, job: job("running", 1) } })
        .mockResolvedValueOnce({ ok: true, value: job("running", 2, 5) })
        .mockResolvedValueOnce({ ok: true, value: job("running", 2, 5) })
        .mockResolvedValueOnce({ ok: true, value: job("succeeded", 3, 10) })
      const onProgress = jest.fn()
      const pending = createLocalEngineClient("ollama").pullModel("llama3", { onProgress })
      for (let i = 0; i < 3; i++) await jest.advanceTimersByTimeAsync(HOST_PULL_POLL_MS)
      await expect(pending).resolves.toMatchObject({ success: true })
      expect(onProgress.mock.calls.map(([p]) => p.completed)).toEqual([5, 10])
      expect(call).toHaveBeenCalledWith("provider_local_engine_read", {
        op: "pull_status",
        jobId: "job",
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it("stops polling when the caller detaches, without cancelling the Host download", async () => {
    jest.useFakeTimers()
    try {
      call.mockResolvedValue({
        ok: true,
        value: {
          supported: true,
          job: {
            jobId: "j",
            providerId: "ollama",
            model: "m",
            state: "running",
            startedAt: 0,
            updatedAt: 0,
          },
        },
      })
      const detach = new AbortController()
      const pending = createLocalEngineClient("ollama").pullModel("m", { signal: detach.signal })
      await Promise.resolve()
      detach.abort()
      await jest.advanceTimersByTimeAsync(HOST_PULL_POLL_MS)
      await expect(pending).resolves.toMatchObject({ success: false })
      expect(call).toHaveBeenCalledTimes(1)
      expect(call).not.toHaveBeenCalledWith(
        "provider_local_engine_mutate",
        expect.objectContaining({ op: "cancel" })
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it("surfaces a failed Host pull", async () => {
    call.mockResolvedValue({
      ok: true,
      value: {
        supported: true,
        job: {
          jobId: "j",
          providerId: "ollama",
          model: "m",
          state: "failed",
          error: "disk full",
          startedAt: 0,
          updatedAt: 1,
        },
      },
    })
    await expect(createLocalEngineClient("ollama").pullModel("m")).rejects.toThrow("disk full")
  })

  it("batches capability probes and drops empty installation URLs", async () => {
    call.mockResolvedValue({ ok: true, value: {} })
    await probeLocalEngineModelCapabilities(
      "http://localhost:11434",
      Array.from({ length: 70 }, (_, i) => `m${i}`)
    )
    expect(call).toHaveBeenCalledTimes(2)
    call.mockResolvedValue({ ok: true, value: [] })
    await checkLocalEngineInstallations({
      ollama: "http://localhost:1",
      lmstudio: " ",
      jan: undefined,
    })
    expect(call).toHaveBeenLastCalledWith("provider_local_engine_read", {
      op: "installation",
      baseUrls: { ollama: "http://localhost:1" },
    })
  })
})
