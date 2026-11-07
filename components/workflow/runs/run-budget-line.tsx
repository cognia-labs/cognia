"use client"

/**
 * The run's dollar budget under the run header (playbooks plan WP5): spent of
 * the limit, whether the budget stopped the run, and the steps whose spend it
 * could not see ("not covered by the budget"). Renders nothing for a run
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
  run: Pick<WorkflowRunRow, "workflowSnapshot" | "lineage" | "error">
  events: WorkflowRunEventRow[]
}) {
  const t = useTranslations("workflows.runs.detail.budget")
  const summary = useMemo(() => summarizeRunBudget(run, events), [run, events])
  if (!summary) return null

  const labelOf = (stepId: string) =>
    run.workflowSnapshot.nodes.find((node) => node.id === stepId)?.data.label || stepId
  const inherited =
    summary.inheritedCeilingUsd !== undefined && summary.limitUsd === summary.inheritedCeilingUsd

  return (
    <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground" data-testid="run-budget">
      <span>
        {t("line", {
          spent: formatCostUsd(summary.spentUsd),
          limit: formatCostUsd(summary.limitUsd),
        })}
        {inherited ? ` (${t("inherited")})` : ""}
      </span>
      {summary.exhausted ? (
        <span className="font-medium text-destructive" data-testid="run-budget-exhausted">
          {t("exhausted")}
        </span>
      ) : null}
      {summary.uncoveredStepIds.length > 0 ? (
        <span className="text-amber-600 dark:text-amber-500" data-testid="run-budget-uncovered">
          {t("uncovered", { steps: summary.uncoveredStepIds.map(labelOf).join(", ") })}
        </span>
      ) : null}
    </p>
  )
}
