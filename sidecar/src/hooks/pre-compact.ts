import { errorMessage } from "./kernel/types.ts"
export interface PreCompactContext {
  sessionId: string
  messageCount: number
  tokenCount: number
  compressionRatio: number | undefined
}
export interface PreCompactDecision {
  skip: boolean
  contextToInject: string | undefined
  strategyOverride: string | undefined
  source: "plugin" | "fallback"
}
export interface PreCompactRequest {
  hookId: string
  payload: PreCompactContext
  timeoutMs?: number
}
export interface PreCompactOptions {
  log?: (level: string, message: string) => void
  pluginHookBridge?: (request: PreCompactRequest) => Promise<unknown>
}

/**
 * Dynamic compaction seam — wires the renderer's `dispatchPreCompact` plugin
 * hook result into the sidecar's compaction path. The sidecar (where
 * compaction runs) cannot import `lib/`, so the decision crosses the wire.
 *
 * ## Protocol
 *
 * It rides the same renderer round-trip the `{ type: "plugin" }` hook handler
 * uses (`./plugin-hook-exec.ts`); `host_rpc` cannot carry it, because Rust
 * answers that frame itself and never forwards it to the renderer:
 *   1. sidecar emits { type: "plugin_hook_exec", sessionId, execId,
 *      pluginId: "*", hookId: "onPreCompact", payload }
 *   2. Rust's default branch forwards it on SIDECAR_EVENT (no special case)
 *   3. the renderer dispatches to every plugin and answers
 *   4. Rust writes { type: "plugin_hook_response", … } to the sidecar stdin
 *   5. sidecar reads the result and adjusts the compaction plan accordingly
 *
 * Wire params match the existing `PreCompactContext`:
 *   { sessionId, messageCount, tokenCount, compressionRatio }
 *
 * Wire result matches the existing `PreCompactResult`:
 *   { skipCompaction?, contextToInject?, customStrategy? }
 *
 * Fallback: when the bridge times out, errors, or is absent (headless), the
 * compaction falls back to the already-selected built-in strategy — the plugin
 * decision is NEVER required for compaction to proceed.
 */

// The timeout for the pre-compact host callback. Plugins that take too long
// lose their vote rather than blocking the model turn indefinitely.
export const PRE_COMPACT_TIMEOUT_MS = 5_000

/**
 * Wire shapes of the renderer's `PreCompactContext` / `PreCompactResult`
 * (types/plugin/plugin-hooks.ts). Declared here because the sidecar type-checks
 * standalone and cannot reach the app's `@/` aliases.
 *
 * @typedef {object} PreCompactContext
 * @property {string} sessionId
 * @property {number} messageCount
 * @property {number} tokenCount
 * @property {number} compressionRatio
 *
 * @typedef {object} PreCompactResult
 * @property {string} [contextToInject] - context to inject into the compressed summary
 * @property {boolean} [skipCompaction] - skip compaction entirely
 * @property {"aggressive" | "moderate" | "minimal"} [customStrategy] - compression strategy override
 */

/**
 * @typedef {object} PreCompactDecision
 * @property {boolean} skip - true iff a plugin requested skipping compaction
 * @property {string | undefined} contextToInject - bounded context to prepend to the summary
 * @property {string | undefined} strategyOverride - mapped strategy name
 * @property {"plugin" | "fallback"} source - whether the decision came from a plugin or fell back
 */

/** Max length for injected context (prevents plugin abuse / unbounded growth). */
const MAX_INJECT_LENGTH = 4096

/**
 * Map the legacy `customStrategy` values from PreCompactResult to the
 * CompressionStrategy names the sidecar's planStrategy() accepts.
 *
 * The legacy `"aggressive" | "moderate" | "minimal"` enum predates the unified
 * strategy registry. We map them to the closest built-in strategies and emit a
 * deprecation event. New plugins should use `strategyId` from the registry.
 *
 * @param {string | undefined} legacy
 * @returns {string | undefined}
 */
function mapLegacyStrategy(legacy: unknown): string | undefined {
  if (!legacy) return undefined
  switch (legacy) {
    case "aggressive":
      return "recursive"
    case "moderate":
      return "selective"
    case "minimal":
      return "sliding-window"
    default:
      return undefined
  }
}

/**
 * Validate and clamp a PreCompactResult from the host_rpc callback.
 * Returns a safe decision object regardless of what the plugin returned.
 *
 * @param {unknown} raw
 * @returns {PreCompactDecision}
 */
export function validatePreCompactResult(raw: unknown): PreCompactDecision {
  const fallback: PreCompactDecision = {
    skip: false,
    contextToInject: undefined,
    strategyOverride: undefined,
    source: "fallback",
  }
  if (!raw || typeof raw !== "object") return fallback

  const result = raw as Record<string, unknown>
  const skip = result.skipCompaction === true
  let contextToInject: string | undefined
  if (typeof result.contextToInject === "string" && result.contextToInject.length > 0) {
    contextToInject = result.contextToInject.slice(0, MAX_INJECT_LENGTH)
  }
  const strategyOverride = mapLegacyStrategy(/** @type {string|undefined} */ result.customStrategy)

  return { skip, contextToInject, strategyOverride, source: "plugin" }
}

/**
 * Call the host's preCompact hook and return the decision.
 * Falls back gracefully on timeout, error, or unavailability.
 *
 * @param {PreCompactContext} context
 * @param {{ log?: (level: string, msg: string) => void, pluginHookBridge?: (req: {hookId: string, payload: unknown, timeoutMs?: number}) => Promise<unknown> }} [opts]
 * @returns {Promise<PreCompactDecision>}
 */
export async function queryPreCompactDecision(
  context: PreCompactContext,
  opts: PreCompactOptions = {}
): Promise<PreCompactDecision> {
  const log = opts.log ?? (() => {})
  const fallback: PreCompactDecision = {
    skip: false,
    contextToInject: undefined,
    strategyOverride: undefined,
    source: "fallback",
  }

  // The renderer bridge is supplied through `opts`; without it (headless, or a
  // rail with no renderer) compaction proceeds on its built-in strategy.
  const bridge = opts.pluginHookBridge
  if (typeof bridge !== "function") {
    return fallback
  }

  try {
    const raw = await bridge({
      hookId: "onPreCompact",
      payload: context,
      timeoutMs: PRE_COMPACT_TIMEOUT_MS,
    })
    const decision = validatePreCompactResult(raw)
    if (decision.skip) {
      log("info", `preCompact plugin requested skip (session ${context.sessionId})`)
    }
    if (decision.contextToInject) {
      log("info", `preCompact plugin injecting ${decision.contextToInject.length} chars`)
    }
    if (decision.strategyOverride) {
      log("info", `preCompact plugin overriding strategy to "${decision.strategyOverride}"`)
    }
    return decision
  } catch (err) {
    // Timeout / unavailable / renderer not connected — all fall back silently.
    log("warn", `preCompact host callback failed: ${errorMessage(err)}; using built-in strategy`)
    return fallback
  }
}
