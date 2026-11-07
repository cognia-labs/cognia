/**
 * The dollar budget of a workflow run (`WorkflowSettings.maxCostUsd`, playbooks
 * plan WP5), read back from the run's own events. The runtime writes its
 * budget decisions as `run_log` events carrying a {@link RunBudgetLogData}
 * payload; this file is the one place that names those markers, so the
 * runtime (`lib/workflow/runtime/run-budget.ts`, which also tallies a resumed
 * run from here) and the Runs UI agree on what was spent and what the budget
 * could not see. Pure.
 */

import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import { stepCostUsd, stepUsageFromPayload } from "./step-cost"

/** `error.code` of a run the budget stopped. */
export const BUDGET_EXHAUSTED_CODE = "budget_exhausted"

/**
 * Why a step's spend escaped the budget:
 * - `unpriced`: it reported usage that neither carried a cost nor named a
 *   priced model;
 * - `unreported`: it calls a model but reported no usage at all;
 * - `child`: a sub-workflow it started had such a step.
 */
export type RunBudgetUncoveredReason = "unpriced" | "unreported" | "child"

export type RunBudgetLogData =
  | {
      budget: "uncovered"
      reason: RunBudgetUncoveredReason
      nodeKind?: string
      childRunId?: string
    }
  | { budget: "child-spend"; childRunId: string; costUsd: number }
  | {
      budget: "exhausted"
      limitUsd: number
      spentUsd: number
      /** `parent`: the run that started this one ran out, not this run's own limit. */
      scope: "run" | "parent"
    }

/** A `run_log` payload's data as a budget record, or `null` for any other log. */
export function readBudgetLog(event: WorkflowRunEventRow): RunBudgetLogData | null {
  if (event.type !== "run_log") return null
  const data = (event.payload as { data?: unknown } | undefined)?.data
  if (!data || typeof data !== "object") return null
  const record = data as Record<string, unknown>
  switch (record.budget) {
    case "uncovered":
      return record.reason === "unpriced" ||
        record.reason === "unreported" ||
        record.reason === "child"
        ? (record as RunBudgetLogData)
        : null
    case "child-spend":
      return typeof record.childRunId === "string" &&
        typeof record.costUsd === "number" &&
        Number.isFinite(record.costUsd)
        ? (record as RunBudgetLogData)
        : null
    case "exhausted":
      return typeof record.limitUsd === "number" && typeof record.spentUsd === "number"
        ? (record as RunBudgetLogData)
        : null
    default:
      return null
  }
}

/**
 * The limit a run enforces: its own `maxCostUsd`, lowered to what the parent
 * run had left when it started this one. `undefined` = no budget.
 */
export function effectiveBudgetLimitUsd(
  maxCostUsd: number | undefined,
  inheritedCeilingUsd: number | undefined
): number | undefined {
  const limits = [maxCostUsd, inheritedCeilingUsd].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  )
  return limits.length === 0 ? undefined : Math.max(0, Math.min(...limits))
}

export interface RunBudgetTally {
  /** Every priced usage report (all attempts and loop iterations) plus sub-workflow spend. */
  spentUsd: number
  /** Steps that reported any usage, priced or not. */
  reportedStepIds: Set<string>
  /** Steps already marked as not covered, in first-marked order. */
  uncoveredStepIds: string[]
  /** The budget already stopped the run. */
  exhausted: boolean
}

/** What a run's events say it spent against its budget. */
export function tallyRunBudget(events: readonly WorkflowRunEventRow[]): RunBudgetTally {
  let spentUsd = 0
  const reportedStepIds = new Set<string>()
  const uncovered = new Set<string>()
  let exhausted = false
  for (const event of events) {
    if (event.type === "step_usage" && event.stepId) {
      const usage = stepUsageFromPayload(event.payload)
      if (!usage) continue
      reportedStepIds.add(event.stepId)
      spentUsd += stepCostUsd(usage) ?? 0
      continue
    }
    const record = readBudgetLog(event)
    if (!record) continue
    if (record.budget === "child-spend") spentUsd += record.costUsd
    else if (record.budget === "uncovered" && event.stepId) uncovered.add(event.stepId)
    else if (record.budget === "exhausted") exhausted = true
  }
  return { spentUsd, reportedStepIds, uncoveredStepIds: [...uncovered], exhausted }
}

export interface RunBudgetSummary {
  limitUsd: number
  /** The workflow's own limit, when it set one. */
  maxCostUsd?: number
  /** What the parent run had left when it started this run, when it is a budgeted sub-workflow. */
  inheritedCeilingUsd?: number
  spentUsd: number
  /** Steps whose spend the budget could not see ("预算未覆盖"). */
  uncoveredStepIds: string[]
  /** The budget stopped the run. */
  exhausted: boolean
}

/** The run's budget for the Runs UI; `null` when the run had none. */
export function summarizeRunBudget(
  run: Pick<WorkflowRunRow, "workflowSnapshot" | "lineage" | "error">,
  events: readonly WorkflowRunEventRow[]
): RunBudgetSummary | null {
  const maxCostUsd = run.workflowSnapshot.settings?.maxCostUsd
  const inheritedCeilingUsd = run.lineage?.budgetCeilingUsd
  const limitUsd = effectiveBudgetLimitUsd(maxCostUsd, inheritedCeilingUsd)
  if (limitUsd === undefined) return null
  const tally = tallyRunBudget(events)
  return {
    limitUsd,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(inheritedCeilingUsd !== undefined ? { inheritedCeilingUsd } : {}),
    spentUsd: tally.spentUsd,
    uncoveredStepIds: tally.uncoveredStepIds,
    exhausted: tally.exhausted || run.error?.code === BUDGET_EXHAUSTED_CODE,
  }
}
