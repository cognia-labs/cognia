/**
 * Coverage for the `twin_context_get` renderer handler. The load-bearing
 * assertion: the projected result NEVER carries retrieved chunk content —
 * only titles + scores (the chunk `content` field is unredacted by design
 * and must not cross the CLI bridge).
 */

const getCharacterMock = jest.fn()
jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  getCharacter: (...args: unknown[]) => getCharacterMock(...args),
}))

const tryBuildTwinDepsMock = jest.fn()
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: (...args: unknown[]) => tryBuildTwinDepsMock(...args),
}))

const applyTwinContextMock = jest.fn()
jest.mock("@/lib/twin/runtime/apply-twin-context", () => ({
  applyTwinContext: (...args: unknown[]) => applyTwinContextMock(...args),
}))

import { twinContextGet as handleTwinContext } from "./twin-context"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { startToolExecutionRun, LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
async function twinContextGet(payload: Record<string, unknown>) {
  const run = await startToolExecutionRun(undefined, { localAuthorization: LOCAL_PERSON_RUN })
  return handleTwinContext(payload, { executionRunId: run.id })
}

beforeEach(() => {
  getCharacterMock.mockReset()
  tryBuildTwinDepsMock.mockReset()
  applyTwinContextMock.mockReset()
})

describe("twinContextGet", () => {
  it("refuses caller-supplied session/identity labels before private retrieval", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "tw1" })
    const out = await handleTwinContext({
      characterId: "c1",
      message: "hi",
      sessionId: "forged-owner",
      executionRunId: "local",
      readers: [{ kind: "local-person" }],
    })
    expect(out).toMatchObject({
      ok: true,
      degraded: true,
      degradedReason: "personal_history_withheld",
      sources: [],
    })
    expect(out.applied).toBeUndefined()
    expect(tryBuildTwinDepsMock).not.toHaveBeenCalled()
    expect(applyTwinContextMock).not.toHaveBeenCalled()
  })
  it("validates message and characterId", async () => {
    expect((await twinContextGet({ characterId: "c1", message: "  " })).ok).toBe(false)
    expect((await twinContextGet({ message: "hi" })).ok).toBe(false)
  })

  it("returns ok with no applied context for a non-twin-bound character", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1" })
    const out = await twinContextGet({ characterId: "c1", message: "hi" })
    expect(out).toEqual({ ok: true, degraded: false, sources: [], styleSampleCount: 0 })
    expect(tryBuildTwinDepsMock).not.toHaveBeenCalled()
  })

  it("degrades honestly when the twin runtime is not configured", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "tw1" })
    tryBuildTwinDepsMock.mockResolvedValue(undefined)
    const out = await twinContextGet({ characterId: "c1", message: "hi" })
    expect(out.ok).toBe(true)
    expect(out.degraded).toBe(true)
    expect(out.degradedReason).toMatch(/not configured/)
  })

  it("projects the applied prompt + segments and strips chunk content", async () => {
    getCharacterMock.mockResolvedValue({ id: "c1", twinId: "tw1" })
    tryBuildTwinDepsMock.mockResolvedValue({ embedding: {}, store: {} })
    applyTwinContextMock.mockResolvedValue({
      applied: {
        systemPrompt: "TWIN PROMPT",
        cacheSegments: { stable: "STABLE", dynamic: "DYNAMIC" },
      },
      degraded: false,
      retrievedChunks: [
        {
          chunk: { vectorDocId: "v1", content: "RAW SECRET CONTENT", sourceId: "s1" },
          score: 0.9,
          sourceTitle: "Doc A",
        },
        { chunk: { vectorDocId: "v2", content: "MORE RAW", sourceId: "s2" }, score: 0.5 },
      ],
      selectedStyleSamples: [{ id: "ss1" }, { id: "ss2" }],
    })

    const out = await twinContextGet({ characterId: "c1", message: "hi", sessionId: "sess1" })
    expect(applyTwinContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "hi", sessionId: "sess1" })
    )
    expect(out.applied).toEqual({
      systemPrompt: "TWIN PROMPT",
      stable: "STABLE",
      dynamic: "DYNAMIC",
    })
    expect(out.sources).toEqual([{ title: "Doc A", score: 0.9 }, { score: 0.5 }])
    expect(out.styleSampleCount).toBe(2)
    // PII red-line: no raw chunk content anywhere in the projection.
    expect(JSON.stringify(out)).not.toContain("RAW SECRET CONTENT")
  })

  it("collapses handler exceptions into ok:false", async () => {
    getCharacterMock.mockRejectedValue(new Error("dexie offline"))
    const out = await twinContextGet({ characterId: "c1", message: "hi" })
    expect(out).toMatchObject({ ok: false, error: "dexie offline" })
  })
})
