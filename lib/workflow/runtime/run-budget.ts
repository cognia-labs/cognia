/**
 * The dollar budget of one workflow run (`WorkflowSettings.maxCostUsd`,
 * ADR-0254 §6, playbooks plan WP5).
 *
 * Counting rule (user decision 2026-11-07): every step's reported cost, and
 * every usage report a model's pricing table can price, counts against the
 * limit. A step whose spend cannot be priced, or a model-calling step that
 * reported no usage at all, does not stop the run: it is marked "not covered
 * by the budget" in the run log (a `run_log` warning) and in the run summary.
 * This deliberately differs from the chat quota (`quota-service.ts`), which
 * refuses unknown cost: a workflow is unattended, and refusing would fail runs
 * that cost nothing measurable.
 *
 * The budget wraps the run's logger: the usage the step executor already
 * reports through `logger.stepUsage` is what it counts. Once the spend reaches
 * the limit it aborts the run with a {@link WorkflowBudgetExhaustedError}: the
 * steps in flight stop (the one whose usage reached the limit included), no
 * further step starts, and the run fails with `budget_exhausted` whatever the
 * error policy says.
 *
 * A sub-workflow started by `flow.subworkflow` inherits what is left: its
 * lineage carries `budgetCeilingUsd`, its own spend is charged to the parent as
 * it happens (recorded on the parent as a `child-spend` log on the calling
 * step), and a charge that would exhaust the parent stops the child first.
 */

import type { StepUsage, WorkflowRunEventRow } from "@/types/workflow/visual"
import {
  BUDGET_EXHAUSTED_CODE,
  tallyRunBudget,
  type RunBudgetLogData,
  type RunBudgetUncoveredReason,
} from "@/lib/workflow/runs/budget-summary"
import { formatCostUsd } from "@/lib/workflow/runs/usage-aggregate"
import { stepCostUsd } from "@/lib/workflow/runs/step-cost"
import type { RunLogger } from "./event-log"

/**
 * Node kinds outside the `ai` category that call a model. A step of one of
 * these kinds that finishes without a usage report is marked not covered.
 * Every `ai.*` kind counts too.
 */
const MODEL_CALLING_KINDS: ReadonlySet<string> = new Set([
  "action.agent.turn",
  "action.character.send",
  "action.goal.decomposeSubgoals",
  "action.plan.refine",
  "action.plan.run",
  "action.plan.step.dispatch",
  "action.skill.invoke",
  "action.team.delegate",
  "action.team.run",
  "action.team.task.dispatch",
  "action.team.task.review",
  "action.twin.rag",
  "eval.run",
  "knowledge.embed",
])

export function isModelCallingKind(kind: string): boolean {
  return kind.startsWith("ai.") || MODEL_CALLING_KINDS.has(kind)
}

/** Spend within this of the limit counts as reaching it (float sums). */
const LIMIT_EPSILON_USD = 1e-9

export class WorkflowBudgetExhaustedError extends Error {
  readonly code = BUDGET_EXHAUSTED_CODE
  constructor(
    readonly limitUsd: number,
    readonly spentUsd: number,
    /** `parent`: the run that started this one ran out. */
    readonly scope: "run" | "parent",
    /** The step whose usage reached the limit; absent when a resumed run starts already spent. */
    readonly stepId?: string
  ) {
    super(
      scope === "parent"
        ? `The parent run's budget is spent (${formatCostUsd(spentUsd)} of ${formatCostUsd(limitUsd)}); this sub-workflow stopped`
        : `Run budget of ${formatCostUsd(limitUsd)} spent (${formatCostUsd(spentUsd)}); the run stopped`
    )
    this.name = "WorkflowBudgetExhaustedError"
  }
}

export interface RunBudget {
  readonly runId: string
  readonly limitUsd: number
  /** The run's logger with budget accounting attached; hand this to every step. */
  readonly logger: RunLogger
  spentUsd(): number
  remainingUsd(): number
  /** The error the budget stopped the run with, once it has. */
  exhausted(): WorkflowBudgetExhaustedError | undefined
  /** Resume: count what the run's earlier events already spent. */
  hydrate(events: readonly WorkflowRunEventRow[]): void
}

interface InternalRunBudget extends RunBudget {
  /** Would charging `costUsd` more reach this budget's limit, or an ancestor's? */
  wouldExhaust(costUsd: number): boolean
  chargeFromChild(costUsd: number, childRunId: string, stepId: string): void
  markChildUncovered(childRunId: string, stepId: string): void
}

export interface CreateRunBudgetOptions {
  runId: string
  limitUsd: number
  /** The run's own logger; the budget logs through it and wraps it. */
  logger: RunLogger
  /** Node kind of a step id (loop-body steps included). */
  nodeKindOf: (stepId: string) => string | undefined
  /** Stop the run. Called once, with the error the run should fail with. */
  onExhausted: (error: WorkflowBudgetExhaustedError) => void
  /** The live budget of the parent run, for a sub-workflow that inherits it. */
  parent?: RunBudget
  /** The parent's step that started this run (where the parent records this run's spend). */
  parentStepId?: string
}

