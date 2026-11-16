import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "@/types/memory/memory"
import type { Memory } from "@/types/memory/memory"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { bindPersonalMessageRun } from "@/lib/execution/personal-marks"
import { commitMessageDelta, listMessages } from "@/lib/db/messages"
import { contributions } from "@/lib/memory/context"
import type { ContextTurnContext } from "@/lib/modules/manifest-types"

const mockTryBuildTwinDeps = jest.fn()
const mockCreateProviderEmbeddingAdapter = jest.fn()
const mockSearchByEmbedding = jest.fn()
const mockGetSettings = jest.fn()
const mockBuildUtilityLlmClient = jest.fn()
const mockCreateMemoryLlmReranker = jest.fn()

jest.mock("@/lib/twin/runtime/build-deps", () => ({
  tryBuildTwinDeps: () => mockTryBuildTwinDeps(),
}))
jest.mock("@cognia/memory/runtime/provider-embedding-adapter", () => ({
  createProviderEmbeddingAdapter: (...args: unknown[]) =>
    mockCreateProviderEmbeddingAdapter(...args),
}))
jest.mock("@/lib/ai/providers/sidecar-models", () => ({
  createBedrockSidecarEmbeddingModel: jest.fn(() => ({ specificationVersion: "v3" })),
}))
jest.mock("@/lib/db/memories", () => ({
  listActiveForReader: jest.fn(async () => [{ id: "c1" }]),
  listActiveProcedural: jest.fn(async () => [{ id: "p1" }]),
  listHistoricalForReader: jest.fn(async () => [{ id: "h1" }]),
  touchMemories: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => mockGetSettings(),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...args: unknown[]) => mockBuildUtilityLlmClient(...args),
}))
jest.mock("@cognia/memory/retrieve/llm-rerank", () => ({
  ...jest.requireActual("@cognia/memory/retrieve/llm-rerank"),
  createMemoryLlmReranker: (...args: unknown[]) => mockCreateMemoryLlmReranker(...args),
}))

import { listHistoricalForReader } from "@/lib/db/memories"
import { MEMORY_RERANK_SYSTEM_PROMPT } from "@cognia/memory/retrieve/llm-rerank"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { MEMORY_RERANK_PROMPT } from "./rerank-prompt"
import {
  tryBuildMemoryDeps,
  tryBuildMemoryVectorReader,
  tryBuildMemoryVectorSink,
  describeMemoryRetrievalMode,
  MEMORY_VECTOR_COLLECTION,
  filterPersonalMemories,
  withPersonalMemoryVisibility,
} from "./build-deps"

function cfg(over: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSearchByEmbedding.mockResolvedValue([{ id: "v1", content: "x", score: 0.7 }])
  mockCreateProviderEmbeddingAdapter.mockReturnValue(async () => [0.1, 0.2])
  mockGetSettings.mockResolvedValue({ theme: "dark" })
  mockBuildUtilityLlmClient.mockReturnValue({ complete: jest.fn() })
  mockCreateMemoryLlmReranker.mockReturnValue(async () => null)
})

