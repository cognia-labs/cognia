const service = {
  getCapabilities: jest.fn(() => ({ canPullModels: true })),
  getStatus: jest.fn(),
  listModels: jest.fn(),
  pullModel: jest.fn(),
  deleteModel: jest.fn(),
  stopModel: jest.fn(),
}
jest.mock("@cognia/provider-core/providers/local-provider-service", () => ({
  ...jest.requireActual("@cognia/provider-core/providers/local-provider-service"),
  createLocalProviderService: jest.fn(() => service),
  checkAllProvidersInstallation: jest.fn(),
}))
jest.mock("@cognia/provider-core/providers/ollama", () => ({
  probeOllamaModelCapabilities: jest.fn(),
}))

import {
  checkAllProvidersInstallation,
  createLocalProviderService,
  LocalProviderRequestError,
} from "@cognia/provider-core/providers/local-provider-service"
import { probeOllamaModelCapabilities } from "@cognia/provider-core/providers/ollama"
import {
  __resetLocalEnginePullJobsForTests,
  handleLocalEngineMutate,
  handleLocalEngineRead,
  isLocalEngineHostname,
  LocalEngineRequestInvalidError,
  MAX_PULL_DURATION_MS,
  MAX_RUNNING_PULLS,
  SETTLED_PULL_TTL_MS,
} from "./host-rpc"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetLocalEnginePullJobsForTests()
  service.getCapabilities.mockReturnValue({ canPullModels: true })
})

describe("the engine URL", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "[::1]",
    "0.0.0.0",
    "192.168.1.7",
    "10.0.0.2",
    "172.20.0.3",
    "gpu-box.local",
    "ollama",
    "100.101.102.103",
    "box.tail1234.ts.net",
    "host.docker.internal",
  ])("accepts %s as a local engine host", (host) => {
    expect(isLocalEngineHostname(host)).toBe(true)
  })

  it.each([
    "api.openai.com",
    "8.8.8.8",
    "example.com",
    "2001:4860::1",
    "169.254.169.254",
    "[fd00:ec2::254]",
    "metadata.google.internal",
  ])("refuses the public host %s", (host) => {
    expect(isLocalEngineHostname(host)).toBe(false)
  })

  it("refuses a public engine URL before any request leaves the Host", async () => {
    await expect(
      handleLocalEngineRead({ op: "status", providerId: "ollama", baseUrl: "https://example.com" })
    ).rejects.toBeInstanceOf(LocalEngineRequestInvalidError)
    expect(createLocalProviderService).not.toHaveBeenCalled()
  })

  it.each([
    ["a non-http scheme", "file:///etc/passwd"],
    ["embedded credentials", "http://user:pw@localhost:11434"],
    ["a malformed URL", "not a url"],
    ["a query that would rewrite the endpoint path", "http://10.0.0.5/admin?x="],
    ["a fragment", "http://localhost:11434#x"],
  ])("refuses %s", async (_label, baseUrl) => {
    await expect(
      handleLocalEngineRead({ op: "status", providerId: "ollama", baseUrl })
    ).rejects.toBeInstanceOf(LocalEngineRequestInvalidError)
  })

  it("refuses an unknown engine and an unknown op", async () => {
    await expect(handleLocalEngineRead({ op: "status", providerId: "openai" })).rejects.toThrow(
      "not a local engine"
    )
    await expect(handleLocalEngineRead({ op: "exec", providerId: "ollama" })).rejects.toThrow(
      "op is not"
    )
    await expect(
      handleLocalEngineMutate({ op: "rm", providerId: "ollama", model: "m" })
    ).rejects.toThrow("op is not")
  })
})

