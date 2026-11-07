import type { ContextContribution, ContextTurnContext } from "@/lib/modules/manifest-types"

const mockApply = jest.fn()
jest.mock("./runtime/apply-project-context", () => ({
  applyProjectKnowledgeContext: (input: unknown) => mockApply(input),
}))

import { contributions } from "./context"

const retrieval = contributions.find((c) => c.id === "retrieval") as ContextContribution

const file = (id: string, name: string) => ({ id, name }) as never
function turn(fields: Partial<ContextTurnContext> = {}): ContextTurnContext {
  return {
    session: null,
    agent: null,
    settings: null,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: {
      id: "ws1",
      knowledgeBase: [file("f1", "guide.md"), file("f2", "notes.md")],
    } as unknown as ContextTurnContext["activeProject"],
    query: { text: "how do we release?", embedding: [0.25] },
    hostDeps: { projectKnowledge: { vectorBackend: "native" } as never },
    grant: null,
    kernelRetrieval: { twinChunkTexts: [] },
    ...fields,
  }
}

const result = {
  systemPromptSection: "## Project knowledge base\nexcerpt",
  retrievedChunks: [{ fileId: "f1", fileName: "guide.md", content: "excerpt", score: 0.8 }],
  degraded: false,
}

beforeEach(() => mockApply.mockReset())

it("is a turn section in the project-knowledge slot with a longer deadline", () => {
  expect(contributions.map((c) => c.id)).toEqual(["retrieval"])
  expect(retrieval).toMatchObject({ cache: "turn", slot: "project-knowledge", deadlineMs: 15_000 })
})

it("retrieves over the workspace's files and reports the excerpts", async () => {
  mockApply.mockResolvedValue(result)
  expect(await retrieval.produce(turn())).toEqual({
    text: result.systemPromptSection,
    sources: { retrievedChunks: result.retrievedChunks, degraded: false },
  })
  expect(mockApply).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "ws1",
      userMessage: "how do we release?",
      topK: 5,
      strategy: "vector",
      fileIds: ["f1", "f2"],
      fileNames: { f1: "guide.md", f2: "notes.md" },
      precomputedQueryEmbedding: [0.25],
    })
  )
})

it("reports a degraded retrieval without text, and nothing for an empty one", async () => {
  mockApply.mockResolvedValue({ systemPromptSection: null, retrievedChunks: [], degraded: true })
  expect(await retrieval.produce(turn())).toEqual({
    text: "",
    sources: { retrievedChunks: [], degraded: true },
  })
  mockApply.mockResolvedValue({ systemPromptSection: null, retrievedChunks: [], degraded: false })
  expect(await retrieval.produce(turn())).toEqual({ text: "" })
})

it("skips without a workspace, files, query, project RAG, or a vector runtime for vector retrieval", async () => {
  expect(await retrieval.produce(turn({ activeProject: null }))).toBeNull()
  expect(
    await retrieval.produce(turn({ activeProject: { id: "ws1", knowledgeBase: [] } as never }))
  ).toBeNull()
  expect(await retrieval.produce(turn({ query: { text: "  ", embedding: null } }))).toBeNull()
  expect(
    await retrieval.produce(
      turn({
        activeProject: {
          id: "ws1",
          knowledgeBase: [file("f1", "guide.md")],
          knowledgeSettings: { enableProjectRag: false },
        } as never,
      })
    )
  ).toBeNull()
  expect(await retrieval.produce(turn({ hostDeps: {} }))).toBeNull()
  expect(mockApply).not.toHaveBeenCalled()
  mockApply.mockResolvedValue(result)
  expect(
    await retrieval.produce(
      turn({
        hostDeps: {},
        activeProject: {
          id: "ws1",
          knowledgeBase: [file("f1", "guide.md")],
          knowledgeSettings: { retrievalStrategy: "keyword" },
        } as never,
      })
    )
  ).not.toBeNull()
})

it("keeps a chunk only when neither its text nor its file name leaks PII", async () => {
  mockApply.mockResolvedValue(result)
  await retrieval.produce(turn())
  const { keepChunk } = mockApply.mock.calls[0][0]
  expect(
    keepChunk({ fileId: "f1", fileName: "guide.md", content: "Tag then push.", score: 1 })
  ).toBe(true)
  expect(
    keepChunk({ fileId: "f1", fileName: "guide.md", content: "Ask jane.doe@example.com", score: 1 })
  ).toBe(false)
  expect(
    keepChunk({
      fileId: "f1",
      fileName: "jane.doe@example.com",
      content: "Tag then push.",
      score: 1,
    })
  ).toBe(false)
})