describe("personal memory provenance", () => {
  const fixture = createDbTestFixture()
  beforeAll(fixture.initialize)
  beforeEach(fixture.restore)
  afterAll(fixture.dispose)
  const other = {
    kind: "platform",
    platform: "lark",
    adapterId: "a",
    remoteUserId: "other",
  } as const
  const mark = (person: typeof other | { kind: "local-person" }) => ({
    person,
    source: "test",
    markedAt: 1,
  })
  const memory = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, text: `${id} remembered prose`, ...extra }) as unknown as Memory

  it.each(["semantic", "procedural", "project"] as const)(
    "propagates injected %s provenance through the run tree, persisted reply and readerless consumers",
    async (kind) => {
      const db = getDb()
      const sourceMark = mark({ kind: "local-person" })
      await db.sessions.bulkPut([
        { id: "source-session", title: "Source", projectId: "p" },
        { id: "reader", title: "Reader", projectId: "p" },
      ] as never)
      await db.messages.put({
        id: "personal-source",
        sessionId: "source-session",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "pnpm releases happen Tuesday" }],
        metadata: { personalMarks: [sourceMark] },
      } as never)
      const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
      const child = await startToolExecutionRun("reader", { parentRunId: root.id })
      const fact = (await jest.requireActual("@/lib/db/memories").createMemory({
        text: "pnpm releases happen Tuesday",
        type: kind === "procedural" ? "procedural" : "semantic",
        scope: kind === "project" ? "workspace" : "global",
        projectId: kind === "project" ? "p" : undefined,
        projectMemoryKind: kind === "project" ? "decision" : undefined,
        provenance: "explicit",
        importance: 8,
        reviewStatus: "verified",
        trustState: "trusted",
        sourceSessionId: "source-session",
        sourceMessageId: "personal-source",
      })) as Memory
      const deps = withPersonalMemoryVisibility(
        {
          loadCandidates: async () => (kind === "procedural" ? [] : [fact]),
          loadProcedural: async () => (kind === "procedural" ? [fact] : []),
        },
        "reader",
        child.id
      )
      const ctx = {
        session: { id: "reader", projectId: "p" },
        agent: null,
        settings: { memory: { enableProjectContinuity: true, relevanceFloor: 0.01 } },
        activeGoal: null,
        prompts: { snapshot: null, context: {} },
        host: "desktop",
        activeProject: null,
        query: { text: "pnpm releases", embedding: null },
        grant: null,
        hostDeps: { memory: deps, memoryQuery: "pnpm releases" },
        kernelRetrieval: { identityTexts: [] },
      } as unknown as ContextTurnContext
      const section = await contributions
        .find((c) => c.id === (kind === "project" ? "continuity" : "recall"))!
        .produce(ctx)
      expect(section?.text).toContain(fact.text)
      for (const runId of [root.id, child.id])
        expect((await db.executionRuns.get(runId))?.personalMarks).toEqual([sourceMark])
      const reply = {
        id: "reply",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: fact.text }],
      }
      bindPersonalMessageRun(reply.id, child.id)
      await commitMessageDelta("reader", { upserts: [reply] })
      const [persisted] = await listMessages("reader")
      expect(persisted.metadata).toMatchObject({ personalMarks: [sourceMark] })
      expect(
        await filterPersonalMemories([
          memory("repeated", { sourceMessageId: reply.id, sourceSessionId: "reader" }),
        ])
      ).toEqual([])
      await import("@/lib/workflow/nodes/sessions")
      const { getExecutor } = await import("@/lib/workflow/nodes/registry")
      const result = await getExecutor("action.session.get", 1)!.execute({
        params: { sessionId: "reader", messageLimit: 10 },
        workflowId: "wf",
        runId: "readerless",
        stepId: "read",
      } as never)
      expect(JSON.stringify(result.output)).not.toContain(fact.text)
      expect(JSON.stringify(result.output)).toContain("Withheld")
    }
  )

  it("leaves a run and its reply unmarked when recall injects only public provenance", async () => {
    const run = await startToolExecutionRun("reader", { localAuthorization: LOCAL_PERSON_RUN })
    await getDb().sessions.put({ id: "reader", projectId: "p", title: "Reader" } as never)
    await getDb().messages.put({
      id: "public",
      sessionId: "source",
      createdAt: 1,
      metadata: { personalMarkVersion: 1 },
    } as never)
    const fact = (await jest.requireActual("@/lib/db/memories").createMemory({
      text: "pnpm releases happen Tuesday",
      scope: "global",
      type: "semantic",
      provenance: "explicit",
      importance: 8,
      sourceMessageId: "public",
    })) as Memory
    const deps = withPersonalMemoryVisibility(
      { loadCandidates: async () => [fact], loadProcedural: async () => [] },
      "reader",
      run.id
    )
    const section = await contributions[0].produce({
      session: { id: "reader" },
      agent: null,
      settings: null,
      hostDeps: { memory: deps, memoryQuery: "pnpm releases" },
      query: { text: "pnpm releases", embedding: null },
      kernelRetrieval: { identityTexts: [] },
    } as unknown as ContextTurnContext)
    expect(section?.text).toContain(fact.text)
    expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
    bindPersonalMessageRun("public-reply", run.id)
    await commitMessageDelta("reader", {
      upserts: [
        { id: "public-reply", role: "assistant", parts: [{ type: "text", text: fact.text }] },
      ],
    })
    expect((await listMessages("reader"))[0].metadata).not.toHaveProperty("personalMarks")
  })

  it("does not taint a run merely for loading personal candidates that are not injected", async () => {
    const run = await startToolExecutionRun("reader", { localAuthorization: LOCAL_PERSON_RUN })
    const fact = memory("candidate", { personalMarks: [mark({ kind: "local-person" })] })
    const deps = withPersonalMemoryVisibility(
      { loadCandidates: async () => [fact], loadProcedural: async () => [] },
      "reader",
      run.id
    )
    expect(await deps.loadCandidates()).toEqual([fact])
    await deps.markInjectedMemories?.([])
    expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
  })

  it("keeps unproven legacy memories with the owner and withholds them from another requester", async () => {
    const run = await startToolExecutionRun("reader", { localAuthorization: LOCAL_PERSON_RUN })
    const legacy = memory("legacy")
    expect(await filterPersonalMemories([legacy], "reader", run.id)).toEqual([legacy])
    await getDb().executionRuns.update(run.id, {
      actingIdentity: { ...run.actingIdentity!, trigger: "requester", requesters: [other] },
    })
    expect(await filterPersonalMemories([legacy], "reader", run.id)).toEqual([])
    expect(await filterPersonalMemories([legacy])).toEqual([])
  })

  it("checks explicit memory marks together with its canonical source marks", async () => {
    const run = await startToolExecutionRun("reader", { localAuthorization: LOCAL_PERSON_RUN })
    await getDb().messages.put({
      id: "source",
      sessionId: "source-session",
      role: "assistant",
      createdAt: 1,
      parts: [{ type: "text", text: "other person's private source" }],
      metadata: { personalMarks: [mark(other)] },
    } as never)
    const fromSource = memory("from-source", {
      sourceSessionId: "source-session",
      sourceMessageId: "source",
    })
    const explicit = memory("explicit", { personalMarks: [mark(other)] })
    const missing = memory("missing", { sourceMessageId: "deleted-source" })
    expect(await filterPersonalMemories([fromSource, explicit, missing], "reader", run.id)).toEqual(
      []
    )
    await getDb().executionRuns.update(run.id, {
      actingIdentity: { ...run.actingIdentity!, trigger: "requester", requesters: [other] },
    })
    expect(await filterPersonalMemories([fromSource, explicit, missing], "reader", run.id)).toEqual(
      [fromSource, explicit]
    )
    const mixed = memory("mixed", {
      sourceMessageId: "source",
      metadata: { personalMarks: [mark({ kind: "local-person" })] },
    })
    expect(await filterPersonalMemories([mixed], "reader", run.id)).toEqual([])
  })

  it("filters every candidate leg before downstream reranking and checks session-only provenance", async () => {
    const run = await startToolExecutionRun("reader", { localAuthorization: LOCAL_PERSON_RUN })
    await getDb().messages.bulkPut([
      {
        id: "public",
        sessionId: "source-session",
        role: "user",
        createdAt: 1,
        parts: [{ type: "text", text: "public source" }],
        metadata: { personalMarkVersion: 1 },
      },
      {
        id: "private",
        sessionId: "source-session",
        role: "assistant",
        createdAt: 2,
        parts: [{ type: "text", text: "private source" }],
        metadata: { personalMarks: [mark(other)] },
      },
    ] as never)
    const publicMemory = memory("public-memory", { sourceMessageId: "public" })
    const sessionMemory = memory("session-memory", { sourceSessionId: "source-session" })
    const values = [publicMemory, sessionMemory]
    const rerank = jest.fn()
    const deps = withPersonalMemoryVisibility(
      {
        loadCandidates: async () => values,
        loadProcedural: async () => values,
        loadHistoricalCandidates: async () => values,
        touch: async () => undefined,
        rerank,
      },
      "reader",
      run.id
    )
    expect(await deps.loadCandidates()).toEqual([publicMemory])
    expect(await deps.loadProcedural()).toEqual([publicMemory])
    expect(await deps.loadHistoricalCandidates!()).toEqual([publicMemory])
    expect(deps.rerank).toBe(rerank)
  })
})