describe("reads", () => {
  it("probes the engine on this Host with the caller's endpoint", async () => {
    service.getStatus.mockResolvedValue({ connected: true, version: "0.9" })
    await expect(
      handleLocalEngineRead({
        op: "status",
        providerId: "ollama",
        baseUrl: "http://localhost:11500",
        apiKey: " key ",
        customHeaders: { "X-Team": "a" },
      })
    ).resolves.toEqual({ ok: true, value: { connected: true, version: "0.9" } })
    expect(createLocalProviderService).toHaveBeenCalledWith("ollama", {
      baseUrl: "http://localhost:11500",
      apiKey: "key",
      customHeaders: { "X-Team": "a" },
    })
  })

  it("carries an engine failure with its code", async () => {
    service.listModels.mockRejectedValue(
      new LocalProviderRequestError(
        "authentication_failed",
        "Authentication failed (HTTP 401)",
        401
      )
    )
    await expect(handleLocalEngineRead({ op: "models", providerId: "vllm" })).resolves.toEqual({
      ok: false,
      error: {
        code: "authentication_failed",
        message: "Authentication failed (HTTP 401)",
        status: 401,
      },
    })
  })

  it("probes installations with validated per-engine URLs", async () => {
    jest.mocked(checkAllProvidersInstallation).mockResolvedValue([])
    await handleLocalEngineRead({
      op: "installation",
      baseUrls: { ollama: "http://127.0.0.1:11500", lmstudio: "  " },
    })
    expect(checkAllProvidersInstallation).toHaveBeenCalledWith({ ollama: "http://127.0.0.1:11500" })
  })

  it("answers a refused URL for that engine without failing the whole scan", async () => {
    jest.mocked(checkAllProvidersInstallation).mockResolvedValue([
      { providerId: "ollama", running: false, installed: undefined },
      { providerId: "vllm", running: true, installed: true, version: "0.7" },
    ])
    const answer = await handleLocalEngineRead({
      op: "installation",
      baseUrls: { ollama: "https://example.com", vllm: "http://localhost:8000" },
    })
    expect(checkAllProvidersInstallation).toHaveBeenCalledWith({ vllm: "http://localhost:8000" })
    expect(answer).toEqual({
      ok: true,
      value: [
        { providerId: "ollama", running: false, error: expect.stringContaining("local engine") },
        { providerId: "vllm", running: true, installed: true, version: "0.7" },
      ],
    })
  })

  it("keeps an engine's odd answer inside the declared shape", async () => {
    service.getStatus.mockResolvedValue({
      connected: true,
      version: { major: 1 },
      models_count: 2.7,
      latency_ms: 4,
    })
    await expect(handleLocalEngineRead({ op: "status", providerId: "ollama" })).resolves.toEqual({
      ok: true,
      value: { connected: true, models_count: 2, latency_ms: 4 },
    })
    service.listModels.mockResolvedValue([{ id: "m", created: null, size: "big", extra: 1 }])
    await expect(handleLocalEngineRead({ op: "models", providerId: "ollama" })).resolves.toEqual({
      ok: true,
      value: [{ id: "m" }],
    })
  })

  it("probes Ollama capabilities on this Host, deduplicated", async () => {
    jest.mocked(probeOllamaModelCapabilities).mockResolvedValue({
      supportsVision: true,
      supportsTools: false,
      supportsEmbedding: false,
      supportsThinking: false,
      inferred: false,
    })
    const answer = await handleLocalEngineRead({
      op: "capabilities",
      models: ["llava", "llava", "qwen3"],
    })
    expect(answer.ok && Object.keys(answer.value as object)).toEqual(["llava", "qwen3"])
    expect(probeOllamaModelCapabilities).toHaveBeenCalledWith("http://localhost:11434", "llava")
    await expect(
      handleLocalEngineRead({ op: "capabilities", models: Array(65).fill("m") })
    ).rejects.toThrow("too many")
  })
})

describe("changes", () => {
  it("reports whether the engine can delete or unload", async () => {
    service.deleteModel.mockResolvedValue(true)
    service.stopModel.mockResolvedValue(false)
    await expect(
      handleLocalEngineMutate({ op: "delete", providerId: "ollama", model: "llama3" })
    ).resolves.toEqual({ ok: true, value: { supported: true } })
    await expect(
      handleLocalEngineMutate({ op: "stop", providerId: "lmstudio", model: "x" })
    ).resolves.toEqual({ ok: true, value: { supported: false } })
    await expect(
      handleLocalEngineMutate({ op: "delete", providerId: "ollama", model: " " })
    ).rejects.toThrow("model is required")
  })
})

