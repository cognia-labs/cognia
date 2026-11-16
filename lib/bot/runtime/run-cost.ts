/**
 * What one Bot run's model invocations cost, for its run detail.
 *
 * Every model invocation a run makes records what it cost as its own
 * completed step (`__host:cost:<invocation step>`), so a replayed invocation
 * never shows twice and the run's spend is a sum over its steps.
 *
 * The `maxRunCostUsd` ceiling itself is the run tree's ledger
 * (`lib/execution/run-ledger.ts`), where each invocation reserves before it
 * starts. A ceiling with no known price is refused there rather than guessed
 * at: pricing an unknown model at $0 would make any ceiling a no-op.
 */

import { completeBotRunStep, listBotRunSteps } from "@/lib/db/bot-run-steps"
import {
  costFromTokensUsd,
  resolveModelPricingUsd,
  type ResolvePricingOptions,
} from "@/lib/usage/pricing"
import type { ExternalAgentResult } from "@/types/agent/external-agent"

/** Prefix of the per-invocation cost steps. Reserved (`__host:`), plugin-unwritable. */
export const BOT_RUN_COST_STEP_PREFIX = "__host:cost:"

export interface BotRunInvocationCost {
  /** USD for this invocation; `null` when it could not be priced. */
  costUsd: number | null
  /** Where the figure came from. */
  source: "provider" | "pricing" | "unknown"
  inputTokens: number
  outputTokens: number
}

export interface BotRunCostSummary {
  spentUsd: number
  /** Invocations whose cost is unknown; their spend is not in `spentUsd`. */
  unpricedInvocations: number
  invocations: number
}

export class BotRunPricingUnknownError extends Error {
  readonly code = "pricing_unknown"
  constructor(readonly modelId: string) {
    super(
      `No price is known for model "${modelId}", so the installation's cost ceiling cannot be ` +
        "enforced; choose a priced model or remove the ceiling"
    )
    this.name = "BotRunPricingUnknownError"
  }
}

type TokenUsage = ExternalAgentResult["tokenUsage"]

/**
 * Price one invocation's usage. A provider-reported USD cost wins (it already
 * includes whatever the provider bills); otherwise the shared pricing table.
 */
export function priceBotInvocation(
  usage: TokenUsage,
  model: { providerId?: string; modelId: string },
  opts: ResolvePricingOptions = {}
): BotRunInvocationCost {
  const inputTokens = usage?.promptTokens ?? 0
  const outputTokens = usage?.completionTokens ?? 0
  const provider = usage?.providerCost
  // A figure with no currency has an unknown unit (OpenCode reports a bare
  // number); only an explicit USD amount stands in for pricing.
  if (
    provider &&
    Number.isFinite(provider.amount) &&
    provider.amount >= 0 &&
    provider.currency?.toUpperCase() === "USD"
  ) {
    return { costUsd: provider.amount, source: "provider", inputTokens, outputTokens }
  }
  if (!usage) return { costUsd: null, source: "unknown", inputTokens, outputTokens }
  const pricing = resolveModelPricingUsd(model.providerId, model.modelId, opts)
  if (!pricing) return { costUsd: null, source: "unknown", inputTokens, outputTokens }
  const costUsd = costFromTokensUsd(
    {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: usage.cacheReadTokens ?? 0,
      cacheCreationInputTokens: usage.cacheWriteTokens ?? 0,
    },
    pricing
  )
  return { costUsd, source: "pricing", inputTokens, outputTokens }
}

export async function recordBotInvocationCost(
  runId: string,
  invocationStep: string,
  cost: BotRunInvocationCost
): Promise<void> {
  await completeBotRunStep(runId, `${BOT_RUN_COST_STEP_PREFIX}${invocationStep}`, cost)
}

export async function summarizeBotRunCost(runId: string): Promise<BotRunCostSummary> {
  const steps = await listBotRunSteps(runId)
  let spentUsd = 0
  let unpricedInvocations = 0
  let invocations = 0
  for (const step of steps) {
    if (step.status !== "completed" || !step.name.startsWith(BOT_RUN_COST_STEP_PREFIX)) continue
    invocations += 1
    const cost = step.output as BotRunInvocationCost
    if (typeof cost?.costUsd === "number") spentUsd += cost.costUsd
    else unpricedInvocations += 1
  }
  return { spentUsd, unpricedInvocations, invocations }
}
