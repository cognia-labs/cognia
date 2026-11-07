/**
 * Aggregate `step_usage` events (emitted by LLM-backed nodes via
 * `ctx.reportUsage`) into per-step and run-level token/cost figures for the
 * Runs UI. Pure — no React, no Dexie.
 */

import type { StepUsage, WorkflowRunEventRow } from "@/types/workflow/visual"
import { stepCostUsd, stepUsageFromPayload } from "./step-cost"

export interface RunUsageSummary {
  /** Latest usage per step (retries overwrite earlier attempts). */
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
  for (const e of events) {
    if (e.type !== "step_usage" || !e.stepId) continue
    const usage = stepUsageFromPayload(e.payload)
    // Events arrive in ts order; the last usage for a step (latest retry) wins.
    if (usage) perStep[e.stepId] = usage
  }

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd: number | undefined
  let hasUnknownCost = false
  for (const usage of Object.values(perStep)) {
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    // A node that didn't report a cost (the ai-sdk / non-Anthropic path often
    // can't) is priced from the model's pricing table, so runs on priced
    // models still total up. Only truly-unpriced models stay "unknown".
    const cost = stepCostUsd(usage)
    if (cost === undefined) hasUnknownCost = true
    else totalCostUsd = (totalCostUsd ?? 0) + cost
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
