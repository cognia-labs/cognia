import { renderHook, act } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("sonner", () => ({
  toast: { info: jest.fn(), warning: jest.fn(), error: jest.fn(), success: jest.fn() },
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: jest.fn(() => ({ complete: jest.fn() })),
}))
let mockPiiSafe = true
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: () => mockPiiSafe,
  redactText: (t: string) => ({ redacted: `RED(${t})` }),
}))
jest.mock("@/lib/git/ai-explain", () => ({
  generateDiffExplanation: jest.fn(async () => "the explanation"),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { gitSettings: { explainAI: { enabled: true } } } }),
}))

import { useAiDiffExplain } from "./use-ai-diff-explain"

describe("useAiDiffExplain", () => {
  it("generates an explanation and exposes it as text", async () => {
    const { result } = renderHook(() => useAiDiffExplain("a.ts", "diff A"))
    await act(async () => {
      await result.current.explain()
    })
    expect(result.current.text).toBe("the explanation")
    expect(result.current.error).toBeNull()
  })

  it("resets the cached explanation when the subject changes", async () => {
    const { result, rerender } = renderHook(
      ({ subject, diffText }) => useAiDiffExplain(subject, diffText),
      { initialProps: { subject: "a.ts", diffText: "diff A" } }
    )
    await act(async () => {
      await result.current.explain()
    })
    expect(result.current.text).toBe("the explanation")
    // Switching to a different file must drop the previous file's summary so the
    // popover's `!text` auto-run re-fires instead of showing a stale explanation.
    rerender({ subject: "b.ts", diffText: "diff B" })
    expect(result.current.text).toBeNull()
  })

  it("resets when only the diff text changes (same subject, edited file)", async () => {
    const { result, rerender } = renderHook(
      ({ subject, diffText }) => useAiDiffExplain(subject, diffText),
      { initialProps: { subject: "a.ts", diffText: "diff A" } }
    )
    await act(async () => {
      await result.current.explain()
    })
    expect(result.current.text).toBe("the explanation")
    rerender({ subject: "a.ts", diffText: "diff A2" })
    expect(result.current.text).toBeNull()
  })

  it("keeps the explanation across an unrelated re-render (same inputs)", async () => {
    const { result, rerender } = renderHook(
      ({ subject, diffText }) => useAiDiffExplain(subject, diffText),
      { initialProps: { subject: "a.ts", diffText: "diff A" } }
    )
    await act(async () => {
      await result.current.explain()
    })
    rerender({ subject: "a.ts", diffText: "diff A" })
    expect(result.current.text).toBe("the explanation")
  })

  it("redacts subject and custom instructions when PII is detected (T15 sibling)", async () => {
    const { generateDiffExplanation } = await import("@/lib/git/ai-explain")
    mockPiiSafe = false
    try {
      const { result } = renderHook(() => useAiDiffExplain("users/jane@example.com/a.ts", "diff A"))
      await act(async () => {
        await result.current.explain()
      })
      expect(generateDiffExplanation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subject: "RED(users/jane@example.com/a.ts)",
          diffText: "RED(diff A)",
        }),
        expect.anything()
      )
    } finally {
      mockPiiSafe = true
    }
  })
})