describe("tryBuildMemoryDeps", () => {
  it("returns undefined when memory is disabled", async () => {
    expect(await tryBuildMemoryDeps(cfg({ enabled: false }))).toBeUndefined()
    expect(await tryBuildMemoryDeps(cfg({ temporary: true }))).toBeUndefined()
  })

  it("builds local deps when global recall is off so a chat-level opt-in can work", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    expect(await tryBuildMemoryDeps(cfg({ useMemory: false }))).toBeDefined()
  })

  it("returns base (BM25-only) deps when no twin backend is available", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    const deps = await tryBuildMemoryDeps(cfg())
    expect(deps).toBeDefined()
    expect(deps!.embed).toBeUndefined()
    expect(deps!.vectorSearch).toBeUndefined()
    expect((await deps!.loadCandidates()).length).toBe(1)
    expect((await deps!.loadProcedural()).length).toBe(1)
  })

  it("does NOT attach cloud embedding when allowCloudEmbedding is false", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: false }))
    expect(deps!.embed).toBeUndefined()
    expect(deps!.vectorSearch).toBeUndefined()
  })

  it("attaches embedding for a local provider even without cloud opt-in", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: false }))
    expect(deps!.embed).toBeDefined()
    expect(deps!.vectorSearch).toBeDefined()
    expect(await deps!.embed!("hi")).toEqual([0.1, 0.2])
    const hits = await deps!.vectorSearch!([0.1], 3)
    expect(mockSearchByEmbedding).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, [0.1], {
      limit: 3,
    })
    expect(hits).toEqual([{ id: "v1", score: 0.7 }])
  })

  it("attaches cloud embedding when the user opts in", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: true }))
    expect(deps!.embed).toBeDefined()
    expect(deps!.vectorSearch).toBeDefined()
  })

  it("builds a sidecar embedding proxy for Bedrock default-chain auth", async () => {
    const bedrock = { authMode: "default-chain" as const, region: "us-west-2", profile: "dev" }
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: {
        provider: "amazon-bedrock",
        model: "amazon.titan-embed-text-v2:0",
        apiKey: "",
        bedrock,
      },
    })

    const deps = await tryBuildMemoryDeps(cfg({ allowCloudEmbedding: true }))

    expect(deps?.embed).toBeDefined()
    expect(mockCreateProviderEmbeddingAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "amazon-bedrock",
        bedrock,
        bedrockModel: { specificationVersion: "v3" },
      })
    )
  })

  it("falls back to BM25-only when building the backend throws", async () => {
    mockTryBuildTwinDeps.mockRejectedValue(new Error("boom"))
    const deps = await tryBuildMemoryDeps(cfg())
    expect(deps).toBeDefined()
    expect(deps!.embed).toBeUndefined()
  })

  it("skips embedding when the store lacks searchByEmbedding", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: {},
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    expect(deps!.vectorSearch).toBeUndefined()
  })

  it("stays BM25-only when hybridEnabled is off, even with a usable local backend", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg({ hybridEnabled: false }))
    expect(deps).toBeDefined()
    expect(deps!.embed).toBeUndefined()
    expect(deps!.vectorSearch).toBeUndefined()
  })

  it("scopes the vector leg to the plan's allowlist and scores locally", async () => {
    // The eligible-candidate allowlist replaces the global top-K query: only
    // the authorized doc ids are fetched, then cosine-scored in-process —
    // unauthorized rows can no longer crowd out the result window.
    const getDocuments = jest.fn(async () => [
      { id: "auth-close", embedding: [1, 0] },
      { id: "auth-far", embedding: [0, 1] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    const hits = await deps!.vectorSearch!([1, 0], 5, {
      vectorDocIds: ["auth-close", "auth-far"],
    })
    expect(getDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, ["auth-close", "auth-far"])
    expect(mockSearchByEmbedding).not.toHaveBeenCalled()
    expect(hits[0].id).toBe("auth-close")
    expect(hits[0].score).toBeCloseTo(1)
    expect(hits[1].id).toBe("auth-far")
    expect(hits[1].score).toBeCloseTo(0)
  })

  it("returns [] for an empty allowlist without touching the store", async () => {
    const getDocuments = jest.fn()
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    expect(await deps!.vectorSearch!([1, 0], 5, { vectorDocIds: [] })).toEqual([])
    expect(getDocuments).not.toHaveBeenCalled()
    expect(mockSearchByEmbedding).not.toHaveBeenCalled()
  })

  it("scores all authorized vectors in bounded batches, retaining late best matches", async () => {
    const ids = Array.from({ length: 601 }, (_, index) => `memory-${index}`)
    const getDocuments = jest.fn(async (_collection: string, batch: string[]) => {
      expect(batch.length).toBeLessThanOrEqual(256)
      return batch.map((id) => ({
        id,
        embedding: id === "memory-600" ? [1, 0] : [0, 1],
      }))
    })
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await expect(deps!.vectorSearch!([1, 0], 1, { vectorDocIds: ids })).resolves.toEqual([
      { id: "memory-600", score: 1 },
    ])
    expect(getDocuments.mock.calls.flatMap(([, batch]) => batch)).toEqual(ids)
  })

  it("excludes non-finite vectors and unexpected ids returned by a scoped backend", async () => {
    const getDocuments = jest.fn(async () => [
      { id: "unauthorized", embedding: [1, 0] },
      { id: "nan", embedding: [NaN, 1] },
      { id: "infinite", embedding: [Infinity, 0] },
      { id: "safe", embedding: [0, 1] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await expect(
      deps!.vectorSearch!([1, 0], 5, {
        vectorDocIds: ["nan", "infinite", "safe"],
      })
    ).resolves.toEqual([{ id: "safe", score: 0 }])
  })

  it("stops a cancelled vector scan before requesting the next batch", async () => {
    const controller = new AbortController()
    const getDocuments = jest.fn(async () => {
      controller.abort()
      return []
    })
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await expect(
      deps!.vectorSearch!([1, 0], 1, {
        vectorDocIds: Array.from({ length: 600 }, (_, index) => String(index)),
        signal: controller.signal,
      })
    ).rejects.toThrow()
    expect(getDocuments).toHaveBeenCalledTimes(1)
  })

  it("passes cancellation to the embedding adapter and refuses an aborted query", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    const controller = new AbortController()
    await deps!.embed!("bounded query", { signal: controller.signal })
    expect(mockCreateProviderEmbeddingAdapter).toHaveBeenLastCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    )
    controller.abort()
    const count = mockCreateProviderEmbeddingAdapter.mock.calls.length
    await expect(deps!.embed!("aborted query", { signal: controller.signal })).rejects.toThrow()
    expect(mockCreateProviderEmbeddingAdapter).toHaveBeenCalledTimes(count)
  })

  it("drops unembedded or dimension-mismatched docs and respects topK", async () => {
    const getDocuments = jest.fn(async () => [
      { id: "no-vec" },
      { id: "wrong-dims", embedding: [1, 0, 0] },
      { id: "best", embedding: [1, 0] },
      { id: "worst", embedding: [-1, 0] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    const hits = await deps!.vectorSearch!([1, 0], 1, {
      vectorDocIds: ["no-vec", "wrong-dims", "best", "worst"],
    })
    expect(hits).toEqual([{ id: "best", score: expect.closeTo(1) }])
  })

  it("keeps the global search for a plan-less (legacy) call", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments: jest.fn() },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const deps = await tryBuildMemoryDeps(cfg())
    await deps!.vectorSearch!([0.1], 3)
    expect(mockSearchByEmbedding).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, [0.1], {
      limit: 3,
    })
  })

  it("reuses prebuilt twin deps and does not call tryBuildTwinDeps again", async () => {
    const prebuilt = {
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    } as never
    const deps = await tryBuildMemoryDeps(cfg(), prebuilt)
    expect(deps!.embed).toBeDefined()
    expect(deps!.vectorSearch).toBeDefined()
    // The second tryBuildTwinDeps() call is skipped — the backend came from the
    // caller-supplied deps.
    expect(mockTryBuildTwinDeps).not.toHaveBeenCalled()
  })
})

describe("tryBuildMemoryDeps defaults / historical / rerank", () => {
  beforeEach(() => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
  })

  it("loads historical candidates through listHistoricalForReader", async () => {
    const deps = await tryBuildMemoryDeps(cfg())
    const reader = { scope: "global" } as never
    await expect(deps!.loadHistoricalCandidates!(reader)).resolves.toEqual([{ id: "h1" }])
    expect(listHistoricalForReader).toHaveBeenCalledWith(reader)
  })

  it("derives off-by-default recall defaults from the default config", async () => {
    const deps = await tryBuildMemoryDeps(cfg())
    expect(deps!.defaults).toEqual({
      sessionRecallRouting: false,
      beliefRankingWeight: 0,
      rerank: false,
    })
  })

  it("carries configured recall defaults and clamps a negative belief weight to 0", async () => {
    const on = await tryBuildMemoryDeps(
      cfg({ sessionRecallRouting: true, beliefRankingWeight: 0.4, llmRerank: true })
    )
    expect(on!.defaults).toEqual({
      sessionRecallRouting: true,
      beliefRankingWeight: 0.4,
      rerank: true,
    })
    const negative = await tryBuildMemoryDeps(cfg({ beliefRankingWeight: -2 }))
    expect(negative!.defaults!.beliefRankingWeight).toBe(0)
    const missing = await tryBuildMemoryDeps(cfg({ beliefRankingWeight: undefined }))
    expect(missing!.defaults!.beliefRankingWeight).toBe(0)
  })

  it("never builds a reranker (nor touches the utility model) when llmRerank is off", async () => {
    const deps = await tryBuildMemoryDeps(cfg({ llmRerank: false }))
    expect(deps!.rerank).toBeUndefined()
    expect(mockBuildUtilityLlmClient).not.toHaveBeenCalled()
    expect(mockGetSettings).not.toHaveBeenCalled()
    expect(mockCreateMemoryLlmReranker).not.toHaveBeenCalled()
  })

  it("attaches the utility-model reranker when llmRerank is on", async () => {
    const client = { complete: jest.fn() }
    const reranker = jest.fn()
    mockBuildUtilityLlmClient.mockReturnValue(client)
    mockCreateMemoryLlmReranker.mockReturnValue(reranker)
    const deps = await tryBuildMemoryDeps(cfg({ llmRerank: true }))
    expect(mockBuildUtilityLlmClient).toHaveBeenCalledWith({
      session: null,
      appSettings: { theme: "dark" },
      featureId: "memory-rerank",
    })
    expect(mockCreateMemoryLlmReranker).toHaveBeenCalledWith(client, {
      systemPrompt: expect.any(Function),
    })
    expect(deps!.rerank).toBe(reranker)
  })

  describe("reranker system prompt (Prompt Center)", () => {
    afterEach(() => {
      __setPromptOverrideSnapshotForTests(null)
      __resetPromptVerdictsForTests()
    })

    async function resolvedSystemPrompt(): Promise<string> {
      mockBuildUtilityLlmClient.mockReturnValue({ complete: jest.fn() })
      mockCreateMemoryLlmReranker.mockReturnValue(jest.fn())
      await tryBuildMemoryDeps(cfg({ llmRerank: true }))
      const options = mockCreateMemoryLlmReranker.mock.calls[0][1] as {
        systemPrompt: () => Promise<string>
      }
      return options.systemPrompt()
    }

    it("resolves the shipped prompt with no override", async () => {
      __setPromptOverrideSnapshotForTests(buildPromptOverrideSnapshot("test-db", []))
      await expect(resolvedSystemPrompt()).resolves.toBe(MEMORY_RERANK_SYSTEM_PROMPT)
    })

    it("resolves a published override at each recall", async () => {
      __setPromptOverrideSnapshotForTests(
        buildPromptOverrideSnapshot("test-db", [
          {
            bindingId: "pob-rerank",
            promptId: MEMORY_RERANK_PROMPT.id,
            scope: "account",
            targetId: "",
            revisionId: "por-mem-rerank-1",
            body: "Score memories against the query. Return STRICT JSON only.",
            contractVersion: MEMORY_RERANK_PROMPT.contractVersion,
          },
        ])
      )
      await expect(resolvedSystemPrompt()).resolves.toBe(
        "Score memories against the query. Return STRICT JSON only."
      )
    })
  })

  it("leaves rerank unset when no utility model is configured", async () => {
    mockBuildUtilityLlmClient.mockReturnValue(null)
    const deps = await tryBuildMemoryDeps(cfg({ llmRerank: true }))
    expect(deps!.rerank).toBeUndefined()
    expect(mockCreateMemoryLlmReranker).not.toHaveBeenCalled()
    // The config default still says rerank; only the capability is missing.
    expect(deps!.defaults!.rerank).toBe(true)
  })

  it("passes null app settings when reading settings fails", async () => {
    mockGetSettings.mockRejectedValue(new Error("db closed"))
    const deps = await tryBuildMemoryDeps(cfg({ llmRerank: true }))
    expect(mockBuildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ appSettings: null, featureId: "memory-rerank" })
    )
    expect(deps!.rerank).toBeDefined()
  })

  it("keeps building deps when the reranker construction throws", async () => {
    mockBuildUtilityLlmClient.mockImplementation(() => {
      throw new Error("bad provider")
    })
    const deps = await tryBuildMemoryDeps(cfg({ llmRerank: true }))
    expect(deps).toBeDefined()
    expect(deps!.rerank).toBeUndefined()
  })
})

