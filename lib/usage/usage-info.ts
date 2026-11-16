/**
 * Turning reported token accounting into the renderer's {@link UsageInfo}:
 * external agents' turn usage, the snake_case usage block the sidecar puts on
 * an SDK `result` message, and canonical `usage` events of either spelling.
 *
 * Kept apart from `lib/usage/context-usage.ts` (context-window sizing and
 * occupancy) so accounting readers do not pull the model-window table.
 */

import type { UsageInfo } from "@/lib/claude/adapter"

/**
 * Map an external agent's turn accounting onto the renderer's {@link UsageInfo}.
 *
 * Shared by the GUI chat lane and the CLI TUI (`external-event-mapper`) so the
 * two cannot drift. Three rules, all about not inventing figures:
 *
 * - `contextTokens` / `contextWindow` are carried through untouched. They are
 *   OCCUPANCY and window size as the agent itself reported them (ACP
 *   `usage_update.size`, Codex `modelContextWindow`) and outrank this build's
 *   model table, which may not know the agent's model at all.
 * - Absent fields stay absent. A missing cache count is not a zero.
 * - `providerCost` becomes `totalCostUsd` only when the provider named USD.
 *   OpenCode returns a bare number with no currency; relabelling that as
 *   dollars would put a fabricated unit into the session cost.
 */
export function externalTokenUsageToUsageInfo(usage: {
  promptTokens: number
  promptTokensIncludeCache?: boolean
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  contextTokens?: number
  modelContextWindow?: number
  providerCost?: { amount: number; currency?: string }
}): UsageInfo {
  return {
    // The renderer prices uncached input and cache buckets separately. DSH
    // explicitly reports aggregate prompt counts; do not infer other channels.
    inputTokens: usage.promptTokensIncludeCache
      ? Math.max(
          0,
          usage.promptTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0)
        )
      : usage.promptTokens,
    outputTokens: usage.completionTokens,
    ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
    ...(usage.modelContextWindow === undefined ? {} : { contextWindow: usage.modelContextWindow }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheCreationInputTokens: usage.cacheWriteTokens }),
    ...(usage.providerCost && usage.providerCost.currency === "USD"
      ? { totalCostUsd: usage.providerCost.amount }
      : {}),
    ...(usage.providerCost === undefined ? {} : { providerCost: usage.providerCost }),
  }
}

/**
 * Read a provider usage block in the snake_case shape the sidecar puts on an
 * SDK `result` message (`input_tokens`, `cache_read_input_tokens`, …) into
 * {@link UsageInfo}. `top` carries the result's own cost and duration. Returns
 * `null` when nothing at all was reported.
 */
export function usageInfoFromUsageBlock(
  raw: Record<string, unknown> | undefined,
  top: { totalCostUsd?: number; durationMs?: number } = {}
): UsageInfo | null {
  if (!raw && top.totalCostUsd === undefined) return null

  const num = (k: string) => {
    if (!raw) return undefined
    const v = raw[k]
    return typeof v === "number" ? v : undefined
  }

  const reasoning = num("reasoning_tokens")
  const contextInput = num("context_input_tokens")

  // Cache-TTL split and server-tool counters, emitted by the shared usage
  // normalizer (`lib/ai/chat/usage-normalize.ts` and its sidecar mirror). Both
  // are absent unless the provider actually reported them, so "no 1-hour
  // writes" stays distinguishable from "TTL not reported".
  const cacheCreationDetail = raw?.cache_creation as
    { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined
  const positive = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined

  const rawServerToolUse = raw?.server_tool_use as Record<string, unknown> | undefined
  let serverToolUse: Record<string, number> | undefined
  if (rawServerToolUse && typeof rawServerToolUse === "object") {
    const counts: Record<string, number> = {}
    for (const [tool, value] of Object.entries(rawServerToolUse)) {
      const n = positive(value)
      if (n !== undefined) counts[tool] = n
    }
    if (Object.keys(counts).length > 0) serverToolUse = counts
  }

  const info: UsageInfo = {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    // Measured window occupancy (ai-sdk channel: last call's prompt + output).
    // `tokensInWindow` prefers it to summing the billing fields.
    contextTokens: num("context_tokens"),
    // Only attach when the channel reported a window-prompt size that differs
    // from the (cumulative) input — i.e. the ai-sdk agent-loop path.
    contextInputTokens:
      typeof contextInput === "number" && contextInput !== num("input_tokens")
        ? contextInput
        : undefined,
    cacheCreationInputTokens: num("cache_creation_input_tokens"),
    cacheReadInputTokens: num("cache_read_input_tokens"),
    cacheCreation5mInputTokens: positive(cacheCreationDetail?.ephemeral_5m_input_tokens),
    cacheCreation1hInputTokens: positive(cacheCreationDetail?.ephemeral_1h_input_tokens),
    serverToolUse,
    // Only attach when the provider actually reported reasoning tokens (> 0) so
    // non-reasoning turns don't carry a noisy `reasoningTokens: 0`.
    reasoningTokens: typeof reasoning === "number" && reasoning > 0 ? reasoning : undefined,
    totalCostUsd: typeof top.totalCostUsd === "number" ? top.totalCostUsd : undefined,
    durationMs: typeof top.durationMs === "number" ? top.durationMs : undefined,
  }
  // Drop fully-empty objects rather than attaching a placeholder.
  if (Object.values(info).every((v) => v === undefined)) return null
  return info
}

/** Camel-case {@link UsageInfo} fields that mark a block as already converted. */
const USAGE_INFO_NUMBER_FIELDS = [
  "inputTokens",
  "outputTokens",
  "contextTokens",
  "contextWindow",
  "contextInputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "reasoningTokens",
  "totalCostUsd",
  "durationMs",
] as const

/**
 * A canonical `usage` event's block as {@link UsageInfo}. The contract leaves
 * the block's shape open: the built-in sidecar forwards its `result` usage in
 * snake_case, while the CLI's capture stream and external agents emit
 * camel-case. A consumer that typed the raw block as `UsageInfo` read every
 * sidecar figure as missing and showed a completed turn as 0 tokens.
 */
export function usageInfoFromRecord(raw: Record<string, unknown>): UsageInfo | null {
  if (USAGE_INFO_NUMBER_FIELDS.some((key) => typeof raw[key] === "number")) {
    return { ...raw } as UsageInfo
  }
  return usageInfoFromUsageBlock(raw)
}
