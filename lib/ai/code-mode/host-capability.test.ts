const mockCall = jest.fn()
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => mockCall(...args) },
}))

import {
  CODE_HOST_STATUS_COMMAND,
  readCodeHostCapability,
  readCodeHostToolPresentations,
} from "./host-capability"

beforeEach(() => mockCall.mockReset())

describe("readCodeHostCapability", () => {
  // The execution-target status command, not the client-local ADR-0028 probe:
  // on a paired client only this one reaches the Host that runs the turn.
  it("asks the execution Host's sidecar status", async () => {
    mockCall.mockResolvedValue({
      ready: true,
      codeSandbox: { available: true, backend: "macos-sandbox-exec", generation: 2 },
    })
    await expect(readCodeHostCapability()).resolves.toEqual({
      state: "available",
      backend: "macos-sandbox-exec",
      generation: 2,
    })
    expect(mockCall).toHaveBeenCalledWith(CODE_HOST_STATUS_COMMAND)
    expect(CODE_HOST_STATUS_COMMAND).toBe("claude_sidecar_status")
  })

  it("fails closed when no Host answers", async () => {
    mockCall.mockRejectedValue(new Error("not in Tauri"))
    await expect(readCodeHostCapability()).resolves.toEqual({
      state: "unavailable",
      reason: "unreachable",
    })
  })

  it("asks again on every call rather than pinning an old answer", async () => {
    mockCall
      .mockResolvedValueOnce({ codeSandbox: { available: true, backend: "b" } })
      .mockResolvedValueOnce({ codeSandbox: { available: false, reason: "killed" } })
    await expect(readCodeHostToolPresentations()).resolves.toEqual(["native", "code", "both"])
    await expect(readCodeHostToolPresentations()).resolves.toEqual(["native"])
  })
})
