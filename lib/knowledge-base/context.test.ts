import type { ContextContribution, ContextTurnContext } from "@/lib/modules/manifest-types"
import type { KnowledgeBaseChunk, KnowledgeBaseSource } from "@/types/knowledge-base"

const mockApply = jest.fn()
jest.mock("./runtime/apply-agent-knowledge-context", () => ({
  applyAgentKnowledgeContextFromDb: (input: unknown) => mockApply(input),
}))
const mockRetrieve = jest.fn()
jest.mock("./runtime/retrieve", () => ({
  retrieveKnowledgeBaseChunks: (input: unknown) => mockRetrieve(input),
}))
const mockSources = new Map<string, KnowledgeBaseSource>()
jest.mock("@/lib/db/knowledge-bases", () => ({
  listKnowledgeBaseSources: jest.fn(async () => [...mockSources.values()]),
  getKnowledgeBaseSourcesByIds: jest.fn(async (ids: string[]) =>
    ids.map((id) => mockSources.get(id)).filter(Boolean)
  ),
  getKnowledgeBaseDocumentSnapshot: jest.fn(async () => undefined),
}))

import { contributions } from "./context"
import type { KnowledgeSessionState } from "./runtime/session-reader"

const byId = (id: string) => contributions.find((c) => c.id === id) as ContextContribution

function source(id: string, fields: Partial<KnowledgeBaseSource> = {}): KnowledgeBaseSource {
  return { id, knowledgeBaseId: "kb", title: `Doc ${id}`, ...fields } as KnowledgeBaseSource
}
function chunk(sourceId: string, content: string): KnowledgeBaseChunk {
  return { id: `c-${sourceId}`, knowledgeBaseId: "kb", sourceId, content } as KnowledgeBaseChunk
}

function turn(fields: Partial<ContextTurnContext> = {}): ContextTurnContext {
  return {
    session: { id: "s1" } as ContextTurnContext["session"],
    agent: { knowledgeBaseIds: ["kb", "kb2"] } as ContextTurnContext["agent"],
    settings: null,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
    query: { text: "how do refunds work?", embedding: [0.5, 0.25] },
    hostDeps: { projectKnowledge: { vectorBackend: "native" } as never },
    grant: null,
    kernelRetrieval: { twinChunkTexts: [] },
    ...fields,
  }
}

beforeEach(() => {
  mockApply.mockReset()
  mockRetrieve.mockReset()
  mockSources.clear()
})

describe("reader", () => {
  it("captures the bases within the grant and the ceiling, and no reader while reading is off", async () => {
    const section = await byId("reader").produce(
      turn({
        grant: { schemaVersion: 1, knowledgeBases: { add: ["kb3"], remove: ["kb2"] } } as never,
        hostDeps: { knowledgeAccess: { allowedKnowledgeBaseIds: ["kb", "kb3"] } },
      })
    )
    const state = section!.sessionState as KnowledgeSessionState
    expect(section!.text).toBe("")
    expect(state.knowledgeBaseIds).toEqual(["kb", "kb3"])
    expect(state.knowledgeAccess).toEqual({ allowedKnowledgeBaseIds: ["kb", "kb3"] })
    expect(state.reader).toBeUndefined()
  })

  it("answers even for an agent without bases, so a wider capture is replaced", async () => {
    const section = await byId("reader").produce(turn({ agent: null }))
    expect((section!.sessionState as KnowledgeSessionState).knowledgeBaseIds).toEqual([])
  })

  it("builds a reader whose candidates pass the document authorization", async () => {
    mockSources.set("pub", source("pub"))
    mockSources.set("other", source("other", { knowledgeBaseId: "elsewhere" }))
    mockRetrieve.mockImplementation(
      async (input: { authorizeChunk: (c: KnowledgeBaseChunk) => Promise<boolean> }) => {
        const kept = []
        for (const candidate of [chunk("pub", "a"), chunk("other", "b")])
          if (await input.authorizeChunk(candidate)) kept.push({ chunk: candidate, score: 1 })
        return { chunks: kept }
      }
    )
    const section = await byId("reader").produce(
      turn({
        agent: { knowledgeBaseIds: ["kb"], knowledgeReading: { enabled: true } } as never,
      })
    )
    const state = section!.sessionState as KnowledgeSessionState
    expect(state.reader?.settings.enabled).toBe(true)
    const listed = await state.reader!.listDocuments({ query: "refunds" })
    expect(mockRetrieve).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseId: "kb", userMessage: "refunds" })
    )
    expect(listed).toBeDefined()
  })
})

