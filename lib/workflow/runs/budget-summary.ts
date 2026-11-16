/**
 * The dollar budget of a workflow run (`WorkflowSettings.maxCostUsd`, playbooks
 * plan WP5), read back from the run's own events for the Runs UI. Pure.
 *
 * The budget itself is the run tree's ledger (ADR-0243 3B,
 * `lib/execution/run-ledger.ts`). When the run ends, the runtime logs what its
 * declaration spent, sub-workflows and unreported calls included, as one
 * `run_log` event carrying {@link RunBudgetLogData}. Until then the summary
 * sums the priced usage the run's own steps reported: reports that share a
 * `stepExecutionId` are cumulative snapshots of one attempt, so the latest
 * counts; reports without one add up.
 */

import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import { stepCostUsd, stepUsageFromPayload } from "./step-cost"

/** `error.code` of a run the budget stopped. */
export const BUDGET_EXHAUSTED_CODE = "budget_exhausted"

/** What the run's budget declaration spent, logged when the run ends. */
export interface RunBudgetLogData {
  budget: "spent"
  limitUsd: number
  spentUsd: number
}

/** A `run_log` payload's data as a budget record, or `null` for any other log. */
export function readBudgetLog(event: WorkflowRunEventRow): RunBudgetLogData | null {
  if (event.type !== "run_log") return null
  const data = (event.payload as { data?: unknown } | undefined)?.data
  if (!data || typeof data !== "object") return null
  const record = data as Record<string, unknown>
  return record.budget === "spent" &&
    typeof record.limitUsd === "number" &&
    typeof record.spentUsd === "number" &&
    Number.isFinite(record.spentUsd)
    ? (record as unknown as RunBudgetLogData)
    : null
}

export interface RunBudgetSummary {
  limitUsd: number
  spentUsd: number
  /** The budget stopped the run. */
  exhausted: boolean
}

/** The run's budget for the Runs UI; `null` when the run had none. */
export function summarizeRunBudget(
  run: Pick<WorkflowRunRow, "workflowSnapshot" | "error">,
  events: readonly WorkflowRunEventRow[]
): RunBudgetSummary | null {
  const limitUsd = run.workflowSnapshot.settings?.maxCostUsd
  if (limitUsd === undefined) return null
  let settled: number | undefined
  let reported = 0
  const attempts = new Map<string, number>()
  for (const event of events) {
    const record = readBudgetLog(event)
    if (record) settled = record.spentUsd
    else if (event.type === "step_usage") {
      const usage = stepUsageFromPayload(event.payload)
      if (!usage) continue
      const payload = event.payload as { stepExecutionId?: unknown; costKnown?: unknown }
      const cost = payload.costKnown === false ? 0 : (stepCostUsd(usage) ?? 0)
      if (typeof payload.stepExecutionId !== "string" || !payload.stepExecutionId) {
        reported += cost
        continue
      }
      const attempt = JSON.stringify([event.stepId, payload.stepExecutionId])
      reported += cost - (attempts.get(attempt) ?? 0)
      attempts.set(attempt, cost)
    }
  }
  return {
    limitUsd,
    spentUsd: settled ?? reported,
    exhausted: run.error?.code === BUDGET_EXHAUSTED_CODE,
  }
}
