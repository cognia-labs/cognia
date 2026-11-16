"use client"

/**
 * The run's dollar budget under the run header (playbooks plan WP5): spent of
 * the limit and whether the budget stopped the run. Renders nothing for a run
 * without a budget.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { summarizeRunBudget } from "@/lib/workflow/runs/budget-summary"
import { formatCostUsd } from "@/lib/workflow/runs/usage-aggregate"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

export function RunBudgetLine({
  run,
  events,
}: {
  run: Pick<WorkflowRunRow, "workflowSnapshot" | "error">
  events: WorkflowRunEventRow[]
}) {
  const t = useTranslations("workflows.runs.detail.budget")
  const summary = useMemo(() => summarizeRunBudget(run, events), [run, events])
  if (!summary) return null

  return (
    <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground" data-testid="run-budget">
      <span>
        {t("line", {
          spent: formatCostUsd(summary.spentUsd),
          limit: formatCostUsd(summary.limitUsd),
        })}
      </span>
      {summary.exhausted ? (
        <span className="font-medium text-destructive" data-testid="run-budget-exhausted">
          {t("exhausted")}
        </span>
      ) : null}
    </p>
  )
}
