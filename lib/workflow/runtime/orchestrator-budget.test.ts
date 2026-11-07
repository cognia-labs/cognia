/**
 * @jest-environment jsdom
 *
 * The run budget (`settings.maxCostUsd`, ADR-0254 §6, playbooks plan WP5) as
 * `runWorkflow` enforces it: priced spend stops the run, unpriced spend is
 * marked "not covered" and the run goes on, and a sub-workflow inherits what
 * its parent has left.
 */
import "fake-indexeddb/auto"

const mockEmitCompletionFanout = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./workflow-completion-fanout", () => ({
  emitWorkflowCompletedFanout: (...args: unknown[]) => mockEmitCompletionFanout(...args),
}))

import { runWorkflow } from "./orchestrator"
import { listRunEvents } from "./event-log"
import { createRunBudget, registerRunBudget, unregisterRunBudget } from "./run-budget"
import { registerNodeExecutor } from "@/lib/workflow/nodes/registry"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { readBudgetLog, summarizeRunBudget } from "@/lib/workflow/runs/budget-summary"
import type {
  TriggerEvent,
  VisualWorkflow,
  WorkflowRunEventRow,
  WorkflowSettings,
} from "@/types/workflow/visual"
import type { RunLogger } from "./event-log"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
  executed.length = 0
})
afterAll(dbFixture.dispose)

const executed: string[] = []

registerNodeExecutor({
  kind: "ai.test.spend" as never,
  typeVersion: 1,
  execute: async (ctx) => {
    executed.push(ctx.stepId)
    const params = ctx.params as { costUsd?: number; modelId?: string; throwWhenStopped?: boolean }
    ctx.reportUsage?.({
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
      ...(params.modelId ? { modelId: params.modelId } : {}),
    })
    // A real model step notices the abort of its own run and throws.
    if (params.throwWhenStopped && ctx.signal.aborted) throw new Error("aborted")
    return { output: ctx.stepId }
  },
})
registerNodeExecutor({
  kind: "ai.test.silent" as never,
  typeVersion: 1,
  execute: async (ctx) => {
    executed.push(ctx.stepId)
    return { output: "no usage" }
  },
})

const trigger: TriggerEvent = {
  workflowId: "wf_budget",
  kind: "trigger.manual",
  payload: {},
  originAt: 1,
}

type Step = { id: string; kind?: string; params?: Record<string, unknown> }

/** A trigger followed by `steps` in a chain. */
function chain(steps: Step[], settings: Partial<WorkflowSettings> = {}): VisualWorkflow {
  const ids = ["t", ...steps.map((s) => s.id)]
  return {
    id: "wf_budget",
    schemaVersion: 1,
    name: "Budget",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: "t",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "start", params: {} },
      },
      ...steps.map((step, index) => ({
        id: step.id,
        type: (step.kind ?? "ai.test.spend") as never,
        typeVersion: 1,
        position: { x: 0, y: (index + 1) * 100 },
        data: { label: step.id, params: step.params ?? {} },
      })),
    ],
    edges: ids.slice(1).map((id, index) => ({ id: `e${index}`, source: ids[index], target: id })),
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      ...settings,
    },
  } as VisualWorkflow
}

const spend = (id: string, costUsd: number, extra: Record<string, unknown> = {}): Step => ({
  id,
  params: { costUsd, ...extra },
})

async function budgetRecords(runId: string) {
  const events = await listRunEvents(runId)
  return events
    .map((event) => [event.stepId, readBudgetLog(event)] as const)
    .filter(([, record]) => record !== null)
}

