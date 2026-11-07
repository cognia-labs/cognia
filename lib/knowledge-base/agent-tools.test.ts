import { buildTextDocumentStructure } from "@cognia/document/document-structure"
import { __resetContextSessionStateForTests } from "@/lib/claude/context-session-state"
import type { ToolSurfaceContext } from "@/lib/modules/manifest-types"
import { createKnowledgeReader } from "./runtime/progressive-reading"
import { captureKnowledgeSessionState } from "./runtime/session-reader"
import {
  KNOWLEDGE_TOOL_INSTRUCTIONS,
  KNOWLEDGE_TOOL_NAMES,
  knowledgeToolEntries,
  runKnowledgeTool,
  toolFamily,
} from "./agent-tools"

afterEach(() => __resetContextSessionStateForTests())

const text = "# Test\nOriginal code"
const source = { id: "s", knowledgeBaseId: "kb", title: "Test", format: "markdown" } as never
const reader = () =>
  createKnowledgeReader({
    knowledgeBaseIds: ["kb"],
    settings: { enabled: true, totalReadChars: 8 },
    deps: {
      listSources: async () => [source],
      getSources: async () => [source],
      getSnapshot: async () => ({
        generationId: "g",
        contentHash: "hash",
        originalText: text,
        title: "Test",
        format: "markdown",
        createdAt: 1,
        structure: buildTextDocumentStructure(text),
      }),
    },
  })
const stateWith = (withReader: boolean) =>
  captureKnowledgeSessionState({
    knowledgeBaseIds: ["kb"],
    ...(withReader ? { reader: reader() } : {}),
  })

describe("entries", () => {
  it("offers every tool name, each with a closed object schema", () => {
    expect(knowledgeToolEntries().map((tool) => tool.name)).toEqual([...KNOWLEDGE_TOOL_NAMES])
    for (const tool of knowledgeToolEntries())
      expect(tool.jsonSchema).toMatchObject({ type: "object", additionalProperties: false })
  })
})

describe("surface", () => {
  const surfaceWith = (state: unknown) =>
    toolFamily.surface({
      sessionState: (id: string) => (id === "reader" ? state : undefined),
    } as unknown as ToolSurfaceContext)

  it("offers the tools and the reading guidance only while the run has a reader", async () => {
    expect(await surfaceWith(stateWith(true))).toEqual({
      tools: knowledgeToolEntries(),
      instructions: KNOWLEDGE_TOOL_INSTRUCTIONS,
    })
    expect(await surfaceWith(stateWith(false))).toBeNull()
    expect(await surfaceWith(undefined)).toBeNull()
  })

  it("offers nothing once the capture has gone stale", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(0)
    const state = stateWith(true)
    now.mockReturnValue(3_600_001)
    expect(await surfaceWith(state)).toBeNull()
    now.mockRestore()
  })
})

describe("run", () => {
  const callWith = (state: unknown, signal?: AbortSignal) => ({
    sessionState: (id: string) => (id === "reader" ? state : undefined),
    ...(signal ? { signal } : {}),
  })

  it("refuses unbound or invalid requests", async () => {
    expect(
      await runKnowledgeTool(
        "knowledge_read_original",
        { knowledgeBaseId: "kb", sourceId: "s" },
        callWith(undefined)
      )
    ).toEqual({ ok: false, code: "knowledge_scope_unavailable" })
    expect(
      await runKnowledgeTool(
        "knowledge_list_documents",
        { knowledgeBaseIds: ["other"] },
        callWith(stateWith(true))
      )
    ).toEqual({ ok: false, code: "invalid_arguments" })
    expect(
      await runKnowledgeTool(
        "knowledge_read_outline",
        { knowledgeBaseId: "kb" },
        callWith(stateWith(true))
      )
    ).toEqual({ ok: false, code: "invalid_arguments" })
    expect(await runKnowledgeTool("knowledge_write", {}, callWith(stateWith(true)))).toEqual({
      ok: false,
      code: "invalid_arguments",
    })
  })

  it("reads originals through the conversation's reader, keeping locators and cumulative budgets", async () => {
    const state = stateWith(true)
    expect(
      await toolFamily.run(
        "knowledge_read_original",
        { knowledgeBaseId: "kb", sourceId: "s" },
        callWith(state) as never
      )
    ).toMatchObject({
      ok: true,
      text: text.slice(0, 8),
      charStart: 0,
      charEnd: 8,
      generationId: "g",
    })
    expect(
      await runKnowledgeTool(
        "knowledge_read_original",
        { knowledgeBaseId: "kb", sourceId: "s" },
        callWith(state)
      )
    ).toMatchObject({ ok: false, code: "read_budget_exhausted" })
  })

  it("lists documents and reports an aborted call", async () => {
    expect(
      await runKnowledgeTool("knowledge_list_documents", {}, callWith(stateWith(true)))
    ).toMatchObject({ ok: true })
    const controller = new AbortController()
    controller.abort()
    expect(
      await runKnowledgeTool(
        "knowledge_list_documents",
        {},
        callWith(stateWith(true), controller.signal)
      )
    ).toEqual({ ok: false, code: "aborted" })
  })
})
