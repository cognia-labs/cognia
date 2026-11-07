import type { ContextContribution, ContextTurnContext } from "@/lib/modules/manifest-types"
import type { ApplyMemoryContextDeps } from "./runtime/apply-memory-context"

const mockApplyMemory = jest.fn()
jest.mock("./runtime/apply-memory-context", () => ({
  applyMemoryContext: (input: unknown) => mockApplyMemory(input),
}))
const mockApplyContinuity = jest.fn()
jest.mock("@cognia/memory/runtime/project-continuity-context", () => ({
  applyProjectContinuityContext: (input: unknown) => mockApplyContinuity(input),
}))
const mockAudit = jest.fn(async (_event: unknown) => undefined)
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (event: unknown) => mockAudit(event),
}))

import { contributions, type RecallHandoff } from "./context"

const byId = (id: string) => contributions.find((c) => c.id === id) as ContextContribution
const recall = byId("recall")
const continuity = byId("continuity")

const memoryDeps = (): ApplyMemoryContextDeps => ({
  loadCandidates: async () =>
    [
      { id: "g", scope: "global" },
      { id: "w", scope: "workspace" },
    ] as never,
  loadProcedural: async () => [{ id: "p", scope: "character" }] as never,
})

function turn(fields: Partial<ContextTurnContext> = {}): ContextTurnContext {
  return {
    session: { id: "s1", projectId: "ws1" } as ContextTurnContext["session"],
    agent: { id: "agent-1", twinId: "twin-1" } as ContextTurnContext["agent"],
    settings: null,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
    query: { text: "what did we decide about releases?", embedding: [0.5] },
    hostDeps: {
      memory: memoryDeps(),
      memoryQuery: "what did we decide about releases?",
      memoryScope: { branch: "main", path: "docs/release.md" },
    },
    grant: null,
    kernelRetrieval: { twinChunkTexts: ["twin text"] },
    ...fields,
  }
}

const recallResult = {
  systemPromptSection: "## What you remember\n- releases ship on Tuesday",
  retrievedMemories: [
    {
      id: "m1",
      type: "semantic",
      text: "releases ship on Tuesday",
      score: 0.9,
      evidenceState: "fresh",
      reviewStatus: "approved",
      extra: "dropped",
    },
  ],
  proceduralCount: 0,
  withheldCount: 0,
  budget: { limit: 800, used: 300, truncated: false },
  degraded: false,
  snapshot: { status: "prepared" },
}

const continuityResult = {
  systemPromptSection: "## Project history\n- tag before release",
  claims: [{ id: "c1", kind: "decision", text: "tag before release", relevance: 0.8 }],
  withheldCount: 0,
  budget: { limit: 900, used: 100, truncated: false },
  weak: false,
  degraded: false,
}

beforeEach(() => {
  mockApplyMemory.mockReset()
  mockApplyContinuity.mockReset()
  mockAudit.mockClear()
})

it("declares recall and continuity as turn sections in their slots, continuity after recall", () => {
  expect(contributions.map((c) => c.id)).toEqual(["recall", "continuity"])
  expect(recall).toMatchObject({ cache: "turn", slot: "memory", deadlineMs: 15_000 })
  expect(continuity).toMatchObject({
    cache: "turn",
    slot: "continuity",
    after: "recall",
    deadlineMs: 15_000,
  })
})

