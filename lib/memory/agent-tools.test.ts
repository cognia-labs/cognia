import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import type { ProjectHistoryToolDeps } from "./project-history-tool"

const mockRecordEvidence = jest.fn()
jest.mock("@/lib/claude/project-history-evidence-registry", () => ({
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