export function createRunBudget(options: CreateRunBudgetOptions): RunBudget {
  const { runId, limitUsd, logger: base, nodeKindOf, onExhausted } = options
  const parent = options.parent as InternalRunBudget | undefined
  const parentStepId = options.parentStepId
  let spent = 0
  let stoppedWith: WorkflowBudgetExhaustedError | undefined
  const reported = new Set<string>()
  const executed = new Set<string>()
  const uncovered = new Set<string>()

  const log = (
    level: "info" | "warn" | "error",
    message: string,
    data: RunBudgetLogData,
    stepId?: string
  ) => void base.log(level, message, data, stepId)

  const stop = (scope: "run" | "parent", stepId: string | undefined) => {
    if (stoppedWith) return
    stoppedWith = new WorkflowBudgetExhaustedError(limitUsd, spent, scope, stepId)
    log(
      "error",
      stoppedWith.message,
      { budget: "exhausted", limitUsd, spentUsd: spent, scope },
      stepId
    )
    onExhausted(stoppedWith)
  }

  const reachesLimit = (amount: number) => amount >= limitUsd - LIMIT_EPSILON_USD

  /** Count `costUsd` here, then pass it up; stop this run before the parent's stop cascades into it. */
  const charge = (costUsd: number, stepId: string | undefined) => {
    if (parent && parentStepId && parent.wouldExhaust(costUsd)) {
      spent += costUsd
      stop("parent", stepId)
    } else {
      spent += costUsd
      if (reachesLimit(spent)) stop("run", stepId)
    }
    if (parent && parentStepId) parent.chargeFromChild(costUsd, runId, parentStepId)
  }

  const markUncovered = (
    stepId: string,
    reason: RunBudgetUncoveredReason,
    extra: { nodeKind?: string; childRunId?: string } = {}
  ) => {
    if (uncovered.has(stepId)) return
    uncovered.add(stepId)
    log(
      "warn",
      reason === "child"
        ? "A sub-workflow step's cost is not covered by the run budget"
        : "Step cost is not covered by the run budget",
      { budget: "uncovered", reason, ...extra },
      stepId
    )
    if (parent && parentStepId) parent.markChildUncovered(runId, parentStepId)
  }

  const logger: RunLogger = {
    ...base,
    stepStarted: (stepId, params, meta) => {
      // The executor logs `{ attempt }` for a real run of the node; a pinned
      // output (`{ pinned: true }`) spends nothing.
      if (params && typeof params === "object" && "attempt" in params) executed.add(stepId)
      return base.stepStarted(stepId, params, meta)
    },
    stepUsage: (stepId: string, usage: StepUsage) => {
      const written = base.stepUsage(stepId, usage)
      reported.add(stepId)
      const cost = stepCostUsd(usage)
      if (cost === undefined) markUncovered(stepId, "unpriced", kindOf(stepId))
      else if (cost > 0) charge(cost, stepId)
      return written
    },
    stepCompleted: (stepId, output, meta) => {
      const kind = nodeKindOf(stepId)
      if (kind && executed.has(stepId) && !reported.has(stepId) && isModelCallingKind(kind)) {
        markUncovered(stepId, "unreported", { nodeKind: kind })
      }
      return base.stepCompleted(stepId, output, meta)
    },
  }

  function kindOf(stepId: string): { nodeKind?: string } {
    const kind = nodeKindOf(stepId)
    return kind ? { nodeKind: kind } : {}
  }

  const budget: InternalRunBudget = {
    runId,
    limitUsd,
    logger,
    spentUsd: () => spent,
    remainingUsd: () => Math.max(0, limitUsd - spent),
    exhausted: () => stoppedWith,
    hydrate(events) {
      const tally = tallyRunBudget(events)
      spent = tally.spentUsd
      for (const stepId of tally.reportedStepIds) reported.add(stepId)
      for (const stepId of tally.uncoveredStepIds) uncovered.add(stepId)
      if (reachesLimit(spent)) stop("run", undefined)
    },
    wouldExhaust(costUsd) {
      if (stoppedWith) return true
      if (reachesLimit(spent + costUsd)) return true
      return Boolean(parent && parentStepId && parent.wouldExhaust(costUsd))
    },
    chargeFromChild(costUsd, childRunId, stepId) {
      log(
        "info",
        `Sub-workflow spent ${formatCostUsd(costUsd)}`,
        { budget: "child-spend", childRunId, costUsd },
        stepId
      )
      charge(costUsd, stepId)
    },
    markChildUncovered(childRunId, stepId) {
      markUncovered(stepId, "child", { childRunId })
    },
  }
  return budget
}

const liveBudgets = new Map<string, RunBudget>()

/** Make a run's budget reachable by the sub-workflows it starts. */
export function registerRunBudget(budget: RunBudget): void {
  liveBudgets.set(budget.runId, budget)
}

export function unregisterRunBudget(runId: string): void {
  liveBudgets.delete(runId)
}

/** The live budget of a run in this process, if it has one. */
export function getRunBudget(runId: string): RunBudget | undefined {
  return liveBudgets.get(runId)
}
