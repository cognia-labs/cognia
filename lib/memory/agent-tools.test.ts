import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import type { ProjectHistoryToolDeps } from "./project-history-tool"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { bindPersonalMessageRun } from "@/lib/execution/personal-marks"
import { commitMessageDelta, listMessages } from "@/lib/db/messages"

jest.mock("@/lib/chat/search/engine", () => ({ searchChatHistory: jest.fn() }))
jest.mock("@/lib/chat/search/indexer", () => ({
  drainSearchIndex: jest.fn(async () => undefined),
  markSessionDirty: jest.fn(),
}))
jest.mock("@/lib/db/chat-result-index", () => ({ searchChatResults: jest.fn(async () => []) }))
import { searchChatHistory } from "@/lib/chat/search/engine"
import { searchChatResults } from "@/lib/db/chat-result-index"

const mockRecordEvidence = jest.fn()
jest.mock("@/lib/chat/history-evidence-registry", () => ({
  recordProjectHistoryEvidence: (sessionId: string, evidence: unknown) =>
    mockRecordEvidence(sessionId, evidence),
}))

import { __setProjectHistoryToolDepsForTesting, toolFamily } from "./agent-tools"

const on = {
  memory: { enableProjectContinuity: true },
} as unknown as ToolSurfaceContext["settings"]

function surfaceCtx(fields: Partial<ToolSurfaceContext> = {}): ToolSurfaceContext {
  return {
    session: { id: "s1", projectId: "ws1" } as ToolSurfaceContext["session"],
    agent: null,
    settings: on,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
    ...fields,
  }
}

const call: ToolCallContext = {
  sessionId: "s1",
  toolUseId: "tu-1",
  executionRunId: "run-1",
  outboundAuthorization: { kind: "tool-call", sessionId: "s1", toolUseId: "tu-1" },
}

function makeDeps(overrides: Partial<ProjectHistoryToolDeps> = {}): ProjectHistoryToolDeps {
  return {
    resolveProjectId: async () => "ws1",
    drainIndex: async () => {},
    searchMessages: async () => ({ results: [], moreOlderHistory: false, indexIncomplete: false }),
    searchResults: async () => [],
    getSessions: async () => [],
    locateMessage: async () => null,
    canReadMessage: async () => true,
    readSessionTitle: async () => "Conversation",
    buildWindow: async () => null,
    now: () => 0,
    ...overrides,
  }
}

afterEach(() => {
  __setProjectHistoryToolDepsForTesting(null)
  mockRecordEvidence.mockReset()
})

describe("surface", () => {
  it("offers project_history_search to a workspace chat with project continuity on", async () => {
    const surface = await toolFamily.surface(surfaceCtx())
    expect(surface?.tools.map((tool) => tool.name)).toEqual(["project_history_search"])
  })

  it("takes the run's workspace when the session names none", async () => {
    const surface = await toolFamily.surface(
      surfaceCtx({
        session: { id: "s1" } as ToolSurfaceContext["session"],
        activeProject: { id: "ws2" } as ToolSurfaceContext["activeProject"],
      })
    )
    expect(surface?.tools).toHaveLength(1)
  })

  it("offers nothing while continuity is off, in a temporary chat, or without a session or workspace", async () => {
    expect(await toolFamily.surface(surfaceCtx({ settings: null }))).toBeNull()
    expect(
      await toolFamily.surface(
        surfaceCtx({
          settings: {
            memory: { enableProjectContinuity: true, temporary: true },
          } as unknown as ToolSurfaceContext["settings"],
        })
      )
    ).toBeNull()
    expect(await toolFamily.surface(surfaceCtx({ session: null }))).toBeNull()
    expect(
      await toolFamily.surface(surfaceCtx({ session: { id: "s1" } as never, activeProject: null }))
    ).toBeNull()
  })
})

describe("run", () => {
  it("searches the calling conversation's workspace and records evidence under it", async () => {
    const resolveProjectId = jest.fn(async () => "ws1")
    __setProjectHistoryToolDepsForTesting(() => makeDeps({ resolveProjectId }))
    const result = await toolFamily.run("project_history_search", { queries: ["pnpm"] }, call)
    expect(resolveProjectId).toHaveBeenCalledWith("s1")
    expect(result).toMatchObject({ ok: true, coverage: "complete" })
    expect(mockRecordEvidence).toHaveBeenCalledWith("s1", [])
  })

  it("returns a refusal as a result", async () => {
    __setProjectHistoryToolDepsForTesting(() => makeDeps({ resolveProjectId: async () => null }))
    const result = await toolFamily.run("project_history_search", { queries: ["pnpm"] }, call)
    expect(result).toMatchObject({ ok: false, code: "no_workspace" })
  })
})

