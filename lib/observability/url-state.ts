/**
 * URL <-> Traces-channel codec for shareable `/logs?channel=traces` links.
 *
 * Two groups of state travel in the URL, each under keys the Traces channel
 * owns outright:
 *
 *   view controls (shared by Explore and Dashboard — "what am I looking at")
 *     ?trange=1h                       relative preset
 *     ?trange=custom&tfrom=..&tto=..   absolute window (epoch ms)
 *     ?tf=<uri-encoded JSON filters>   active variable filters, when non-empty
 *
 *   explore state (Explore only — "where was I in it")
 *     ?tspan=<spanId>                  the span open in the detail pane
 *     ?tq=<text>                       the trace-list search
 *     ?terr=1                          errors-only
 *
 * Layout, thresholds and refresh cadence stay in the persisted store (they are
 * user preferences, not a view). Pure and DOM-free; the `history.replaceState`
 * wiring lives in `hooks/observability/use-observability-url-sync.ts` and
 * `hooks/observability/use-trace-explore-url-sync.ts`.
 *
 * Why `t`-prefixed keys: the Traces channel shares `/logs` with the Logs panel,
 * whose URL sync owns `from` / `to` / `view` / `session` / … . The channel used
 * to write bare `range` / `from` / `to` / `f`, so a custom trace window and a
 * Logs time filter fought over the same two params, and whichever sync wrote
 * last silently rewrote the other's view.
 */

import { RANGE_PRESETS, type RangePreset } from "./time-range"
import { isFilterEmpty, sanitizeFilters, type TraceFilters } from "./filters"

/** Every query key the Traces channel owns, by role. */
export const TRACE_URL_KEYS = {
  range: "trange",
  from: "tfrom",
  to: "tto",
  filters: "tf",
  span: "tspan",
  query: "tq",
  errorsOnly: "terr",
  /**
   * Explore vs Dashboard. Listed for completeness and so every consumer spells
   * it the same way, but NOT synced here: the sub-view lives in the log
   * workspace store and the `/logs` shell hydrates/writes it.
   */
  subView: "tview",
} as const

/** The view-control keys `useObservabilityUrlSync` reads and writes. */
export const TRACE_CONTROL_PARAMS = [
  TRACE_URL_KEYS.range,
  TRACE_URL_KEYS.from,
  TRACE_URL_KEYS.to,
  TRACE_URL_KEYS.filters,
] as const

/** The Explore-state keys `useTraceExploreUrlSync` reads and writes. */
export const TRACE_EXPLORE_PARAMS = [
  TRACE_URL_KEYS.span,
  TRACE_URL_KEYS.query,
  TRACE_URL_KEYS.errorsOnly,
] as const

export interface UrlControls {
  rangePreset: RangePreset | "custom"
  customSince: number | null
  customUntil: number | null
  filters: TraceFilters
}

function toParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === "string" ? new URLSearchParams(search) : search
}

/** Encode controls into a `URLSearchParams` under the Traces-owned keys.
 * Defaults are omitted so a pristine channel produces no params at all. */
export function encodeControls(c: UrlControls): URLSearchParams {
  const params = new URLSearchParams()
  if (c.rangePreset === "custom") {
    if (typeof c.customSince === "number" && typeof c.customUntil === "number") {
      params.set(TRACE_URL_KEYS.range, "custom")
      params.set(TRACE_URL_KEYS.from, String(c.customSince))
      params.set(TRACE_URL_KEYS.to, String(c.customUntil))
    }
  } else if (c.rangePreset !== "1h") {
    // 1h is the store default — leave it out to keep clean links clean.
    params.set(TRACE_URL_KEYS.range, c.rangePreset)
  }
  if (!isFilterEmpty(c.filters)) {
    params.set(TRACE_URL_KEYS.filters, JSON.stringify(c.filters))
  }
  return params
}