describe("retrieval", () => {
  const result = {
    systemPromptSection: "## Agent knowledge\n\nRefunds take 5 days.",
    retrievedChunks: [{ chunk: chunk("a", "Refunds take 5 days."), score: 0.9 }],
    citations: [],
    failures: [],
    budget: { limit: 2_000, used: 6, truncated: false },
    degraded: false,
  }

  it("is a turn section in the agent-knowledge slot with a longer deadline", () => {
    expect(byId("retrieval")).toMatchObject({
      cache: "turn",
      slot: "agent-knowledge",
      deadlineMs: 15_000,
    })
  })

  it("returns the section and reports its chunks for the UI", async () => {
    mockApply.mockResolvedValue(result)
    const section = await byId("retrieval").produce(turn())
    expect(section).toEqual({
      text: result.systemPromptSection,
      sources: {
        retrievedChunks: result.retrievedChunks,
        citations: [],
        failures: [],
        budget: result.budget,
        degraded: false,
      },
    })
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseIds: ["kb", "kb2"],
        userMessage: "how do refunds work?",
        topKPerBase: 5,
        tokenBudget: 2_000,
        retrievalStrategy: "vector",
        precomputedQueryEmbedding: [0.5, 0.25],
      })
    )
  })

  it("reports nothing beside a section with no chunks and no degradation", async () => {
    mockApply.mockResolvedValue({ ...result, systemPromptSection: null, retrievedChunks: [] })
    expect(await byId("retrieval").produce(turn())).toEqual({ text: "" })
  })

  it("skips without bases, a query, or a vector runtime for vector retrieval", async () => {
    expect(await byId("retrieval").produce(turn({ agent: null }))).toBeNull()
    expect(
      await byId("retrieval").produce(turn({ query: { text: "  ", embedding: null } }))
    ).toBeNull()
    expect(await byId("retrieval").produce(turn({ hostDeps: {} }))).toBeNull()
    mockApply.mockResolvedValue(result)
    expect(
      await byId("retrieval").produce(
        turn({
          hostDeps: {},
          agent: {
            knowledgeBaseIds: ["kb"],
            knowledgeReading: { retrievalStrategy: "keyword" },
          } as never,
        })
      )
    ).not.toBeNull()
  })

  it("leaves out a chunk whose text or document title leaks PII, and unauthorized documents", async () => {
    mockApply.mockResolvedValue(result)
    await byId("retrieval").produce(turn())
    const { authorizeChunk } = mockApply.mock.calls[0][0] as {
      authorizeChunk: (input: {
        chunk: KnowledgeBaseChunk
        source?: KnowledgeBaseSource
      }) => boolean
    }
    expect(authorizeChunk({ chunk: chunk("a", "Refunds take 5 days."), source: source("a") })).toBe(
      true
    )
    expect(
      authorizeChunk({ chunk: chunk("a", "Mail jane.doe@example.com"), source: source("a") })
    ).toBe(false)
    expect(
      authorizeChunk({
        chunk: chunk("a", "Refunds take 5 days."),
        source: source("a", { title: "jane.doe@example.com notes" }),
      })
    ).toBe(false)
    expect(authorizeChunk({ chunk: chunk("a", "Refunds"), source: undefined })).toBe(false)
    expect(
      authorizeChunk({
        chunk: chunk("a", "Refunds"),
        source: source("a", { knowledgeBaseId: "unbound" }),
      })
    ).toBe(false)
  })

  it("applies public entrypoint document ACLs from the caller's ceiling", async () => {
    mockApply.mockResolvedValue(result)
    await byId("retrieval").produce(
      turn({
        hostDeps: {
          projectKnowledge: { vectorBackend: "native" } as never,
          knowledgeAccess: { entrypoint: "http" },
        },
      })
    )
    const { authorizeChunk } = mockApply.mock.calls[0][0] as {
      authorizeChunk: (input: {
        chunk: KnowledgeBaseChunk
        source?: KnowledgeBaseSource
      }) => boolean
    }
    expect(authorizeChunk({ chunk: chunk("a", "Refunds"), source: source("a") })).toBe(false)
    expect(
      authorizeChunk({
        chunk: chunk("a", "Refunds"),
        source: source("a", { acl: { visibility: "public" } } as Partial<KnowledgeBaseSource>),
      })
    ).toBe(true)
  })
})