describe("recall", () => {
  it("recalls for the agent's namespace, deduplicates against the twin, and hands its budget on", async () => {
    mockApplyMemory.mockResolvedValue(recallResult)
    const section = await recall.produce(turn())
    expect(section).toEqual({
      text: recallResult.systemPromptSection,
      handoff: { limit: 800, used: 300 },
      sources: {
        retrievedMemories: [
          {
            id: "m1",
            type: "semantic",
            text: "releases ship on Tuesday",
            score: 0.9,
            evidenceState: "fresh",
            reviewStatus: "approved",
          },
        ],
        proceduralCount: 0,
        withheldCount: 0,
        budget: recallResult.budget,
        degraded: false,
        snapshot: { status: "prepared" },
      },
    })
    const input = mockApplyMemory.mock.calls[0][0]
    expect(input).toMatchObject({
      userMessage: "what did we decide about releases?",
      reader: {
        characterId: "agent-1",
        projectId: "ws1",
        agentId: "twin:twin-1",
        branch: "main",
        path: "docs/release.md",
      },
      twinChunkTexts: ["twin text"],
      precomputedQueryEmbedding: [0.5],
    })
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "recall-allowed", sessionId: "s1" })
    )
  })

  it("names the targeted agent's namespace ahead of the twin's", async () => {
    mockApplyMemory.mockResolvedValue(recallResult)
    await recall.produce(
      turn({
        hostDeps: {
          memory: memoryDeps(),
          memoryQuery: "q",
          memoryScope: { targetAgentId: "claude-code" },
        },
      })
    )
    expect(mockApplyMemory.mock.calls[0][0].reader.agentId).toBe("claude-code")
  })

  it("hands its budget on even with no text, and reports nothing for an empty recall", async () => {
    mockApplyMemory.mockResolvedValue({
      ...recallResult,
      systemPromptSection: null,
      retrievedMemories: [],
    })
    expect(await recall.produce(turn())).toEqual({
      text: "",
      handoff: { limit: 800, used: 300 },
    })
  })

  it("narrows candidates and procedures to the agent's readable scopes", async () => {
    mockApplyMemory.mockResolvedValue(recallResult)
    await recall.produce(
      turn({
        agent: {
          id: "agent-1",
          memoryPolicy: { readableScopes: ["workspace"] },
        } as never,
      })
    )
    const { deps } = mockApplyMemory.mock.calls[0][0]
    expect((await deps.loadCandidates()).map((m: { id: string }) => m.id)).toEqual(["w"])
    expect(await deps.loadProcedural()).toEqual([])
  })

  it("does not run without memory deps or a memory query", async () => {
    expect(await recall.produce(turn({ hostDeps: { memoryQuery: "q" } }))).toBeNull()
    expect(await recall.produce(turn({ hostDeps: { memory: memoryDeps() } }))).toBeNull()
    expect(
      await recall.produce(turn({ hostDeps: { memory: memoryDeps(), memoryQuery: "  " } }))
    ).toBeNull()
    expect(mockApplyMemory).not.toHaveBeenCalled()
    expect(mockAudit).not.toHaveBeenCalled()
  })

  it("records a denied recall and recalls nothing when the agent may not recall", async () => {
    const section = await recall.produce(
      turn({ agent: { id: "agent-1", memoryPolicy: { operations: { recall: false } } } as never })
    )
    expect(section).toBeNull()
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "recall-denied" }))
    expect(mockApplyMemory).not.toHaveBeenCalled()
  })
})

describe("continuity", () => {
  // Project continuity is off unless the person turned it on.
  const on = {
    memory: { enableProjectContinuity: true },
  } as unknown as ContextTurnContext["settings"]
  const withPrior = (prior: RecallHandoff | undefined) =>
    prior === undefined ? turn({ settings: on }) : { ...turn({ settings: on }), prior }

  it("borrows what recall left unspent and reports the claims", async () => {
    mockApplyContinuity.mockResolvedValue(continuityResult)
    const section = await continuity.produce(withPrior({ limit: 800, used: 300 }))
    expect(section).toEqual({
      text: continuityResult.systemPromptSection,
      sources: {
        claims: continuityResult.claims,
        withheldCount: 0,
        budget: continuityResult.budget,
        weak: false,
        degraded: false,
      },
    })
    const borrowed = mockApplyContinuity.mock.calls[0][0]
    expect(borrowed).toMatchObject({
      userMessage: "what did we decide about releases?",
      reader: { projectId: "ws1", branch: "main", path: "docs/release.md" },
      precomputedQueryEmbedding: [0.5],
    })
    await continuity.produce(withPrior(undefined))
    const alone = mockApplyContinuity.mock.calls[1][0]
    // Without a handoff the personal budget counts as spent: nothing to borrow.
    expect(borrowed.maxTokens).toBeGreaterThan(alone.maxTokens)
  })

  it("does not run while off, or without a workspace, query terms, or workspace scope", async () => {
    expect(await continuity.produce(turn())).toBeNull()
    expect(
      await continuity.produce(turn({ settings: on, session: { id: "s1" } as never }))
    ).toBeNull()
    expect(
      await continuity.produce(
        turn({ settings: on, hostDeps: { memory: memoryDeps(), memoryQuery: "the and of" } })
      )
    ).toBeNull()
    expect(
      await continuity.produce(
        turn({
          settings: on,
          agent: { id: "agent-1", memoryPolicy: { readableScopes: ["global"] } } as never,
        })
      )
    ).toBeNull()
    expect(mockApplyContinuity).not.toHaveBeenCalled()
  })
})
