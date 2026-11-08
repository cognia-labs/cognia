/**
 * @jest-environment jsdom
 *
 * Focused test for the `action.team.reconcile` executor: it reads the per-run
 * TeamRunContext, no-ops without a Registry controller, and delegates explicit
 * detached-environment promotion to that controller.
 */

import "fake-indexeddb/auto"

const getTeamRunContextMock = jest.fn()
// The production lookups read files and git; here they are a lever.
const mockDeclared: Record<string, Array<{ repository: string }>> = {}
const mockRemotes: Record<string, string> = {}
jest.mock("@/lib/squads/workspace/declared-dependencies", () => ({
  ...jest.requireActual("@/lib/squads/workspace/declared-dependencies"),
  declaredDependencyDepsFor: () => ({
    declared: async ({ id }: { id: string }) => mockDeclared[id] ?? [],
    remoteOf: async (path: string) => mockRemotes[path] ?? null,
  }),
}))
jest.mock("@/lib/squads/team-run-context", () => ({
  getTeamRunContext: (...a: unknown[]) => getTeamRunContextMock(...a),
}))
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(async () => ({ text: "" })),
}))

import "@/lib/workflow/nodes/built-ins"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import { installTeamWorkflowNodeRuntime } from "./install"

// The workflow engine reaches these nodes through its port (ADR-0217).
installTeamWorkflowNodeRuntime()
import type { StepExecutionContext, TriggerEvent, WorkflowNodeKind } from "@/types/workflow/visual"

const trigger: TriggerEvent = { workflowId: "wf", kind: "trigger.manual", payload: {}, originAt: 1 }

function makeCtx<T extends Record<string, unknown>>(
  kind: WorkflowNodeKind,
  params: T
): StepExecutionContext<T> {
  return {
    runId: "run_test",
    workflowId: "wf",
    stepId: "n_test",
    params,
    upstream: {},
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  } as StepExecutionContext<T>
}

beforeEach(() => {
  getTeamRunContextMock.mockReset()
})

