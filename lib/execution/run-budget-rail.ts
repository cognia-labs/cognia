/**
 * The execution side of the ADR-0243 run ledger: a rail (sidecar turn,
 * in-process completion, external engine, workflow model call) reserves just
 * before its request leaves, caps what it sends by the hold, and settles when
 * it has proof the execution stopped.
 */
import type { RunBudgetAmountsV1 } from "@/types/execution/run"
import type { LlmClient, LlmClientCallOptions, UsageDelta } from "@/lib/twin/distill/llm"
import {
  costFromTokensUsd,
  resolveModelPricingUsd,
  tokenAllowanceForUsd,
  type ResolvePricingOptions,
} from "@/lib/usage/pricing"
import { estimateTokens } from "@cognia/router-fusion"

import { reserveRunBudget, RunBudgetError, type RunBudgetCaps } from "./run-ledger"

/** Usage as rails meter it. Missing fields are unknown, not zero. */
export interface MeteredUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
}

export interface RailModel {
  providerId?: string
  modelId: string
}

function known(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

/** Tokens and USD a metered usage spent. A field it cannot tell is left out. */
export function priceMeteredUsage(
  usage: MeteredUsage,
  model: RailModel,
  pricing?: ResolvePricingOptions
): RunBudgetAmountsV1 {
  const split = known(usage.inputTokens) && known(usage.outputTokens)
  const tokens = split
    ? usage.inputTokens! +
      usage.outputTokens! +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0)
    : undefined
  const price = split ? resolveModelPricingUsd(model.providerId, model.modelId, pricing) : null
  const costUsd = known(usage.costUsd)
    ? usage.costUsd
    : price
      ? costFromTokensUsd(
          {
            inputTokens: usage.inputTokens!,
            outputTokens: usage.outputTokens!,
            cacheReadInputTokens: usage.cacheReadTokens ?? 0,
            cacheCreationInputTokens: usage.cacheCreationTokens ?? 0,
          },
          price
        )
      : undefined
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

export interface RailBudget {
  /** Aborts at the hold's deadline as well as on the caller's signal. */
  readonly signal: AbortSignal
  readonly deadlineAt?: number
  /** Tokens the hold buys, after converting USD: the request's ceiling. */
  readonly tokens?: number
  report(usage: MeteredUsage): Promise<void>
  /**
   * Report the running usage of an execution the rail cannot cap per request,
   * and abort it with `budget_exhausted` once that reaches the hold.
   */
  observe(usage: MeteredUsage): Promise<void>
  /** Settle once. Without stop proof, or without usage, the whole hold is charged. */
  finish(usage: MeteredUsage | undefined, confirmedStopped: boolean): Promise<void>
}

/** This Host's pricing settings, when its settings store is loaded. */
export async function currentPricingSettings(): Promise<ResolvePricingOptions> {
  try {
    const { useSettingsStore } = await import("@/stores/settings")
    const settings = useSettingsStore.getState().settings
    return settings ? { settings } : {}
  } catch {
    return {}
  }
}

/**
 * Reserve for one execution of `runId`. `undefined` when its tree has no
 * budget: the rail then runs exactly as it did without one.
 */
export async function beginRailBudget(
  runId: string | undefined,
  model: RailModel,
  options: { caps?: RunBudgetCaps; signal?: AbortSignal; pricing?: ResolvePricingOptions } = {}
): Promise<RailBudget | undefined> {
  if (!runId) return undefined
  const pricing = options.pricing ?? (await currentPricingSettings())
  const hold = await reserveRunBudget(runId, {
    model,
    pricing,
    ...(options.caps ? { caps: options.caps } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!hold) return undefined
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timer =
    hold.deadlineAt === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new RunBudgetError("deadline_exceeded")),
          Math.max(0, hold.deadlineAt - Date.now())
        )
  const price = (usage: MeteredUsage) => priceMeteredUsage(usage, model, pricing)
  const bought =
    hold.amounts.costUsd === undefined
      ? undefined
      : tokenAllowanceForUsd(hold.amounts.costUsd, model, pricing)
  const tokens = Math.min(hold.amounts.tokens ?? Infinity, bought ?? Infinity)
  return {
    signal: controller.signal,
    ...(hold.deadlineAt !== undefined ? { deadlineAt: hold.deadlineAt } : {}),
    ...(Number.isFinite(tokens) ? { tokens } : {}),
    report: async (usage) => {
      await hold.report(price(usage))
    },
    async observe(usage) {
      const spent = price(usage)
      const exhausted = (limit: RunBudgetAmountsV1) =>
        (["tokens", "costUsd"] as const).some(
          (field) => limit[field] !== undefined && (spent[field] ?? 0) >= limit[field]!
        )
      if (exhausted(hold.amounts)) controller.abort(new RunBudgetError("budget_exhausted"))
      // What it may still spend itself shrinks by what children borrowed from it.
      const own = await hold.report(spent)
      if (exhausted(own)) controller.abort(new RunBudgetError("budget_exhausted"))
    },
    async finish(usage, confirmedStopped) {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      await hold.finish(usage ? price(usage) : undefined, confirmedStopped)
    },
  }
}

/**
 * Each call of `client` reserves from `runId`'s tree ledger, asks for no more
 * output than the hold buys, and settles with the call's own usage. Without a
 * budget the call is untouched.
 */
export function budgetedLlmClient(client: LlmClient, runId: string, model: RailModel): LlmClient {
  const begin = async (prompt: string, options: LlmClientCallOptions | undefined) => {
    const budget = await beginRailBudget(
      runId,
      model,
      options?.abortSignal ? { signal: options.abortSignal } : {}
    )
    if (!budget) return { options, finish: async () => undefined }
    let usage: UsageDelta | undefined
    // The prompt is read too: a token allowance spent on output alone let a
    // 10-token prompt and a 3-token answer through a 3-token cap.
    const tokens =
      budget.tokens === undefined
        ? undefined
        : budget.tokens - estimateTokens(`${options?.system ?? ""}\n${prompt}`)
    if (tokens !== undefined && tokens < 1) {
      // Nothing was sent: the hold is settled at nothing, not charged whole.
      await budget.finish({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, true)
      throw new RunBudgetError("budget_exhausted")
    }
    return {
      options: {
        ...options,
        abortSignal: budget.signal,
        // A retry would spend outside this one call's hold.
        maxRetries: 0,
        ...(tokens !== undefined
          ? { maxTokens: Math.max(1, Math.min(options?.maxTokens ?? Infinity, Math.floor(tokens))) }
          : {}),
        onUsage: (value: UsageDelta) => {
          usage = value
          options?.onUsage?.(value)
        },
      },
      finish: (answered: boolean) => budget.finish(answered ? usage : undefined, answered),
    }
  }
  return {
    ...client,
    async complete(prompt, options) {
      const call = await begin(prompt, options)
      let answered = false
      try {
        const text = await client.complete(prompt, call.options)
        answered = true
        return text
      } finally {
        await call.finish(answered)
      }
    },
    ...(client.stream
      ? {
          async *stream(prompt: string, options?: LlmClientCallOptions) {
            const call = await begin(prompt, options)
            let answered = false
            try {
              yield* client.stream!(prompt, call.options)
              answered = true
            } finally {
              await call.finish(answered)
            }
          },
        }
      : {}),
  }
}
