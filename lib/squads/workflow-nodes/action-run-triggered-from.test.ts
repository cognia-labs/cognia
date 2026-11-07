/**
 * The `action.team.run` node starts its Squad run through the one launch seam
 * (`startSquadRun` by way of `runSquadToEnd`, ADR-0252 §5). These tests pin
 * what the node hands the seam (the workflow parent, the IM conversation it
 * reports back to, the knowledge grant, the loop-guard depth, the goal, the
 * caller's signal) and the node output shape `{ teamId, teamRunId, status,
 * reason }` downstream steps read.
 */

import type { StartSquadRunInput } from "../squad/start-squad-run"

const runSquadToEnd = jest.fn()
const readWorkflowRun = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ workflowRuns: { get: (...args: unknown[]) => readWorkflowRun(...args) } }),
}))
jest.mock("@/lib/squads/squad/run-squad-to-end", () => ({
  runSquadToEnd: (...args: unknown[]) => runSquadToEnd(...args),
}))
jest.mock("@/stores/squads/agent-team-store/store", () => {
  const state = {
    getTeam: (id: string) => (id === "team-1" ? { id: "team-1", name: "T" } : undefined),
  }
  return { useAgentTeamStore: { getState: () => state } }
})

import "@/lib/workflow/nodes/built-ins"
import { getExecutor } from "@/lib/workflow/nodes/registry"
import { installTeamWorkflowNodeRuntime } from "./install"

// The workflow engine reaches these nodes through its port (ADR-0217).
installTeamWorkflowNodeRuntime()
import type {
  StepExecutionContext,
  TriggerEvent,
  WorkflowTriggerBinding,
} from "@/types/workflow/visual"

function ctxWith(
  options: {
    binding?: WorkflowTriggerBinding
    payload?: Record<string, unknown>
    params?: Record<string, unknown>
  } = {}
): StepExecutionContext {
  const trigger: TriggerEvent = {
    workflowId: "wf",
    kind: "trigger.manual",
    payload: options.payload ?? {},
    originAt: 1,
    ...(options.binding ? { binding: options.binding } : {}),
  }
  return {
    runId: "run_outer",
    workflowId: "wf",
    stepId: "n_team",
    params: options.params ?? { teamId: "team-1", goal: "  ship it  " },
    upstream: {},
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  }
}

const execute = (ctx: StepExecutionContext) => getExecutor("action.team.run", 1)!.execute(ctx)
const launched = () => runSquadToEnd.mock.calls.at(-1)?.[0] as StartSquadRunInput

beforeEach(() => {
  runSquadToEnd.mockReset()
  runSquadToEnd.mockResolvedValue({
    start: { started: true, runId: "run_team_1", executionRunId: "execution:team:run_team_1" },
    status: "completed",
    outcome: "completed",
  })
  readWorkflowRun.mockReset()
})

describe("action.team.run", () => {
  it("starts the Squad as the workflow run's child with its goal, waits under the node's signal, and keeps the output shape", async () => {
    const ctx = ctxWith()
    await expect(execute(ctx)).resolves.toEqual({
      output: { teamId: "team-1", teamRunId: "run_team_1", status: "completed", reason: undefined },
    })
    expect(runSquadToEnd).toHaveBeenCalledWith(
      {
        squadId: "team-1",
        goal: "ship it",
        origin: "interactive",
        triggeredFrom: { source: "ui" },
        launchedByRunId: "execution:workflow:run_outer",
      },
      { signal: ctx.signal }
    )
  })

  it("reports how the run ended and why", async () => {
    runSquadToEnd.mockResolvedValue({
      start: { started: true, runId: "run_team_2", executionRunId: "execution:team:run_team_2" },
      status: "cancelled",
      outcome: "cancelled",
      reason: "stop_unconfirmed",
    })
    await expect(execute(ctxWith())).resolves.toEqual({
      output: {
        teamId: "team-1",
        teamRunId: "run_team_2",
        status: "cancelled",
        reason: "stop_unconfirmed",
      },
    })
  })

  it("runs headless and reports back to the IM conversation a complete binding names", async () => {
    await execute(
      ctxWith({
        binding: { adapterId: "lark:a1", conversationKey: "lark:a1:oc_1", sessionId: "sess_1" },
      })
    )
    expect(launched()).toMatchObject({
      origin: "im",
      triggeredFrom: {
        source: "im",
        adapterId: "lark:a1",
        conversationKey: "lark:a1:oc_1",
        sessionId: "sess_1",
      },
    })
  })

  it("keeps the blocking gates when the binding lacks adapterId or conversationKey", async () => {
    await execute(ctxWith({ binding: { adapterId: "lark:a1" } }))
    expect(launched()).toMatchObject({ origin: "interactive", triggeredFrom: { source: "ui" } })
  })

  it("threads a team-completion fan-out's chain depth into the run", async () => {
    await execute(ctxWith({ payload: { chainDepth: 2 } }))
    expect(launched().triggerChainDepth).toBe(2)
    await execute(ctxWith({ payload: { chainDepth: "2" } }))
    expect(launched()).not.toHaveProperty("triggerChainDepth")
  })

  it("takes knowledge ACL identity from the durable public invocation and pins only admitted indexes", async () => {
    readWorkflowRun.mockResolvedValue({
      triggeredBy: { source: "api", initiator: { authenticated: true, principalId: "verified" } },
    })
    const ctx = ctxWith()
    ctx.executionBinding = {
      entrypoint: "http",
      dependencyLock: {
        workflows: {},
        indexes: { "knowledge:kb:source": "gen", "other:index": "ignored" },
      },
    } as never
    await execute(ctx)
    expect(launched().knowledgeAccess).toEqual({
      entrypoint: "http",
      triggeredBy: {
        source: "api",
        initiator: { authenticated: true, principalId: "verified" },
      },
      revisionBindings: { kb: ["gen"] },
      allowedKnowledgeBaseIds: ["kb"],
    })
  })

  it("fails without retry for a missing or unknown Squad, and for a refused or failed run", async () => {
    await expect(execute(ctxWith({ params: {} }))).rejects.toMatchObject({ retryable: false })
    await expect(execute(ctxWith({ params: { teamId: "nope" } }))).rejects.toMatchObject({
      message: expect.stringContaining("team nope not found"),
      retryable: false,
    })
    expect(runSquadToEnd).not.toHaveBeenCalled()
    runSquadToEnd.mockRejectedValue(new Error("Squad run refused: already_running"))
    await expect(execute(ctxWith())).rejects.toMatchObject({
      message: "action.team.run: Squad run refused: already_running",
      retryable: false,
    })
  })
})