describe("runWorkflow run budget", () => {
  it("stops a run whose spend reaches the limit before its work is done", async () => {
    const workflow = chain(
      [spend("s1", 0.4), spend("s2", 0.4), spend("s3", 0.4), spend("s4", 0.4)],
      {
        maxCostUsd: 1,
      }
    )
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "s3" })
    expect(result.error?.message).toContain("$1.00")
    expect(executed).toEqual(["s1", "s2", "s3"])
    expect(await budgetRecords(result.runId)).toEqual([
      ["s3", expect.objectContaining({ budget: "exhausted", limitUsd: 1, scope: "run" })],
    ])
    const row = await getDb().workflowRuns.get(result.runId)
    expect(summarizeRunBudget(row!, await listRunEvents(result.runId))).toMatchObject({
      limitUsd: 1,
      spentUsd: expect.closeTo(1.2),
      exhausted: true,
    })
  })

  it("fails a run whose last step reached the limit: the abort stops that step too", async () => {
    const workflow = chain([spend("s1", 0.6), spend("s2", 0.6)], { maxCostUsd: 1 })
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "s2" })
    expect(await budgetRecords(result.runId)).toEqual([
      ["s2", expect.objectContaining({ budget: "exhausted" })],
    ])
  })

  it("lets no error policy turn the budget stop into a handled failure", async () => {
    const workflow = chain([spend("s1", 1, { throwWhenStopped: true }), spend("s2", 0.1)], {
      maxCostUsd: 1,
      errorPolicy: "continue",
    })
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "s1" })
    expect(executed).toEqual(["s1"])
  })

  it("marks spend it cannot price as not covered and keeps running", async () => {
    const workflow = chain(
      [
        { id: "unpriced", params: { modelId: "mystery-model-xyz" } },
        { id: "silent", kind: "ai.test.silent" },
        { id: "done", kind: "flow.set", params: { variable: "v", value: 1 } },
      ],
      { maxCostUsd: 0.01 }
    )
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("succeeded")
    expect(executed).toEqual(["unpriced", "silent"])
    expect(await budgetRecords(result.runId)).toEqual([
      ["unpriced", { budget: "uncovered", reason: "unpriced", nodeKind: "ai.test.spend" }],
      ["silent", { budget: "uncovered", reason: "unreported", nodeKind: "ai.test.silent" }],
    ])
    const row = await getDb().workflowRuns.get(result.runId)
    expect(summarizeRunBudget(row!, await listRunEvents(result.runId))).toMatchObject({
      spentUsd: 0,
      uncoveredStepIds: ["unpriced", "silent"],
      exhausted: false,
    })
  })

  it("does nothing for a workflow without a budget", async () => {
    const workflow = chain([spend("s1", 5), { id: "silent", kind: "ai.test.silent" }])
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("succeeded")
    expect(await budgetRecords(result.runId)).toEqual([])
  })

  it("holds a sub-workflow to what its live parent has left and charges the parent", async () => {
    const parentLog = { log: jest.fn(async () => undefined) } as unknown as RunLogger
    const parentStop = jest.fn()
    const parent = createRunBudget({
      runId: "run_parent",
      limitUsd: 1,
      logger: parentLog,
      nodeKindOf: () => "flow.subworkflow",
      onExhausted: parentStop,
    })
    registerRunBudget(parent)
    try {
      const workflow = chain([spend("c1", 0.3), spend("c2", 0.3), spend("c3", 0.3)])
      const result = await runWorkflow({
        workflow,
        trigger,
        lineage: {
          rootRunId: "run_parent",
          parentRunId: "run_parent",
          parentStepId: "sub",
          budgetCeilingUsd: 0.5,
        },
      })

      expect(result.status).toBe("failed")
      expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "c2" })
      expect(executed).toEqual(["c1", "c2"])
      expect(parent.spentUsd()).toBeCloseTo(0.6)
      expect(parentStop).not.toHaveBeenCalled()
      expect((parentLog.log as jest.Mock).mock.calls.map((call) => call[2])).toEqual([
        { budget: "child-spend", childRunId: result.runId, costUsd: 0.3 },
        { budget: "child-spend", childRunId: result.runId, costUsd: 0.3 },
      ])
    } finally {
      unregisterRunBudget("run_parent")
    }
  })

  it("resumes with what the run already spent", async () => {
    const workflow = chain([spend("s1", 0.4), spend("s2", 0.4)], { maxCostUsd: 1 })
    await getDb().workflowRuns.put({
      id: "run_resume",
      workflowId: "wf_budget",
      status: "running",
      triggerKind: "trigger.manual",
      triggerPayload: {},
      startedAt: 1,
      workflowSnapshot: workflow,
      lineage: { rootRunId: "run_resume" },
    } as never)
    await getDb().workflowRunEvents.bulkPut([
      {
        id: "ev_1",
        runId: "run_resume",
        ts: 1,
        sequence: 1,
        type: "step_usage",
        stepId: "earlier",
        payload: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.7 },
      } as unknown as WorkflowRunEventRow,
    ])

    const result = await runWorkflow({ workflow, trigger, runId: "run_resume" })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "s1" })
    expect(executed).toEqual(["s1"])
  })
})
