import type { ContextContribution, ContextTurnContext } from "@/lib/modules/manifest-types"

const mockApplyTwin = jest.fn()
jest.mock("./runtime/apply-twin-context", () => ({
  applyTwinContext: (input: unknown) => mockApplyTwin(input),
}))
const mockRecord = jest.fn(async (_entry: unknown) => undefined)
jest.mock("./runtime/inject-log", () => ({
  recordTwinInject: (entry: unknown) => mockRecord(entry),
}))
const mockClean = jest.fn((_value: unknown) => true)
jest.mock("@cognia/redact", () => ({
  ...jest.requireActual("@cognia/redact"),
  hasNoLeakingPiiDeep: (value: unknown) => mockClean(value),
}))

import { TWIN_IDENTITY_DEADLINE_MS, contributions } from "./context"

const identity = contributions[0] as ContextContribution

function turn(fields: Partial<ContextTurnContext> = {}): ContextTurnContext {
  return {
    session: { id: "s1" } as ContextTurnContext["session"],
    agent: { id: "agent-1", twinId: "twin-1", systemPrompt: "base" } as ContextTurnContext["agent"],
    settings: null,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
    query: { text: "what would Ada do?", embedding: [0.5] },
    hostDeps: { twin: {} as never, twinQuery: "what would Ada do?", twinInjectSource: "team" },
    grant: null,
    kernelRetrieval: { identityTexts: [] },
    ...fields,
  }
}

const chunk = {
  chunk: { id: "c1", vectorDocId: "v1", contentRedacted: "ships on Tuesday", sourceId: "doc" },
  score: 0.9,
}

const applied = {
  systemPrompt: "I am Ada.\n\n---\n\nships on Tuesday",
  cacheSegments: { stable: "I am Ada.", dynamic: "ships on Tuesday" },
}

beforeEach(() => {
  mockApplyTwin.mockReset()
  mockRecord.mockClear()
  mockClean.mockReset()
  mockClean.mockReturnValue(true)
})

it("is the module's identity section, held to the retrieval deadline", () => {
  expect(contributions.map((c) => c.id)).toEqual(["identity"])
  expect(identity).toMatchObject({
    cache: "turn",
    slot: "identity",
    deadlineMs: TWIN_IDENTITY_DEADLINE_MS,
  })
  expect(identity.after).toBeUndefined()
})

it("stands in for the base prompt, hands its chunk text on and reports its sources", async () => {
  mockApplyTwin.mockResolvedValue({
    applied,
    retrievedChunks: [chunk],
    selectedStyleSamples: [
      { id: "st1", contextLabel: "Slack", summary: "brief", tone: ["dry"], extra: "dropped" },
    ],
    degraded: false,
  })
  const section = await identity.produce(turn())
  expect(section).toEqual({
    text: applied.systemPrompt,
    cacheSplit: applied.cacheSegments,
    handoff: ["ships on Tuesday"],
    sources: {
      twinId: "twin-1",
      retrievedChunks: [chunk],
      selectedStyleSamples: [{ id: "st1", contextLabel: "Slack", summary: "brief", tone: ["dry"] }],
      degraded: false,
    },
  })
  expect(mockApplyTwin.mock.calls[0][0]).toMatchObject({
    userMessage: "what would Ada do?",
    precomputedQueryEmbedding: [0.5],
  })
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      twinId: "twin-1",
      source: "team",
      applied: true,
      degraded: false,
      chunkIds: ["c1"],
      sessionId: "s1",
    })
  )
})

it("reports a degraded run with nothing to replace", async () => {
  mockApplyTwin.mockResolvedValue({
    applied: null,
    retrievedChunks: [],
    selectedStyleSamples: [],
    degraded: true,
    degradedReason: "store-no-search",
  })
  const section = await identity.produce(turn())
  expect(section).toEqual({
    text: "",
    handoff: [],
    sources: { twinId: "twin-1", retrievedChunks: [], selectedStyleSamples: [], degraded: true },
  })
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({ applied: false, degraded: true, degradedReason: "store-no-search" })
  )
})

it("reports no sources when retrieval found nothing and did not degrade", async () => {
  mockApplyTwin.mockResolvedValue({
    applied: { systemPrompt: "I am Ada." },
    retrievedChunks: [],
    selectedStyleSamples: [],
    degraded: false,
  })
  expect(await identity.produce(turn())).toEqual({ text: "I am Ada.", handoff: [] })
})

it("leaves out a prompt that leaks PII and records why", async () => {
  mockClean.mockReturnValue(false)
  mockApplyTwin.mockResolvedValue({
    applied,
    retrievedChunks: [chunk],
    selectedStyleSamples: [],
    degraded: false,
  })
  expect(await identity.produce(turn())).toBeNull()
  expect(mockClean).toHaveBeenCalledWith(applied.cacheSegments)
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      applied: false,
      degraded: true,
      degradedReason: "prompt-pii-blocked",
      tokensApprox: 0,
    })
  )
})

it("counts a retrieval past its budget as a failure and records the timeout", async () => {
  jest.useFakeTimers()
  try {
    mockApplyTwin.mockReturnValue(new Promise(() => {}))
    const pending = identity.produce(turn())
    await jest.advanceTimersByTimeAsync(TWIN_IDENTITY_DEADLINE_MS - 1_000)
    expect(await pending).toBeNull()
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ applied: false, degraded: true, degradedReason: "timeout" })
    )
  } finally {
    jest.useRealTimers()
  }
})

it("lets a runtime failure through for the kernel to report", async () => {
  mockApplyTwin.mockRejectedValue(new Error("boom"))
  await expect(identity.produce(turn())).rejects.toThrow("boom")
})

it("does not run without a twin-bound agent, twin deps or a query", async () => {
  expect(
    await identity.produce(turn({ agent: { id: "agent-1" } as ContextTurnContext["agent"] }))
  ).toBeNull()
  expect(await identity.produce(turn({ hostDeps: { twinQuery: "q" } }))).toBeNull()
  expect(
    await identity.produce(turn({ hostDeps: { twin: {} as never, twinQuery: "  " } }))
  ).toBeNull()
  expect(mockApplyTwin).not.toHaveBeenCalled()
  expect(mockRecord).not.toHaveBeenCalled()
})

it("names the caller chat when the source is not given", async () => {
  mockApplyTwin.mockResolvedValue({
    applied: { systemPrompt: "I am Ada." },
    retrievedChunks: [],
    selectedStyleSamples: [],
    degraded: false,
  })
  await identity.produce(turn({ hostDeps: { twin: {} as never, twinQuery: "q" } }))
  expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ source: "chat" }))
})