describe("action.team.reconcile executor", () => {
  it("throws when no TeamRunContext is registered", async () => {
    getTeamRunContextMock.mockReturnValue(undefined)
    const exec = getExecutor("action.team.reconcile", 1)!
    await expect(exec.execute(makeCtx("action.team.reconcile", {}))).rejects.toThrow(
      /no TeamRunContext/
    )
  })

  it("is a no-op when workspace isolation is off", async () => {
    getTeamRunContextMock.mockReturnValue({ runId: "run_test" }) // no allocator/ledger
    const exec = getExecutor("action.team.reconcile", 1)!
    const res = await exec.execute(makeCtx("action.team.reconcile", {}))
    expect(res.output).toEqual({ reconciled: false })
  })

  it("promotes Registry candidates in manual mode", async () => {
    const reconcile = jest.fn(async () => ({
      mode: "manual",
      branches: ["agent/run/A/t1", "agent/run/A/t2"],
      handles: [],
      summary: "2 promoted",
    }))
    getTeamRunContextMock.mockReturnValue({
      runId: "run_test",
      team: { config: { workspaceIsolation: { reconcile: "manual" } } },
      workspaceController: { reconcile },
    })
    const exec = getExecutor("action.team.reconcile", 1)!
    const res = await exec.execute(makeCtx("action.team.reconcile", {}))
    const output = res.output as { reconciled: boolean; mode: string; branches: string[] }
    expect(output.reconciled).toBe(true)
    expect(output.mode).toBe("manual")
    expect(output.branches).toEqual(["agent/run/A/t1", "agent/run/A/t2"])
    expect(reconcile).toHaveBeenCalledWith({ mode: "manual" })
  })

  it("lets the node param override the team default mode", async () => {
    const reconcile = jest.fn(async () => ({
      mode: "select",
      branches: ["agent/run/A/t2"],
      handles: [],
      winnerKey: "t2",
      summary: "selected",
    }))
    getTeamRunContextMock.mockReturnValue({
      runId: "run_test",
      team: { config: { workspaceIsolation: { reconcile: "manual" } } },
      workspaceController: { reconcile },
    })
    const exec = getExecutor("action.team.reconcile", 1)!
    const res = await exec.execute(
      makeCtx("action.team.reconcile", { mode: "select", selectStrategy: "first-success" })
    )
    const output = res.output as { reconciled: boolean; winnerKey?: string }
    expect(output.reconciled).toBe(true)
    expect(output.winnerKey).toBe("t2")
    expect(reconcile).toHaveBeenCalledWith({
      mode: "select",
      selectStrategy: "first-success",
    })
  })

  it("runs merge-all through the integration queue with the team's policy and task graph", async () => {
    const reconcile = jest.fn(async () => ({
      mode: "merge-all",
      branches: ["refs/heads/agent/run_test/integrated"],
      handles: [],
      summary: "2 changeset(s) integrated",
    }))
    const { useAgentTeamStore } = await import("@/stores/squads/agent-team-store/store")
    jest.spyOn(useAgentTeamStore.getState(), "getTeamTasks").mockReturnValue([
      { id: "t1", dependencies: [] },
      { id: "t2", dependencies: ["t1"] },
    ] as never)
    getTeamRunContextMock.mockReturnValue({
      runId: "run_test",
      team: {
        id: "team-1",
        projectId: "project-1",
        config: {
          workspaceIsolation: {
            reconcile: "manual",
            integration: { target: "base", onConflict: "stop", requiredChecks: ["unit"] },
          },
          repositories: [
            { id: "sdk", role: "dependency", path: "/repo/sdk", writable: true },
            { id: "app", role: "primary", path: "/repo/app", writable: true, dependsOn: ["sdk"] },
          ],
        },
      },
      workspaceController: { reconcile },
    })
    const exec = getExecutor("action.team.reconcile", 1)!
    const res = await exec.execute(makeCtx("action.team.reconcile", { mode: "merge-all" }))

    expect((res.output as { reconciled: boolean }).reconciled).toBe(true)
    const [options] = reconcile.mock.calls[0] as unknown as [
      {
        mode: string
        mergeAll: {
          config: unknown
          dependencies: unknown
          repositoryDependencies: unknown
          unresolvedDependencies: unknown
          deps: Record<string, unknown>
        }
      },
    ]
    expect(options.mode).toBe("merge-all")
    expect(options.mergeAll.config).toEqual({
      target: "base",
      strategy: "merge",
      onConflict: "stop",
      requiredChecks: ["unit"],
    })
    expect(options.mergeAll.dependencies).toEqual({ t1: [], t2: ["t1"] })
    // Repository ids are the logical roots the run acquired.
    expect(options.mergeAll.repositoryDependencies).toEqual({ app: ["sdk"] })
    expect(options.mergeAll.unresolvedDependencies).toEqual({})
    for (const port of [
      "host",
      "review",
      "integrate",
      "currentBranch",
      "branchExists",
      "createBranch",
      "signal",
    ]) {
      expect(options.mergeAll.deps[port]).toBeDefined()
    }
  })
  it("adds the edges each repository declares itself, and says which did not resolve", async () => {
    // ADR-0147, 2026-11-08 amendment: the app's approved file names the SDK
    // and a UI kit by remote; only the SDK is in the run.
    mockDeclared.app = [{ repository: "github.com/org/sdk" }, { repository: "github.com/org/ui" }]
    mockRemotes["/repo/sdk"] = "git@github.com:Org/SDK.git"
    mockRemotes["/repo/app"] = "https://github.com/org/app"
    const reconcile = jest.fn(async () => ({
      mode: "merge-all",
      branches: [],
      handles: [],
      summary: "",
    }))
    getTeamRunContextMock.mockReturnValue({
      runId: "run_test",
      team: {
        id: "team-1",
        projectId: "project-1",
        config: {
          workspaceIsolation: { reconcile: "manual" },
          repositories: [
            { id: "sdk", role: "dependency", path: "/repo/sdk", writable: true },
            { id: "app", role: "primary", path: "/repo/app", writable: true },
          ],
        },
      },
      workspaceController: { reconcile },
    })
    await getExecutor("action.team.reconcile", 1)!.execute(
      makeCtx("action.team.reconcile", { mode: "merge-all" })
    )
    const [options] = reconcile.mock.calls[0] as unknown as [
      { mergeAll: { repositoryDependencies: unknown; unresolvedDependencies: unknown } },
    ]
    expect(options.mergeAll.repositoryDependencies).toEqual({ app: ["sdk"] })
    expect(options.mergeAll.unresolvedDependencies).toEqual({
      app: [{ repository: "github.com/org/ui", reason: "noMatch", matches: [] }],
    })
    delete mockDeclared.app
  })
})