describe("personal recall consumption", () => {
  const fixture = createDbTestFixture()
  beforeAll(fixture.initialize)
  beforeEach(async () => {
    await fixture.restore()
    jest
      .mocked(searchChatHistory)
      .mockResolvedValue({ results: [], moreOlderHistory: false, indexIncomplete: false })
    jest.mocked(searchChatResults).mockResolvedValue([])
    await getDb().sessions.bulkPut([
      { id: "s1", projectId: "ws1", title: "Reader" },
      { id: "source", projectId: "ws1", title: "Source" },
    ] as never)
  })
  afterAll(fixture.dispose)
  const mark = {
    person: { kind: "local-person" as const },
    source: "memory-tool-source",
    markedAt: 1,
  }

  it.each(["messages", "results", "expand"] as const)(
    "marks returned %s provenance before the tool result and assistant reply leave the run",
    async (leg) => {
      const root = await startToolExecutionRun("root", { localAuthorization: LOCAL_PERSON_RUN })
      const run = await startToolExecutionRun("s1", { parentRunId: root.id })
      await getDb().messages.bulkPut([
        {
          id: "anchor",
          sessionId: "source",
          createdAt: 1,
          role: "assistant",
          parts: [{ type: "text", text: "pnpm release" }],
          metadata: leg === "expand" ? { personalMarkVersion: 1 } : { personalMarks: [mark] },
        },
        {
          id: "neighbour",
          sessionId: "source",
          createdAt: 2,
          role: "user",
          parts: [{ type: "text", text: "private release preference" }],
          metadata: { personalMarks: [mark] },
        },
      ] as never)
      if (leg === "messages")
        jest.mocked(searchChatHistory).mockResolvedValue({
          results: [
            {
              messageId: "anchor",
              sessionId: "source",
              role: "assistant",
              createdAt: 1,
              snippet: { text: "pnpm release" },
            },
          ],
          moreOlderHistory: false,
          indexIncomplete: false,
        } as never)
      if (leg === "results")
        jest.mocked(searchChatResults).mockResolvedValue([
          {
            resultId: "result",
            messageId: "anchor",
            sessionId: "source",
            projectId: "ws1",
            title: "release",
            preview: "pnpm release",
            createdAt: 1,
            toolName: "read",
            bytes: 10,
          },
        ] as never)
      const result = await toolFamily.run(
        "project_history_search",
        leg === "expand" ? { expand: ["anchor"] } : { queries: ["pnpm"], scope: leg },
        { ...call, executionRunId: run.id }
      )
      expect(result).toMatchObject({ ok: true })
      expect(JSON.stringify(result)).toContain(
        leg === "expand" ? "private release preference" : "pnpm release"
      )
      for (const id of [run.id, root.id])
        expect((await getDb().executionRuns.get(id))?.personalMarks).toContainEqual(mark)
      bindPersonalMessageRun("reply", run.id)
      await commitMessageDelta("s1", {
        upserts: [
          { id: "reply", role: "assistant", parts: [{ type: "text", text: "pnpm release" }] },
        ],
      })
      expect((await listMessages("s1"))[0].metadata).toMatchObject({
        personalMarks: expect.arrayContaining([mark]),
      })
    }
  )

  it("does not mark a run for a personal hit withheld by the output PII gate", async () => {
    const run = await startToolExecutionRun("s1", { localAuthorization: LOCAL_PERSON_RUN })
    await getDb().messages.put({
      id: "private",
      sessionId: "source",
      role: "assistant",
      createdAt: 1,
      metadata: { personalMarks: [mark] },
    } as never)
    jest.mocked(searchChatHistory).mockResolvedValue({
      results: [
        {
          messageId: "private",
          sessionId: "source",
          role: "assistant",
          createdAt: 1,
          snippet: { text: "contact alice@example.com" },
        },
      ],
      moreOlderHistory: false,
      indexIncomplete: false,
    } as never)
    await expect(
      toolFamily.run(
        "project_history_search",
        { queries: ["contact"], scope: "messages" },
        { ...call, executionRunId: run.id }
      )
    ).resolves.toMatchObject({ ok: true, hits: [] })
    expect((await getDb().executionRuns.get(run.id))?.personalMarks).toBeUndefined()
  })

  it.each([true, false])(
    "receipts only readable window sources even when the session title is withheld (personal neighbour: %s)",
    async (personalNeighbour) => {
      const run = await startToolExecutionRun("s1", { localAuthorization: LOCAL_PERSON_RUN })
      const otherMark = {
        ...mark,
        person: { kind: "platform", platform: "lark", adapterId: "a", remoteUserId: "other" },
      }
      await getDb().messages.bulkPut([
        {
          id: "anchor",
          sessionId: "source",
          createdAt: 10,
          role: "assistant",
          parts: [{ type: "text", text: "public anchor" }],
          metadata: { personalMarkVersion: 1 },
        },
        {
          id: "neighbour",
          sessionId: "source",
          createdAt: 11,
          role: "user",
          parts: [{ type: "text", text: "release preference" }],
          metadata: personalNeighbour ? { personalMarks: [mark] } : { personalMarkVersion: 1 },
        },
        {
          id: "padding",
          sessionId: "source",
          createdAt: 12,
          role: "assistant",
          parts: [{ type: "text", text: "public padding" }],
          metadata: { personalMarkVersion: 1 },
        },
        {
          id: "outside",
          sessionId: "source",
          createdAt: 100,
          role: "user",
          parts: [{ type: "text", text: "another person's private fact" }],
          metadata: { personalMarks: [otherMark] },
        },
      ] as never)
      const result = await toolFamily.run(
        "project_history_search",
        { expand: ["anchor"] },
        { ...call, executionRunId: run.id }
      )
      expect(result).toMatchObject({
        ok: true,
        windows: [
          expect.objectContaining({ transcript: expect.stringContaining("release preference") }),
        ],
      })
      expect(JSON.stringify(result)).not.toContain("another person's private fact")
      const marks = (await getDb().executionRuns.get(run.id))?.personalMarks
      if (personalNeighbour) expect(marks).toEqual([mark])
      else expect(marks).toBeUndefined()
    }
  )
})
