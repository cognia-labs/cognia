/** @jest-environment jsdom */
const mockRead = jest.fn()
jest.mock("@/lib/ai/code-mode/host-capability", () => ({
  readCodeHostCapability: () => mockRead(),
}))

const frameHandlers = new Set<(frame: { type?: unknown }) => void>()
jest.mock("@/lib/tauri", () => ({
  transport: {
    subscribe: (_event: string, handler: (frame: { type?: unknown }) => void) => {
      frameHandlers.add(handler)
      return () => frameHandlers.delete(handler)
    },
  },
}))

const remoteListeners = new Set<() => void>()
jest.mock("@/lib/tauri/transport-routing", () => ({
  subscribeActiveRemoteTransport: (listener: () => void) => {
    remoteListeners.add(listener)
    return () => remoteListeners.delete(listener)
  },
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { useCodeHostCapability } from "./use-code-host-capability"

const AVAILABLE = { state: "available", backend: "macos-sandbox-exec", generation: 1 }

beforeEach(() => {
  mockRead.mockReset()
  frameHandlers.clear()
  remoteListeners.clear()
})

describe("useCodeHostCapability", () => {
  // The gap between mount and answer is the dangerous one: offering `code`
  // optimistically would let a user pick something the Host cannot run.
  it("starts at probing, native only, before the Host answers", () => {
    mockRead.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useCodeHostCapability())
    expect(result.current.presentations).toEqual(["native"])
    expect(result.current.unavailableReason).toBe("probing")
  })

  it("widens once the Host reports a launcher", async () => {
    mockRead.mockResolvedValue(AVAILABLE)
    const { result } = renderHook(() => useCodeHostCapability())
    await waitFor(() => expect(result.current.presentations).toEqual(["native", "code", "both"]))
    expect(result.current.unavailableReason).toBeNull()
  })

  it("names the Host's reason when it cannot sandbox", async () => {
    mockRead.mockResolvedValue({ state: "unavailable", reason: "no-backend" })
    const { result } = renderHook(() => useCodeHostCapability())
    await waitFor(() => expect(result.current.unavailableReason).toBe("no-backend"))
    expect(result.current.presentations).toEqual(["native"])
  })

  // CM-02: the old hook asked once per app session and never again.
  it("asks again when the sidecar restarts", async () => {
    mockRead.mockResolvedValueOnce(AVAILABLE)
    const { result } = renderHook(() => useCodeHostCapability())
    await waitFor(() => expect(result.current.unavailableReason).toBeNull())

    mockRead.mockResolvedValueOnce({ state: "unavailable", reason: "killed" })
    act(() => {
      for (const handler of frameHandlers) handler({ type: "sidecar_exited" })
    })
    await waitFor(() => expect(result.current.unavailableReason).toBe("killed"))
    expect(mockRead).toHaveBeenCalledTimes(2)
  })

  it("ignores frames that do not change the sidecar generation", async () => {
    mockRead.mockResolvedValue(AVAILABLE)
    renderHook(() => useCodeHostCapability())
    await waitFor(() => expect(mockRead).toHaveBeenCalledTimes(1))
    act(() => {
      for (const handler of frameHandlers) handler({ type: "stream_event" })
    })
    expect(mockRead).toHaveBeenCalledTimes(1)
  })

  it("resets to probing and asks the new Host after a Host switch", async () => {
    mockRead.mockResolvedValueOnce(AVAILABLE)
    const { result } = renderHook(() => useCodeHostCapability())
    await waitFor(() => expect(result.current.unavailableReason).toBeNull())

    let answer: (value: unknown) => void = () => {}
    mockRead.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    act(() => {
      for (const listener of remoteListeners) listener()
    })
    expect(result.current.unavailableReason).toBe("probing")
    await act(async () => answer({ state: "unavailable", reason: "not-reported" }))
    expect(result.current.unavailableReason).toBe("not-reported")
  })

  it("lets only the newest question answer", async () => {
    let first: (value: unknown) => void = () => {}
    mockRead.mockReturnValueOnce(new Promise((resolve) => (first = resolve)))
    const { result } = renderHook(() => useCodeHostCapability())
    mockRead.mockResolvedValueOnce({ state: "unavailable", reason: "no-scratch" })
    act(() => {
      for (const listener of remoteListeners) listener()
    })
    await waitFor(() => expect(result.current.unavailableReason).toBe("no-scratch"))
    await act(async () => first(AVAILABLE))
    expect(result.current.unavailableReason).toBe("no-scratch")
  })

  it("does not set state after unmount", async () => {
    let resolve: (value: unknown) => void = () => {}
    mockRead.mockReturnValue(new Promise((r) => (resolve = r)))
    const { unmount } = renderHook(() => useCodeHostCapability())
    unmount()
    expect(frameHandlers.size).toBe(0)
    expect(remoteListeners.size).toBe(0)
    resolve(AVAILABLE)
    await Promise.resolve()
  })
})
