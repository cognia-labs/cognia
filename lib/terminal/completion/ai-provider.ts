/**
 * Built-in AI completion provider — the GitHub-Copilot-style brain.
 *
 * It builds a shell-aware prompt from the current context, runs it through
 * the injected `LlmClient`, sanitises the model's reply into a single
 * full command line, and returns it as an `ai`-sourced suggestion.
 *
 * Privacy + cost guards (ADR-0039):
 *  - **PII gate**: the assembled context is checked with `hasNoLeakingPii`
 *    before any model call. If the partial command, cwd, or recent history
 *    contains an API key / token / credential / email / card / etc., the
 *    call is skipped silently — terminal context never leaks to the model.
 *  - **Cache**: results are memoised by (shell, cwd, input) with a short
 *    TTL so backspacing/retyping a prefix doesn't re-bill the model. A
 *    `null` (no useful completion) is cached too, so dud prefixes aren't
 *    retried on every keystroke.
 *  - **Cancellation**: `LlmClient.complete` can't be aborted mid-flight,
 *    but if the caller's signal aborts before it resolves the result is
 *    discarded (no stale ghost text).
 *
 * The provider is a *factory* taking its `LlmClient` via a resolver so the
 * settings/session wiring lives in the React hook, and tests can inject a
 * stub model.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { buildCompletionPrompt, sanitizeCompletion } from "./prompt"
import type {
  TerminalCompletionContext,
  TerminalCompletionProvider,
  TerminalCompletionSuggestion,
} from "./types"

export const AI_PROVIDER_ID = "builtin:ai"
const CACHE_TTL_MS = 30_000
const CACHE_MAX = 64
const AI_SCORE = 0.7

export interface AiCompletionDeps {
  /** Resolve the LlmClient for the current session/settings, or null. */
  getClient: () => LlmClient | null
  /** PII gate. Defaults to the shared `hasNoLeakingPii`. */
  isPiiSafe?: (text: string) => boolean
  /** Clock injection for cache TTL (tests). Defaults to `Date.now`. */
  now?: () => number
}

interface CacheEntry {
  /** Sanitised full command line, or null for "no useful completion". */
  value: string | null
  at: number
}

const cache = new Map<string, CacheEntry>()

/** The instructions are part of the key, so a customized prompt never reuses an old answer. */
function cacheKey(ctx: TerminalCompletionContext, system: string): string {
  return `${system}\u0000${ctx.shellPath}\u0000${ctx.cwd ?? ""}\u0000${ctx.input}`
}

function readCache(key: string, now: number): CacheEntry | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return hit
}

function writeCache(key: string, value: string | null, now: number): void {
  // Simple FIFO bound — drop the oldest insert when full.
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { value, at: now })
}

function toSuggestions(value: string | null): TerminalCompletionSuggestion[] {
  if (!value) return []
  return [{ text: value, source: "ai", providerId: AI_PROVIDER_ID, score: AI_SCORE }]
}

export function createAiCompletionProvider(deps: AiCompletionDeps): TerminalCompletionProvider {
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii
  const clock = deps.now ?? Date.now

  return {
    id: AI_PROVIDER_ID,
    label: "AI",
    priority: 100,
    getCompletions: async (context, signal) => {
      if (signal.aborted) return []

      const { system, prompt, recordUse } = buildCompletionPrompt(context, { record: false })
      const now = clock()
      const key = cacheKey(context, system)
      const cached = readCache(key, now)
      if (cached) return toSuggestions(cached.value)

      const client = deps.getClient()
      if (!client) return []

      // Gate the full assembled prompt body — covers input, cwd, history.
      if (!isPiiSafe(prompt)) return []

      recordUse()

      let raw: string
      try {
        raw = await client.complete(prompt, {
          system,
          temperature: 0.2,
          maxTokens: 64,
          stopSequences: ["\n"],
        })
      } catch {
        return []
      }
      if (signal.aborted) return []

      const value = sanitizeCompletion(raw, context.input)
      writeCache(key, value, clock())
      return toSuggestions(value)
    },
  }
}

/** Test-only: clear the memoisation cache between cases. */
export function __resetAiCompletionCacheForTesting(): void {
  cache.clear()
}