describe("pulls", () => {
  it("runs on the Host as a job the client polls", async () => {
    const done = deferred<{ success: boolean; unsubscribe: () => void }>()
    let report: ((p: { model: string; status: string }) => void) | undefined
    service.pullModel.mockImplementation((_model, options) => {
      report = options.onProgress
      return done.promise
    })
    const started = await handleLocalEngineMutate({
      op: "pull",
      providerId: "ollama",
      model: "llama3",
    })
    if (!started.ok) throw new Error("pull refused")
    const job = (started.value as { job: { jobId: string; state: string } }).job
    expect(job.state).toBe("running")

    report?.({ model: "llama3", status: "downloading", completed: 5, total: 10 } as never)
    const running = await handleLocalEngineRead({ op: "pull_status", jobId: job.jobId })
    expect(running).toMatchObject({
      ok: true,
      value: { state: "running", progress: { status: "downloading", completed: 5 } },
    })

    const unsubscribe = jest.fn()
    done.resolve({ success: true, unsubscribe })
    await Promise.resolve()
    await Promise.resolve()
    const finished = await handleLocalEngineRead({ op: "pull_status", jobId: job.jobId })
    expect(finished).toMatchObject({ ok: true, value: { state: "succeeded" } })
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("fails a download the engine reports as an error line, despite a clean end", async () => {
    let report: ((p: Record<string, unknown>) => void) | undefined
    const done = deferred<{ success: boolean; unsubscribe: () => void }>()
    service.pullModel.mockImplementation((_model, options) => {
      report = options.onProgress
      return done.promise
    })
    const started = await handleLocalEngineMutate({ op: "pull", providerId: "ollama", model: "x" })
    const jobId = started.ok ? (started.value as { job: { jobId: string } }).job.jobId : ""
    report?.({ status: "pulling manifest" })
    report?.({ error: "pull model manifest: file does not exist" })
    done.resolve({ success: true, unsubscribe: jest.fn() })
    await Promise.resolve()
    await Promise.resolve()
    await expect(handleLocalEngineRead({ op: "pull_status", jobId })).resolves.toMatchObject({
      ok: true,
      value: { state: "failed", error: "pull model manifest: file does not exist" },
    })
  })

  it("keeps separate downloads for the same model on two engines", async () => {
    service.pullModel.mockReturnValue(new Promise(() => {}))
    await handleLocalEngineMutate({ op: "pull", providerId: "ollama", model: "m" })
    await handleLocalEngineMutate({
      op: "pull",
      providerId: "ollama",
      model: "m",
      baseUrl: "http://10.0.0.9:11434",
    })
    expect(service.pullModel).toHaveBeenCalledTimes(2)
  })

  it("stops counting a download that runs past its time", async () => {
    jest.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      service.pullModel.mockImplementation((_model, options) => {
        signal = options.signal
        return new Promise(() => {})
      })
      const started = await handleLocalEngineMutate({
        op: "pull",
        providerId: "localai",
        model: "stuck",
      })
      const jobId = started.ok ? (started.value as { job: { jobId: string } }).job.jobId : ""
      jest.advanceTimersByTime(MAX_PULL_DURATION_MS + 1)
      expect(signal?.aborted).toBe(true)
      await expect(handleLocalEngineRead({ op: "pull_status", jobId })).resolves.toMatchObject({
        ok: true,
        value: { state: "failed" },
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it("joins a download already under way for the same model", async () => {
    service.pullModel.mockReturnValue(new Promise(() => {}))
    const first = await handleLocalEngineMutate({ op: "pull", providerId: "ollama", model: "m" })
    const second = await handleLocalEngineMutate({ op: "pull", providerId: "ollama", model: "m" })
    expect(service.pullModel).toHaveBeenCalledTimes(1)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect((second.value as { job: { jobId: string } }).job.jobId).toBe(
        (first.value as { job: { jobId: string } }).job.jobId
      )
    }
  })

  it("bounds concurrent downloads", async () => {
    service.pullModel.mockReturnValue(new Promise(() => {}))
    for (let i = 0; i < MAX_RUNNING_PULLS; i++) {
      await handleLocalEngineMutate({ op: "pull", providerId: "ollama", model: `m${i}` })
    }
    await expect(
      handleLocalEngineMutate({ op: "pull", providerId: "ollama", model: "one-more" })
    ).resolves.toMatchObject({ ok: false, error: { code: "request_failed" } })
  })

  it("records a failed download and forgets settled jobs after their time", async () => {
    jest.useFakeTimers({ now: 1_000 })
    try {
      service.pullModel.mockRejectedValue(new Error("disk full"))
      const started = await handleLocalEngineMutate({
        op: "pull",
        providerId: "ollama",
        model: "big",
      })
      const jobId = started.ok ? (started.value as { job: { jobId: string } }).job.jobId : ""
      await Promise.resolve()
      await Promise.resolve()
      await expect(handleLocalEngineRead({ op: "pull_status", jobId })).resolves.toMatchObject({
        ok: true,
        value: { state: "failed", error: "disk full" },
      })
      jest.setSystemTime(1_000 + SETTLED_PULL_TTL_MS + 1)
      await expect(handleLocalEngineRead({ op: "pull_status", jobId })).resolves.toMatchObject({
        ok: false,
        error: { message: "Unknown model download" },
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it("answers unsupported for an engine that cannot pull", async () => {
    service.getCapabilities.mockReturnValue({ canPullModels: false })
    await expect(
      handleLocalEngineMutate({ op: "pull", providerId: "vllm", model: "m" })
    ).resolves.toEqual({ ok: true, value: { supported: false } })
    expect(service.pullModel).not.toHaveBeenCalled()
  })
})
