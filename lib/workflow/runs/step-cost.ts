/**
 * The dollar cost of one `step_usage` report, priced the same way everywhere
 * the Runs UI reads a workflow run's spend (`usage-aggregate.ts`,
 * `budget-summary.ts`). The run's budget is the run tree's ledger, metered at
 * each model call (ADR-0243 3B). Pure.
 */

import type { StepUsage } from "@/types/workflow/visual"
import { estimateCostFromTotals } from "@/lib/usage/session-analytics"

/**
 * The reported `costUsd` when the node knew it, otherwise an estimate from the
 * model's pricing table. `undefined` when neither prices the call: a model
 * with no pricing entry, or a report without a model id.
 */
export function stepCostUsd(usage: StepUsage): number | undefined {
  if (usage.costKnown === false) return undefined
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
    stepExecutionId:
      typeof p.stepExecutionId === "string" && p.stepExecutionId ? p.stepExecutionId : undefined,
    inputTokens: num(p.inputTokens),
    outputTokens: num(p.outputTokens),
    totalTokens: num(p.totalTokens) || num(p.inputTokens) + num(p.outputTokens),
    cacheReadTokens: num(p.cacheReadTokens),
    cacheCreationTokens: num(p.cacheCreationTokens),
    providerId: typeof p.providerId === "string" ? p.providerId : undefined,
    modelId: typeof p.modelId === "string" ? p.modelId : undefined,
    costUsd: typeof p.costUsd === "number" && Number.isFinite(p.costUsd) ? p.costUsd : undefined,
    ...(typeof p.costKnown === "boolean" ? { costKnown: p.costKnown } : {}),
  }
}

/** Stable within one run; legacy reports have no execution identity. */
export function stepUsageKey(stepId: string, usage: Pick<StepUsage, "stepExecutionId">): string {
  return JSON.stringify([stepId, usage.stepExecutionId ?? null])
}

/** The token part of a step's usage, as a billing row books it. */
export interface StepUsageTokens {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * A node's usage report as the host runtime reads it. `bookedElsewhere` is the
 * part a ledger already wrote as its own rows (Router + Fusion's ledgered
 * calls, a Fusion run): the step's billing row books only the rest, so the
 * same call is never counted twice (F28). The run's own `step_usage` event
 * still carries the whole usage for the Runs UI.
 */
export interface HostStepUsage extends StepUsage {
  bookedElsewhere?: StepUsageTokens
}

/** `usage` less what a ledger booked, or `null` when nothing is left to book. */
export function unbookedStepUsage(usage: HostStepUsage): StepUsageTokens | null {
  const booked = usage.bookedElsewhere
  const left: StepUsageTokens = {
    inputTokens: Math.max(0, usage.inputTokens - (booked?.inputTokens ?? 0)),
    outputTokens: Math.max(0, usage.outputTokens - (booked?.outputTokens ?? 0)),
    cacheReadTokens: Math.max(0, (usage.cacheReadTokens ?? 0) - (booked?.cacheReadTokens ?? 0)),
    cacheCreationTokens: Math.max(
      0,
      (usage.cacheCreationTokens ?? 0) - (booked?.cacheCreationTokens ?? 0)
    ),
  }
  if (!booked) return left
  return left.inputTokens + left.outputTokens + left.cacheReadTokens! + left.cacheCreationTokens! >
    0
    ? left
    : null
}
