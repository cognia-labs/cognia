/**
 * Aggregate `step_usage` events (emitted by LLM-backed nodes via
 * `ctx.reportUsage`) into per-step and run-level token/cost figures for the
 * Runs UI. Pure — no React, no Dexie.
 */

import type { StepUsage, WorkflowRunEventRow } from "@/types/workflow/visual"
import { stepCostUsd, stepUsageFromPayload, stepUsageKey } from "./step-cost"

export interface RunUsageSummary {
  /** Sum of independent executions per step; snapshots of one execution replace. */
  perStep: Record<string, StepUsage>
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  /** Sum of the known per-step costs; undefined when NO step had pricing. */
  totalCostUsd?: number
  /** True when at least one usage-reporting step had no pricing info. */
  hasUnknownCost: boolean
}

export function aggregateRunUsage(events: WorkflowRunEventRow[]): RunUsageSummary {
  const perStep: Record<string, StepUsage> = {}
  const executions = new Map<string, { stepId: string; usage: StepUsage }>()
  const unpricedSteps = new Set<string>()
  for (const e of events) {
    if (e.type !== "step_usage" || !e.stepId) continue
    const usage = stepUsageFromPayload(e.payload)
    // Legacy rows retain their last-per-step policy; only identified executions
    // can distinguish repeated invocations from repeated cumulative snapshots.
    if (usage)
      executions.set(JSON.stringify([e.runId, stepUsageKey(e.stepId, usage)]), {
        stepId: e.stepId,
        usage,
      })
  }

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd: number | undefined
  let hasUnknownCost = false
  for (const { stepId, usage } of executions.values()) {
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    // A node that didn't report a cost (the ai-sdk / non-Anthropic path often
    // can't) is priced from the model's pricing table, so runs on priced
    // models still total up. Only truly-unpriced models stay "unknown".
    const cost = stepCostUsd(usage)
    if (cost === undefined) {
      hasUnknownCost = true
      unpricedSteps.add(stepId)
    } else totalCostUsd = (totalCostUsd ?? 0) + cost
    const previous = perStep[stepId]
    perStep[stepId] = {
      inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
      cacheReadTokens: (previous?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      cacheCreationTokens: (previous?.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
      providerId:
        !previous || previous.providerId === usage.providerId ? usage.providerId : undefined,
      modelId: !previous || previous.modelId === usage.modelId ? usage.modelId : undefined,
      costUsd: cost === undefined ? previous?.costUsd : (previous?.costUsd ?? 0) + cost,
    }
  }

  for (const stepId of unpricedSteps) {
    perStep[stepId].costUsd = undefined
    perStep[stepId].costKnown = false
  }

  return {
    perStep,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd,
    hasUnknownCost,
  }
}

/** "$0.0042" style estimate; sub-cent costs keep enough precision to read. */
export function formatCostUsd(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return "—"
  if (cost === 0) return "$0"
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}