describe("tryBuildMemoryVectorReader", () => {
  const localEmbedding = { provider: "transformersjs", model: "x", apiKey: "" }

  it("returns undefined when memory is disabled or temporary, without touching the backend", async () => {
    expect(await tryBuildMemoryVectorReader(cfg({ enabled: false }))).toBeUndefined()
    expect(await tryBuildMemoryVectorReader(cfg({ temporary: true }))).toBeUndefined()
    expect(mockTryBuildTwinDeps).not.toHaveBeenCalled()
  })

  it("returns undefined when the privacy/capability gate yields no backend", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    expect(await tryBuildMemoryVectorReader(cfg())).toBeUndefined()

    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments: jest.fn() },
      embedding: localEmbedding,
    })
    expect(await tryBuildMemoryVectorReader(cfg({ hybridEnabled: false }))).toBeUndefined()

    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments: jest.fn() },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    expect(await tryBuildMemoryVectorReader(cfg({ allowCloudEmbedding: false }))).toBeUndefined()
    expect(await tryBuildMemoryVectorReader(cfg({ allowCloudEmbedding: true }))).toBeDefined()
  })

  it("returns undefined when the store cannot read documents", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: localEmbedding,
    })
    expect(await tryBuildMemoryVectorReader(cfg())).toBeUndefined()
  })

  it("returns undefined when building the backend throws", async () => {
    mockTryBuildTwinDeps.mockRejectedValue(new Error("boom"))
    expect(await tryBuildMemoryVectorReader(cfg())).toBeUndefined()
  })

  it("maps vector doc ids back to memory ids and skips memories without a vector", async () => {
    const getDocuments = jest.fn(async () => [
      { id: "doc-a", embedding: [1, 0] },
      { id: "doc-b", embedding: [0, 1] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: localEmbedding,
    })
    const reader = await tryBuildMemoryVectorReader(cfg())
    const out = await reader!.getEmbeddings([
      { id: "mem-a", vectorDocId: "doc-a" },
      { id: "mem-b", vectorDocId: "doc-b" },
      { id: "mem-none" },
    ])
    expect(getDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, ["doc-a", "doc-b"])
    expect(out).toEqual(
      new Map([
        ["mem-a", [1, 0]],
        ["mem-b", [0, 1]],
      ])
    )
    expect(mockSearchByEmbedding).not.toHaveBeenCalled()
  })

  it("does not query the store when no memory has a vector", async () => {
    const getDocuments = jest.fn()
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: localEmbedding,
    })
    const reader = await tryBuildMemoryVectorReader(cfg())
    await expect(reader!.getEmbeddings([{ id: "m1" }])).resolves.toEqual(new Map())
    expect(getDocuments).not.toHaveBeenCalled()
  })

  it("drops unexpected ids, missing / empty / non-finite vectors and mismatched dimensions", async () => {
    const getDocuments = jest.fn(async () => [
      { id: "doc-stranger", embedding: [1, 0] },
      { id: "doc-missing" },
      { id: "doc-empty", embedding: [] },
      { id: "doc-nan", embedding: [NaN, 1] },
      { id: "doc-inf", embedding: [Infinity, 0] },
      { id: "doc-ok", embedding: [0.5, 0.5] },
      { id: "doc-3d", embedding: [1, 0, 0] },
      { id: "doc-ok2", embedding: [0.1, 0.9] },
    ])
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: localEmbedding,
    })
    const reader = await tryBuildMemoryVectorReader(cfg())
    const ids = ["missing", "empty", "nan", "inf", "ok", "3d", "ok2"]
    const out = await reader!.getEmbeddings(ids.map((id) => ({ id, vectorDocId: `doc-${id}` })))
    expect([...out.keys()]).toEqual(["ok", "ok2"])
    expect(out.get("ok")).toEqual([0.5, 0.5])
  })

  it("reads in bounded batches and keeps the dimension fixed across batches", async () => {
    const memories = Array.from({ length: 600 }, (_, index) => ({
      id: `mem-${index}`,
      vectorDocId: `doc-${index}`,
    }))
    const getDocuments = jest.fn(async (_collection: string, batch: string[]) => {
      expect(batch.length).toBeLessThanOrEqual(256)
      return batch.map((id) => ({
        id,
        // The last doc (third batch) has a different dimension than the first.
        embedding: id === "doc-599" ? [1, 0, 0] : [1, 0],
      }))
    })
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, getDocuments },
      embedding: localEmbedding,
    })
    const reader = await tryBuildMemoryVectorReader(cfg())
    const out = await reader!.getEmbeddings(memories)
    expect(getDocuments).toHaveBeenCalledTimes(3)
    expect(getDocuments.mock.calls.flatMap(([, batch]) => batch)).toEqual(
      memories.map((m) => m.vectorDocId)
    )
    expect(out.size).toBe(599)
    expect(out.has("mem-599")).toBe(false)
  })
})

