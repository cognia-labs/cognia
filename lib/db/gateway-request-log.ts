/**
 * CRUD layer for the `gatewayRequestLog` Dexie table (v99) — the inbound LLM
 * gateway's durable request log (ADR-0043).
 *
 * The Rust gateway emits one `gateway://request-log` event per request
 * (success, upstream failure, or middleware rejection); `GatewayProvider`
 * persists each here so the Settings "Logs" view survives a restart and can be
 * filtered/aggregated — the newapi "Logs" page equivalent.
 *
 * Capped ([`GATEWAY_REQUEST_LOG_CAP`]); oldest rows are trimmed on insert so a
 * chatty client can't grow it unbounded.
 */

import { getDb } from "./schema"
import type { GatewayRequestLogRow } from "@/types/gateway"

/** Keep at most this many rows; oldest are trimmed on insert. */
export const GATEWAY_REQUEST_LOG_CAP = 5000

export interface GatewayRequestLogFilter {
  /** Substring match on the requested model/alias id. */
  model?: string
  /** Exact key id. */
  keyId?: string
  /** Exact gateway-derived session id; never a substring match. */
  sessionId?: string
  /** `"errors"` = status ≥ 400; `"ok"` = status < 400; default = all. */
  outcome?: "ok" | "errors"
  limit?: number
}

export async function appendGatewayRequestLog(row: GatewayRequestLogRow): Promise<void> {
  const db = getDb()
  await db.gatewayRequestLog.put(row)
  const count = await db.gatewayRequestLog.count()
  if (count > GATEWAY_REQUEST_LOG_CAP) {
    const overflow = count - GATEWAY_REQUEST_LOG_CAP
    const oldest = await db.gatewayRequestLog.orderBy("at").limit(overflow).primaryKeys()
    await db.gatewayRequestLog.bulkDelete(oldest)
  }
}

/** Rows newest-first, applying the given filters in memory after the fetch. */
export async function listGatewayRequestLog(
  filter: GatewayRequestLogFilter = {}
): Promise<GatewayRequestLogRow[]> {
  const limit = filter.limit ?? 200
  // Filter before limiting: a quiet session can be older than hundreds of
  // unrelated requests. The capped table bounds the scan without truncating
  // a filtered page to an arbitrary newest-first window.
  const collection = getDb().gatewayRequestLog.orderBy("at").reverse()
  const filtered = Boolean(
    filter.outcome || filter.keyId || filter.sessionId?.trim() || filter.model?.trim()
  )
  return (filtered ? collection.filter(requestLogPredicate(filter)) : collection)
    .limit(limit)
    .toArray()
}

/** Pure filter — extracted so it's unit-testable without a DB. */
export function filterGatewayRequestLog(
  rows: GatewayRequestLogRow[],
  filter: GatewayRequestLogFilter
): GatewayRequestLogRow[] {
  return rows.filter(requestLogPredicate(filter))
}

function requestLogPredicate(filter: GatewayRequestLogFilter) {
  const needle = filter.model?.trim().toLowerCase()
  const sessionId = filter.sessionId?.trim()
  return (r: GatewayRequestLogRow): boolean => {
    if (filter.outcome === "errors" && r.status < 400) return false
    if (filter.outcome === "ok" && r.status >= 400) return false
    if (filter.keyId && r.keyId !== filter.keyId) return false
    if (sessionId && r.sessionId !== sessionId) return false
    if (needle && !(r.model ?? "").toLowerCase().includes(needle)) return false
    return true
  }
}

export interface GatewayRequestSessionGroup {
  sessionId: string | null
  /** Same grouping key written by forwardGatewayOutcome into sessionUsage. */
  usageSessionId: string | null
  rows: GatewayRequestLogRow[]
}

/** Retain newest-first group/row order and keep legacy unidentified rows visible. */
export function groupGatewayRequestsBySession(
  rows: readonly GatewayRequestLogRow[]
): GatewayRequestSessionGroup[] {
  const groups = new Map<string | null, GatewayRequestSessionGroup>()
  for (const row of rows) {
    const sessionId = row.sessionId || null
    let group = groups.get(sessionId)
    if (!group) {
      group = { sessionId, usageSessionId: sessionId ? `gateway:${sessionId}` : null, rows: [] }
      groups.set(sessionId, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()]
}

export async function clearGatewayRequestLog(): Promise<void> {
  await getDb().gatewayRequestLog.clear()
}

export interface GatewayUsageSummary {
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  avgLatencyMs: number
}

/** Aggregate a set of rows for the "usage" tiles. Pure + testable. */
export function summarizeGatewayUsage(rows: GatewayRequestLogRow[]): GatewayUsageSummary {
  if (rows.length === 0) {
    return { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, avgLatencyMs: 0 }
  }
  let errors = 0
  let inputTokens = 0
  let outputTokens = 0
  let latency = 0
  for (const r of rows) {
    if (r.status >= 400) errors += 1
    inputTokens += r.inputTokens ?? 0
    outputTokens += r.outputTokens ?? 0
    latency += r.latencyMs
  }
  return {
    requests: rows.length,
    errors,
    inputTokens,
    outputTokens,
    avgLatencyMs: Math.round(latency / rows.length),
  }
}

/** One key's rolled-up usage over the loaded log window. */
export interface GatewayKeyUsage {
  keyId: string
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
}

/**
 * Group the log rows by their calling key id → per-key usage totals. Rows with
 * no `keyId` (middleware rejections before auth) are skipped. Pure + testable;
 * drives the per-key usage surface in the log viewer and keys card.
 */
export function summarizePerKeyUsage(rows: GatewayRequestLogRow[]): Map<string, GatewayKeyUsage> {
  const byKey = new Map<string, GatewayKeyUsage>()
  for (const r of rows) {
    if (!r.keyId) continue
    const entry = byKey.get(r.keyId) ?? {
      keyId: r.keyId,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    entry.requests += 1
    if (r.status >= 400) entry.errors += 1
    entry.inputTokens += r.inputTokens ?? 0
    entry.outputTokens += r.outputTokens ?? 0
    byKey.set(r.keyId, entry)
  }
  return byKey
}
