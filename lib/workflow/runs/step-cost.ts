/**
 * The dollar cost of one `step_usage` report, priced the same way everywhere
 * a workflow run's spend is read: the run budget while the run executes
 * (`lib/workflow/runtime/run-budget.ts`) and the Runs UI afterwards
 * (`usage-aggregate.ts`, `budget-summary.ts`). Pure.
 */

import type { StepUsage } from "@/types/workflow/visual"
import { estimateCostFromTotals } from "@/lib/usage/session-analytics"

/**
 * The reported `costUsd` when the node knew it, otherwise an estimate from the
 * model's pricing table. `undefined` when neither prices the call: a model
 * with no pricing entry, or a report without a model id.
 */
export function stepCostUsd(usage: StepUsage): number | undefined {
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
    return usage.costUsd
  }
  const estimated = estimateCostFromTotals(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationTokens ?? 0,
    },
    usage.modelId,
    usage.providerId
  )
  return estimated > 0 ? estimated : undefined
}

/** A `step_usage` event payload read back as a {@link StepUsage}; `null` when it is not an object. */
export function stepUsageFromPayload(payload: unknown): StepUsage | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    inputTokens: num(p.inputTokens),
    outputTokens: num(p.outputTokens),
    totalTokens: num(p.totalTokens) || num(p.inputTokens) + num(p.outputTokens),
    cacheReadTokens: num(p.cacheReadTokens),
    cacheCreationTokens: num(p.cacheCreationTokens),
    providerId: typeof p.providerId === "string" ? p.providerId : undefined,
    modelId: typeof p.modelId === "string" ? p.modelId : undefined,
    costUsd: typeof p.costUsd === "number" && Number.isFinite(p.costUsd) ? p.costUsd : undefined,
  }
}