describe("tryBuildMemoryVectorSink", () => {
  it.each([{ enabled: false }, { temporary: true }])(
    "permits deletion but refuses embedding in cleanup-only mode: %j",
    async (gate) => {
      const addDocuments = jest.fn(async () => undefined)
      const deleteDocuments = jest.fn(async () => undefined)
      mockTryBuildTwinDeps.mockResolvedValue({
        store: { searchByEmbedding: mockSearchByEmbedding, addDocuments, deleteDocuments },
        embedding: { provider: "transformersjs", model: "x", apiKey: "" },
      })
      const sink = await tryBuildMemoryVectorSink(cfg(gate), { cleanupOnly: true })
      await sink!.delete(["deleted"])
      expect(deleteDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, ["deleted"])
      await expect(sink!.upsert("live", "safe text")).rejects.toThrow("memory_vector_cleanup_only")
      expect(addDocuments).not.toHaveBeenCalled()
    }
  )
  it("blocks unsafe content at the sink before provider embedding or persistence", async () => {
    const addDocuments = jest.fn(async () => undefined)
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    const sink = await tryBuildMemoryVectorSink(cfg({ allowCloudEmbedding: true }))
    await expect(sink!.upsert("m1", "Email bob@example.com")).rejects.toThrow(
      "memory_vector_pii_blocked"
    )
    expect(addDocuments).not.toHaveBeenCalled()
  })

  it("returns undefined when memory is disabled", async () => {
    expect(await tryBuildMemoryVectorSink(cfg({ enabled: false }))).toBeUndefined()
  })

  it("returns undefined when there is no embedding backend", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    expect(await tryBuildMemoryVectorSink(cfg())).toBeUndefined()
  })

  it("returns undefined when the store cannot add documents", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding }, // no addDocuments
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    expect(await tryBuildMemoryVectorSink(cfg())).toBeUndefined()
  })

  it("upserts a memory's text into the collection when a backend is available", async () => {
    const addDocuments = jest.fn(async () => undefined)
    const deleteDocuments = jest.fn(async () => undefined)
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments, deleteDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const sink = await tryBuildMemoryVectorSink(cfg())
    expect(sink).toBeDefined()
    await sink!.upsert("m1", "The user prefers pnpm")
    expect(addDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, [
      { id: "m1", content: "The user prefers pnpm" },
    ])
    await sink!.delete(["m1"])
    expect(deleteDocuments).toHaveBeenCalledWith(MEMORY_VECTOR_COLLECTION, ["m1"])
  })

  it("exposes listIds paging over scrollDocuments, absent otherwise", async () => {
    const addDocuments = jest.fn(async () => undefined)
    // No scrollDocuments → no listIds (reconcile degrades to heal-only).
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    expect((await tryBuildMemoryVectorSink(cfg()))!.listIds).toBeUndefined()

    // With scrollDocuments → pages until hasMore is false.
    const scrollDocuments = jest
      .fn()
      .mockResolvedValueOnce({ documents: [{ id: "a" }, { id: "b" }], hasMore: true })
      .mockResolvedValueOnce({ documents: [{ id: "c" }], hasMore: false })
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments, scrollDocuments },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    const sink = await tryBuildMemoryVectorSink(cfg())
    await expect(sink!.listIds!()).resolves.toEqual(["a", "b", "c"])
    expect(scrollDocuments).toHaveBeenNthCalledWith(1, MEMORY_VECTOR_COLLECTION, {
      offset: 0,
      limit: 500,
    })
    expect(scrollDocuments).toHaveBeenNthCalledWith(2, MEMORY_VECTOR_COLLECTION, {
      offset: 2,
      limit: 500,
    })
  })

  it("returns undefined when hybridEnabled is off", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments: jest.fn() },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    expect(await tryBuildMemoryVectorSink(cfg({ hybridEnabled: false }))).toBeUndefined()
  })

  it("respects the cloud-embedding privacy gate", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding, addDocuments: jest.fn() },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    expect(await tryBuildMemoryVectorSink(cfg({ allowCloudEmbedding: false }))).toBeUndefined()
    expect(await tryBuildMemoryVectorSink(cfg({ allowCloudEmbedding: true }))).toBeDefined()
  })
})

