/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const probe = jest.fn()
jest.mock("@cognia/provider-core/providers/ollama", () => ({
  probeOllamaModelCapabilities: (...args: unknown[]) => probe(...args),
}))

const mockHostCall = jest.fn()
let mockActiveHost: { kind: string; transport: unknown; label: string; scopeKey: string } | null =
  null
const mockHostListeners = new Set<() => void>()
jest.mock("@/lib/ai/execution-host", () => ({
  getRemoteExecutionHost: () => mockActiveHost,
  isSameExecutionHost: (host: unknown) => host === mockActiveHost,
  subscribeExecutionHost: (listener: () => void) => {
    mockHostListeners.add(listener)
    return () => mockHostListeners.delete(listener)
  },
}))

import { useOllamaModelCapabilities } from "./use-ollama-model-capabilities"

function switchHost(next: typeof mockActiveHost) {
  mockActiveHost = next
  for (const listener of [...mockHostListeners]) listener()
}

const visionCaps = {
  supportsVision: true,
  supportsTools: true,
  supportsEmbedding: false,
  supportsThinking: false,
  contextLength: 131072,
  architecture: "qwen2",
  inferred: false,
}

beforeEach(() => {
  mockActiveHost = null
  mockHostCall.mockReset()
  probe.mockReset()
  probe.mockResolvedValue(visionCaps)
})

describe("useOllamaModelCapabilities", () => {
  it("probes each installed model and keys the answers by model id", async () => {
    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        modelIds: ["qwen2.5-vl:7b", "llama3.2"],
      })
    )

    await waitFor(() => expect(result.current.capabilities.size).toBe(2))
    expect(probe).toHaveBeenCalledWith("http://localhost:11434", "qwen2.5-vl:7b")
    expect(probe).toHaveBeenCalledWith("http://localhost:11434", "llama3.2")
    expect(result.current.capabilities.get("qwen2.5-vl:7b")).toEqual(visionCaps)
  })

  /**
   * `/api/show` is Ollama's endpoint. The other nine local providers have no
   * equivalent, so probing them would be a wasted round-trip at best and an
   * invented answer at worst.
   */
  it("does not probe providers that have no /api/show", async () => {
    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "lmstudio",
        baseUrl: "http://localhost:1234",
        modelIds: ["mistral"],
      })
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(probe).not.toHaveBeenCalled()
    expect(result.current.capabilities.size).toBe(0)
  })

  it("does nothing without a baseUrl or without models", async () => {
    renderHook(() => useOllamaModelCapabilities({ providerId: "ollama", modelIds: ["m"] }))
    renderHook(() =>
      useOllamaModelCapabilities({ providerId: "ollama", baseUrl: "http://x", modelIds: [] })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(probe).not.toHaveBeenCalled()
  })

  /** One round-trip per model is the price of a real answer — pay it once. */
  it("does not re-probe a model it has already asked about", async () => {
    const { result, rerender } = renderHook(
      (props: { modelIds: string[] }) =>
        useOllamaModelCapabilities({
          providerId: "ollama",
          baseUrl: "http://localhost:11434",
          modelIds: props.modelIds,
        }),
      { initialProps: { modelIds: ["a"] } }
    )
    await waitFor(() => expect(result.current.capabilities.size).toBe(1))
    expect(probe).toHaveBeenCalledTimes(1)

    // Same list, fresh array identity — the sort of thing a parent re-render
    // produces constantly.
    rerender({ modelIds: ["a"] })
    await act(async () => {
      await Promise.resolve()
    })
    expect(probe).toHaveBeenCalledTimes(1)

    // A newly pulled model IS probed, and only it.
    rerender({ modelIds: ["a", "b"] })
    await waitFor(() => expect(result.current.capabilities.size).toBe(2))
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenLastCalledWith("http://localhost:11434", "b")
  })

  /**
   * The cache is keyed by baseUrl, so pointing at a different server re-probes
   * rather than serving another machine's answers for a same-named model.
   */
  it("re-probes when the server changes", async () => {
    const { result, rerender } = renderHook(
      (props: { baseUrl: string }) =>
        useOllamaModelCapabilities({
          providerId: "ollama",
          baseUrl: props.baseUrl,
          modelIds: ["a"],
        }),
      { initialProps: { baseUrl: "http://localhost:11434" } }
    )
    await waitFor(() => expect(result.current.capabilities.size).toBe(1))

    rerender({ baseUrl: "http://127.0.0.1:11500" })
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    expect(probe).toHaveBeenLastCalledWith("http://127.0.0.1:11500", "a")
  })

  it("reports probing state around the round-trip", async () => {
    let release: ((v: unknown) => void) | undefined
    probe.mockImplementation(() => new Promise((r) => (release = r)))

    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        modelIds: ["a"],
      })
    )

    await waitFor(() => expect(result.current.isProbing).toBe(true))
    await act(async () => {
      release?.(visionCaps)
    })
    await waitFor(() => expect(result.current.isProbing).toBe(false))
  })
})

describe("useOllamaModelCapabilities on the execution Host", () => {
  const host = () => ({
    kind: "paired-client",
    transport: { call: mockHostCall, subscribe: jest.fn() },
    label: "Studio",
    scopeKey: "studio",
  })

  it("asks the Host's Ollama, not this device's", async () => {
    mockActiveHost = host()
    mockHostCall.mockResolvedValue({ ok: true, value: { "llama3.2": visionCaps } })
    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        modelIds: ["llama3.2"],
      })
    )
    await waitFor(() => expect(result.current.capabilities.get("llama3.2")).toEqual(visionCaps))
    expect(probe).not.toHaveBeenCalled()
    expect(mockHostCall).toHaveBeenCalledWith("provider_local_engine_read", {
      op: "capabilities",
      baseUrl: "http://localhost:11434",
      models: ["llama3.2"],
    })
  })

  it("re-probes the same URL after switching machines", async () => {
    const { result } = renderHook(() =>
      useOllamaModelCapabilities({
        providerId: "ollama",
        baseUrl: "http://localhost:11434",
        modelIds: ["llama3.2"],
      })
    )
    await waitFor(() => expect(result.current.capabilities.size).toBe(1))
    const hostCaps = { ...visionCaps, supportsVision: false }
    mockHostCall.mockResolvedValue({ ok: true, value: { "llama3.2": hostCaps } })
    act(() => switchHost(host()))
    await waitFor(() => expect(result.current.capabilities.get("llama3.2")).toEqual(hostCaps))
  })

  it("leaves the badges absent and retries after a failed Host probe", async () => {
    mockActiveHost = host()
    mockHostCall.mockRejectedValueOnce(new Error("Host unreachable"))
    const { result, rerender } = renderHook(
      ({ ids }) =>
        useOllamaModelCapabilities({
          providerId: "ollama",
          baseUrl: "http://localhost:11434",
          modelIds: ids,
        }),
      { initialProps: { ids: ["llama3.2"] } }
    )
    await waitFor(() => expect(result.current.isProbing).toBe(false))
    expect(result.current.capabilities.size).toBe(0)
    mockHostCall.mockResolvedValue({ ok: true, value: { "llama3.2": visionCaps } })
    rerender({ ids: ["llama3.2"] })
    await waitFor(() => expect(result.current.capabilities.size).toBe(1))
  })
})
