/**
 * @jest-environment jsdom
 *
 * The run budget (`settings.maxCostUsd`, ADR-0254 §6) as ADR-0243 3B amends
 * it: the budget is declared on the run tree's ledger, every model call a step
 * makes reserves there before it starts, and a refused or stopped call fails
 * the run. A sub-workflow draws on what its parent has left; a resumed run
 * keeps what it spent; a manual retry starts a fresh budget.
 */
import "fake-indexeddb/auto"

const mockEmitCompletionFanout = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./workflow-completion-fanout", () => ({
  emitWorkflowCompletedFanout: (...args: unknown[]) => mockEmitCompletionFanout(...args),
}))

import { runWorkflow } from "./orchestrator"
import { listRunEvents } from "./event-log"
import { registerNodeExecutor } from "@/lib/workflow/nodes/registry"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { readBudgetLog, summarizeRunBudget } from "@/lib/workflow/runs/budget-summary"
import { beginRailBudget } from "@/lib/execution/run-budget-rail"
import { declareRunBudget } from "@/lib/execution/run-ledger"
import { workflowExecutionRunId } from "@/lib/execution/workflow-bridge"
import type { TriggerEvent, VisualWorkflow, WorkflowSettings } from "@/types/workflow/visual"

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
  await getDb().executionRuns.clear()
  executed.length = 0
})
afterAll(dbFixture.dispose)

const executed: string[] = []
/** A model the static price table knows, so a USD budget can reserve for it. */
const PRICED = "gpt-5.4-mini"

// A model step as the rails run one: reserve on the run's ledger, call, then
// settle on what the call reported (nothing reported: the whole hold).
registerNodeExecutor({
  kind: "ai.test.spend" as never,
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { costUsd?: number; modelId?: string }
    const budget = await beginRailBudget(
      workflowExecutionRunId(ctx.runId),
      { modelId: params.modelId ?? PRICED },
      { signal: ctx.signal }
    )
    executed.push(ctx.stepId)
    ctx.reportUsage?.({
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
    })
    await budget?.finish(
      params.costUsd === undefined ? undefined : { costUsd: params.costUsd },
      params.costUsd !== undefined
    )
    return { output: ctx.stepId }
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
    schemaVersion: 2,
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

const spend = (id: string, costUsd?: number, extra: Record<string, unknown> = {}): Step => ({
  id,
  params: { ...(costUsd !== undefined ? { costUsd } : {}), ...extra },
})

async function settledSpend(runId: string) {
  const events = await listRunEvents(runId)
  return events.map(readBudgetLog).filter((record) => record !== null)
}

describe("runWorkflow run budget", () => {
  it("refuses the call that finds the budget spent and fails the run there", async () => {
    const workflow = chain(
      [spend("s1", 0.4), spend("s2", 0.4), spend("s3", 0.4), spend("s4", 0.4)],
      { maxCostUsd: 1 }
    )
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "s4" })
    expect(executed).toEqual(["s1", "s2", "s3"])
    expect(await settledSpend(result.runId)).toEqual([
      { budget: "spent", limitUsd: 1, spentUsd: expect.closeTo(1.2) },
    ])
    const row = await getDb().workflowRuns.get(result.runId)
    expect(summarizeRunBudget(row!, await listRunEvents(result.runId))).toEqual({
      limitUsd: 1,
      spentUsd: expect.closeTo(1.2),
      exhausted: true,
    })
  })

  it("lets no error policy turn a refused call into a handled failure", async () => {
    const workflow = chain([spend("s1", 1), spend("s2", 0.1), spend("s3", 0.1)], {
      maxCostUsd: 1,
      errorPolicy: "continue",
    })
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "s2" })
    expect(executed).toEqual(["s1"])
  })

  it("charges a call that reported nothing its whole hold, never zero", async () => {
    const workflow = chain([spend("silent"), spend("after", 0.1)], { maxCostUsd: 1 })
    const result = await runWorkflow({ workflow, trigger })

    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "after" })
    expect(executed).toEqual(["silent"])
  })

  it("refuses a model with no price under a USD budget before it is called", async () => {
    const workflow = chain([spend("unpriced", 0.1, { modelId: "mystery-model-xyz" })], {
      maxCostUsd: 1,
    })
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "pricing_unknown", nodeId: "unpriced" })
    expect(executed).toEqual([])
  })

  it("does nothing for a workflow without a budget", async () => {
    const workflow = chain([spend("s1", 5), spend("silent")])
    const result = await runWorkflow({ workflow, trigger })

    expect(result.status).toBe("succeeded")
    expect(await settledSpend(result.runId)).toEqual([])
    expect(
      (await getDb().executionRuns.get(workflowExecutionRunId(result.runId)))?.runLedger
    ).toBeUndefined()
  })

  it("holds a sub-workflow to what its parent's tree has left", async () => {
    await runWorkflow({ workflow: chain([]), trigger, runId: "run_parent" })
    await declareRunBudget(workflowExecutionRunId("run_parent"), { costUsd: 0.5 })
    const workflow = chain([spend("c1", 0.3), spend("c2", 0.3), spend("c3", 0.3)])
    const result = await runWorkflow({
      workflow,
      trigger,
      lineage: { rootRunId: "run_parent", parentRunId: "run_parent", parentStepId: "sub" },
    })

    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "budget_exhausted", nodeId: "c3" })
    expect(executed).toEqual(["c1", "c2"])
    const parentLedger = (await getDb().executionRuns.get(workflowExecutionRunId("run_parent")))
      ?.runLedger
    expect(parentLedger?.spent.costUsd).toBeCloseTo(0.6)
  })

  it("resumes with what the run already spent, and a manual retry starts fresh", async () => {
    const spender = chain([spend("s1", 0.7)], { maxCostUsd: 1 })
    const first = await runWorkflow({ workflow: spender, trigger, runId: "run_resume" })
    expect(first.status).toBe("succeeded")
    // The process died before the run's row settled: it is resumed in place.
    await getDb().workflowRuns.update("run_resume", { status: "running", completedAt: undefined })
    executed.length = 0
    // A resumed run re-enters its own declaration: the ledger keeps the 0.7.
    const resumed = await runWorkflow({
      workflow: chain([spend("s2", 0.4), spend("s3", 0.1)], { maxCostUsd: 1 }),
      trigger,
      runId: "run_resume",
    })
    expect(resumed.error).toMatchObject({ code: "budget_exhausted", nodeId: "s3" })
    expect(executed).toEqual(["s2"])
    executed.length = 0
    // A retry of it is a new root with a ledger of its own.
    const retried = await runWorkflow({
      workflow: chain([spend("s2", 0.4), spend("s3", 0.1)], { maxCostUsd: 1 }),
      trigger,
      lineage: { rootRunId: "run_retry", retryOfRunId: "run_resume" },
      runId: "run_retry",
    })
    expect(retried.status).toBe("succeeded")
    expect(executed).toEqual(["s2", "s3"])
  })
})