function parseFilters(raw: string | null): TraceFilters {
  if (!raw) return {}
  try {
    return sanitizeFilters(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}

/**
 * A finite epoch-ms bound, or null. `Number(null)` and `Number("")` are both
 * `0`, which is finite — reading a missing `tto` that way pinned the channel to
 * an empty 1970 window instead of ignoring the half-formed link.
 */
function parseBound(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Decode controls from a query string or `URLSearchParams`. Returns `null` when
 * no Traces view params are present at all (so the caller can skip applying
 * anything and leave the persisted store untouched).
 */
export function decodeControls(search: string | URLSearchParams): UrlControls | null {
  const params = toParams(search)
  const range = params.get(TRACE_URL_KEYS.range)
  const f = params.get(TRACE_URL_KEYS.filters)
  if (range === null && f === null) return null

  let rangePreset: RangePreset | "custom" = "1h"
  let customSince: number | null = null
  let customUntil: number | null = null

  if (range === "custom") {
    // Both bounds, both finite — or the link is half-formed and the preset
    // falls back to the default rather than inventing a window.
    const from = parseBound(params.get(TRACE_URL_KEYS.from))
    const to = parseBound(params.get(TRACE_URL_KEYS.to))
    if (from !== null && to !== null) {
      rangePreset = "custom"
      customSince = from
      customUntil = to
    }
  } else if (range !== null && RANGE_PRESETS.includes(range as RangePreset)) {
    rangePreset = range as RangePreset
  }

  return { rangePreset, customSince, customUntil, filters: parseFilters(f) }
}

/**
 * Canonical, order-independent fingerprint of the given keys in a query
 * string. The syncs compare fingerprints rather than whole query strings so a
 * write by somebody else (the shell's `channel` / `traceId`, the Logs panel's
 * own params) is never mistaken for a navigation that changed THEIR view.
 */
export function ownedParamsSignature(
  search: string | URLSearchParams,
  keys: readonly string[]
): string {
  const params = toParams(search)
  const owned = new URLSearchParams()
  for (const key of [...keys].sort()) {
    const value = params.get(key)
    if (value !== null) owned.set(key, value)
  }
  return owned.toString()
}

/**
 * Replace `owned` keys in `search` with `next`. Returns the new query string
 * WITHOUT a leading `?`. Every key outside `owned` survives untouched.
 */
export function replaceOwnedParams(
  search: string,
  owned: readonly string[],
  next: URLSearchParams
): string {
  const params = new URLSearchParams(search)
  for (const key of owned) params.delete(key)
  for (const [key, value] of next) params.set(key, value)
  return params.toString()
}

/** Explore-only state that rides the URL. */
export interface TraceExploreUrlState {
  /** Span open in the detail pane; meaningless without the shell's `traceId`. */
  spanId: string | null
  /** Trace-list search text. */
  query: string
  /** `null` = the link says nothing, so the persisted toggle stands. */
  errorsOnly: boolean | null
}

/** Encode Explore state; empty values are omitted. */
export function encodeExploreState(s: TraceExploreUrlState): URLSearchParams {
  const params = new URLSearchParams()
  if (s.spanId) params.set(TRACE_URL_KEYS.span, s.spanId)
  const query = s.query.trim()
  if (query) params.set(TRACE_URL_KEYS.query, query)
  if (s.errorsOnly) params.set(TRACE_URL_KEYS.errorsOnly, "1")
  return params
}

/** Decode Explore state. Absent keys decode to "not specified". */
export function decodeExploreState(search: string | URLSearchParams): TraceExploreUrlState {
  const params = toParams(search)
  const spanId = params.get(TRACE_URL_KEYS.span)
  const errorsRaw = params.get(TRACE_URL_KEYS.errorsOnly)
  return {
    spanId: spanId && spanId.trim() ? spanId : null,
    query: params.get(TRACE_URL_KEYS.query) ?? "",
    errorsOnly: errorsRaw === null ? null : errorsRaw === "1" || errorsRaw === "true",
  }
}
