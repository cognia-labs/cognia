jest.mock("./retrieve", () => ({
  retrieveProjectChunks: jest.fn(),
}))

import { applyProjectKnowledgeContext } from "./apply-project-context"
import { retrieveProjectChunks } from "./retrieve"
import type { ProjectKnowledgeRuntimeDeps } from "./retrieve"

const retrieveMock = retrieveProjectChunks as jest.Mock

const deps = {} as ProjectKnowledgeRuntimeDeps

function hit(fileId: string, content: string, score = 1, n = 0) {
  return {
    chunk: {
      id: `${fileId}-c${n}`,
      projectId: "p",
      fileId,
      content,
      vectorDocId: `${fileId}-${n}`,
      generationId: `${fileId}-g1`,
      contentHash: `${fileId}-h`,
      charStart: n * 100,
      charEnd: n * 100 + content.length,
    },
    score,
  }
}

beforeEach(() => retrieveMock.mockReset())

describe("applyProjectKnowledgeContext", () => {
  it("passes host-selected candidate strategy and current file scope to retrieval", async () => {
    retrieveMock.mockResolvedValue({ chunks: [], degraded: false })
    await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 3,
      strategy: "hybrid",
      fileIds: ["f1"],
      deps,
    })
    expect(retrieveMock).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "hybrid", fileIds: ["f1"] })
    )
  })

  it("returns empty (no retrieve) for a blank message", async () => {
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "  ",
      topK: 5,
      deps,
    })
    expect(res.systemPromptSection).toBeNull()
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it("returns empty (no retrieve) for topK<=0", async () => {
    await applyProjectKnowledgeContext({ projectId: "p", userMessage: "q", topK: 0, deps })
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it("assembles a section with file-name citations", async () => {
    retrieveMock.mockResolvedValue({
      chunks: [hit("f1", "alpha body"), hit("f2", "beta body")],
      degraded: false,
    })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      fileNames: { f1: "guide.md", f2: "spec.md" },
      deps,
    })
    expect(res.systemPromptSection).toContain("## Project knowledge base")
    expect(res.systemPromptSection).toContain("[guide.md, characters 0–10]")
    expect(res.systemPromptSection).toContain("alpha body")
    expect(res.systemPromptSection).toContain("[spec.md, characters 0–9]")
    expect(res.retrievedChunks).toHaveLength(2)
    expect(res.retrievedChunks[0].fileName).toBe("guide.md")
  })

  it("reports each excerpt's chunk, generation, hash and range, and tells same-named files apart", async () => {
    retrieveMock.mockResolvedValue({
      chunks: [hit("f1", "first", 0.9, 0), hit("f1", "second", 0.8, 1), hit("f2", "other", 0.7)],
      degraded: false,
    })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      fileNames: { f1: "notes.md", f2: "notes.md" },
      deps,
    })
    expect(
      res.retrievedChunks.map((c) => [c.chunkId, c.generationId, c.charStart, c.charEnd])
    ).toEqual([
      ["f1-c0", "f1-g1", 0, 5],
      ["f1-c1", "f1-g1", 100, 106],
      ["f2-c0", "f2-g1", 0, 5],
    ])
    expect(res.retrievedChunks[0]).toMatchObject({ projectId: "p", contentHash: "f1-h" })
    expect(res.systemPromptSection).toContain("[notes.md (file f1), characters 100–106]")
    expect(res.systemPromptSection).toContain("[notes.md (file f2), characters 0–5]")
  })

  it("leaves out the chunks keepChunk rejects, from the section and the reported chunks", async () => {
    retrieveMock.mockResolvedValue({
      chunks: [hit("f1", "kept text"), hit("f2", "dropped text")],
      degraded: false,
    })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      fileNames: { f1: "a.md", f2: "b.md" },
      keepChunk: (chunk) => chunk.fileId !== "f2",
      deps,
    })
    expect(res.retrievedChunks.map((c) => c.fileId)).toEqual(["f1"])
    expect(res.systemPromptSection).toContain("kept text")
    expect(res.systemPromptSection).not.toContain("dropped text")
  })

  it("falls back to a file-id label when the name is unknown", async () => {
    retrieveMock.mockResolvedValue({ chunks: [hit("f9", "x")], degraded: false })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      deps,
    })
    expect(res.systemPromptSection).toContain("[file f9, characters 0–1]")
  })

  it("returns null section but passes degraded through when nothing retrieved", async () => {
    retrieveMock.mockResolvedValue({ chunks: [], degraded: true })
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      deps,
    })
    expect(res.systemPromptSection).toBeNull()
    expect(res.degraded).toBe(true)
  })

  it("never throws — degrades when retrieve rejects", async () => {
    retrieveMock.mockRejectedValue(new Error("boom"))
    const res = await applyProjectKnowledgeContext({
      projectId: "p",
      userMessage: "q",
      topK: 5,
      deps,
    })
    expect(res).toEqual({ systemPromptSection: null, retrievedChunks: [], degraded: true })
  })
})