describe("describeMemoryRetrievalMode", () => {
  it("reports `off` rather than a degradation when memory is not running", async () => {
    await expect(describeMemoryRetrievalMode(cfg({ enabled: false }))).resolves.toEqual({
      kind: "off",
      reason: "disabled",
    })
    await expect(describeMemoryRetrievalMode(cfg({ temporary: true }))).resolves.toEqual({
      kind: "off",
      reason: "temporary",
    })
    expect(mockTryBuildTwinDeps).not.toHaveBeenCalled()
  })

  it("reports hybrid_disabled without even consulting the backend", async () => {
    await expect(describeMemoryRetrievalMode(cfg({ hybridEnabled: false }))).resolves.toEqual({
      kind: "bm25",
      reason: "hybrid_disabled",
    })
    expect(mockTryBuildTwinDeps).not.toHaveBeenCalled()
  })

  it("reports no_backend when twin embeddings were never configured", async () => {
    mockTryBuildTwinDeps.mockResolvedValue(undefined)
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "no_backend",
    })
  })

  it("reports store_unsupported when the vector store cannot search by embedding", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: {},
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "store_unsupported",
      provider: "transformersjs",
    })
  })

  it("reports cloud_blocked — the default state for a cloud embedder", async () => {
    // hybridEnabled defaults to true and allowCloudEmbedding defaults to false,
    // so anyone whose twin embedder is cloud-hosted silently gets keyword-only
    // recall while the config claims hybrid. This is the case the alert exists for.
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "openai", model: "x", apiKey: "k" },
    })
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "cloud_blocked",
      provider: "openai",
    })
  })

  it("reports hybrid once every gate passes", async () => {
    mockTryBuildTwinDeps.mockResolvedValue({
      store: { searchByEmbedding: mockSearchByEmbedding },
      embedding: { provider: "transformersjs", model: "x", apiKey: "" },
    })
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "hybrid",
      provider: "transformersjs",
    })
  })

  it("never throws — a backend explosion reads as no_backend", async () => {
    mockTryBuildTwinDeps.mockRejectedValue(new Error("boom"))
    await expect(describeMemoryRetrievalMode(cfg())).resolves.toEqual({
      kind: "bm25",
      reason: "no_backend",
    })
  })

  it("agrees with tryBuildMemoryDeps about whether the vector leg attached", async () => {
    // The probe and the runtime share `resolveMemoryBackendOutcome`; this pins
    // that they can never disagree about a given configuration.
    for (const embedding of [
      { provider: "transformersjs", model: "x", apiKey: "" },
      { provider: "openai", model: "x", apiKey: "k" },
    ]) {
      mockTryBuildTwinDeps.mockResolvedValue({
        store: { searchByEmbedding: mockSearchByEmbedding },
        embedding,
      })
      const config = cfg()
      const mode = await describeMemoryRetrievalMode(config)
      const deps = await tryBuildMemoryDeps(config)
      expect(mode.kind === "hybrid").toBe(deps?.vectorSearch !== undefined)
    }
  })
})
