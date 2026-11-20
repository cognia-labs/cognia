const mockResolve = jest.fn()
const mockHostPresentations = jest.fn()
jest.mock("@/lib/ai/code-mode/host-capability", () => ({
  readCodeHostToolPresentations: () => mockHostPresentations(),
}))
jest.mock("@/lib/agent/composition/resolve-turn-composition", () => ({
  resolveTurnComposition: (...args: unknown[]) => mockResolve(...args),
  toolSurfaceFromNames: (names: string[]) =>
    names.map((name) => ({ name, schema: null, visibility: "native" })),
}))

import { resolveTurnCompositionSafely } from "./resolve-turn-composition-safely"

beforeEach(() => mockResolve.mockReset())

describe("resolveTurnCompositionSafely", () => {
  it("passes the session, prompt, tools and fingerprint through", async () => {
    mockResolve.mockResolvedValue({ presetId: "standard" })
    await resolveTurnCompositionSafely({
      sessionId: "s1",
      prompt: { systemPrompt: "sys", appendSystemPrompt: "tail" },
      toolNames: ["read", "grep"],
      executionFingerprint: "fp_1",
    })
    expect(mockResolve).toHaveBeenCalledWith({
      sessionId: "s1",
      prompt: { systemPrompt: "sys", appendSystemPrompt: "tail" },
      tools: [
        { name: "read", schema: null, visibility: "native" },
        { name: "grep", schema: null, visibility: "native" },
      ],
      executionFingerprint: "fp_1",
      selection: undefined,
      supportedToolPresentations: expect.any(Function),
    })
  })

  // CM-01: the send path must hand the resolver the execution Host's answer,
  // or a Code / Both selection reaches the sidecar as `native`.
  it("hands the resolver the execution Host query", async () => {
    mockResolve.mockResolvedValue({ presetId: "standard" })
    mockHostPresentations.mockResolvedValue(["native", "code", "both"])
    await resolveTurnCompositionSafely({ sessionId: "s1" })
    const query = mockResolve.mock.calls[0][0].supportedToolPresentations as () => Promise<string[]>
    await expect(query()).resolves.toEqual(["native", "code", "both"])
  })

  it("prefers an injected Host query", async () => {
    mockResolve.mockResolvedValue({ presetId: "standard" })
    const injected = jest.fn()
    await resolveTurnCompositionSafely({ hostToolPresentations: injected })
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ supportedToolPresentations: injected })
    )
  })

  // The seam that stops an IM turn composing from the desktop's localStorage:
  // without a forwarded selection `resolveTurnComposition` reads the session
  // store, which for a connector turn is a value nobody chose.
  it("forwards a pre-resolved selection instead of letting the store decide", async () => {
    mockResolve.mockResolvedValue({ presetId: "standard" })
    const selection = {
      presetId: "standard",
      orchestration: "team" as const,
      orchestrationRef: "team-1",
      engagement: "background" as const,
      autonomy: "suggest" as const,
    }
    await resolveTurnCompositionSafely({ sessionId: "s1", selection })
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ selection }))
  })

  it("returns the resolved composition", async () => {
    mockResolve.mockResolvedValue({ presetId: "minimal" })
    await expect(resolveTurnCompositionSafely({})).resolves.toEqual({ presetId: "minimal" })
  })

  // The send path never fails over spec stamping, and an absent composition
  // means the sidecar keeps the native surface it always had — the safe
  // direction, not a surface nobody authorised.
  it("degrades to undefined rather than failing the send", async () => {
    mockResolve.mockRejectedValue(new Error("digest failed"))
    await expect(resolveTurnCompositionSafely({ sessionId: "s1" })).resolves.toBeUndefined()
  })

  it("treats a missing tool list as an empty surface", async () => {
    mockResolve.mockResolvedValue({ presetId: "standard" })
    await resolveTurnCompositionSafely({})
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }))
  })
})
