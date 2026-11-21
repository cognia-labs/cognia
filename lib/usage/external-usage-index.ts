// Orchestrator for the external usage index (ADR-0165 Phase 0).
//
// Turns the registry's session sources into indexed `sessionUsage` rows so the
// ambient surfaces can answer "what did I spend across ALL my coding agents
// today". Everything it writes is `imported: true`, so none of it can move a
// Cognia budget.
//
// Scheduling policy, which is deliberately NOT a timer: a scan runs on an
// explicit refresh, on a foreground open of a surface that shows the all-tools
// scope, or when a watched source invalidates. An install whose ambient
// surfaces are all off never scans at all. CodeBurn's unconditional 30-second
// poll is exactly the cost this design refuses to pay.

import {
  getUsageSourceState,
  listUsageSourceStates,
  updateUsageSourceState,
  USAGE_SCAN_PARSER_VERSION,
  type UsageSourceStateRow,
  type UsageSourceStatus,
} from "@/lib/db/usage-source-states"
import { activeDatabaseName, getDb } from "@/lib/db/schema"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { commitUsageRows, UsageLedgerDatabaseChangedError } from "@/lib/usage/usage-ledger"
import { getSessionSources } from "@/lib/session-import/registry"
import { scanSourceUsage } from "@/lib/session-import/usage-scan"
import type {
  AgentSessionSourceAdapter,
  SessionScanInput,
  SessionSummary,
  UsageScanQuery,
} from "@/lib/session-import/types"

/** At most two sources are read at once, so a scan never saturates the disk. */
export const USAGE_SCAN_CONCURRENCY = 2

/** How long a `fresh` source is trusted before a refresh re-reads it. */
export const USAGE_SCAN_TTL_MS = 5 * 60_000

/**
 * Bounded batches one refresh will drain from a single source. Beyond this the
 * run stops with a cursor and the source is labelled `partial`, so a huge
 * corpus converges over several refreshes instead of monopolizing one.
 */
export const MAX_BATCHES_PER_REFRESH = 20

export interface ExternalScanOptions {
  /** Restrict the run to these source ids. Defaults to every registered one. */
  sourceIds?: readonly string[]
  /** Ignore the freshness TTL and re-read every source. */
  force?: boolean
  query?: UsageScanQuery
  signal?: AbortSignal
  now?: number
}

export interface ExternalScanSourceResult {
  sourceId: string
  status: UsageSourceStatus
  /** Rows written in this run (a resumed scan reports only its own slice). */
  written: number
  parsed: number
  failed: number
  /** True when the source was read to the end and its rows are authoritative. */
  complete: boolean
  skipped: "fresh" | "picker-only" | null
}

export interface ExternalScanResult {
  sources: ExternalScanSourceResult[]
  startedAt: number
  finishedAt: number
}

/**
 * Whether a source is due for a re-read.
 *
 * A `fresh` source inside its TTL is skipped, which is what makes opening the
 * tray panel repeatedly cost nothing. Anything degraded is always due: a
 * source we failed to read is precisely the one worth retrying.
 */
export function scanDue(state: UsageSourceStateRow | null, now: number, force = false): boolean {
  if (force) return true
  if (!state) return true
  if (state.parserVersion !== USAGE_SCAN_PARSER_VERSION) return true
  if (state.status !== "fresh") return true
  return now - state.lastScanAt >= USAGE_SCAN_TTL_MS
}

/**
 * Persist a scan's rows for one source, replacing exactly the upstream
 * sessions it read and retiring the ones it established are gone.
 *
 * `parsedSessions` are the sessions read in full: their old rows that the
 * scan no longer produced are deleted. `goneSessions` are sessions confirmed
 * absent upstream: all their rows go. A session in neither (not read this
 * time, a read that failed, outside the query window) keeps every row.
 * Whole-source retirement on "absent from this scan" erased history on any
 * transient failure, root that briefly did not list, or narrowed window.
 */
export async function persistScanRows(
  sourceId: string,
  rows: readonly SessionUsageRow[],
  opts: {
    parsedSessions: readonly string[]
    goneSessions?: readonly string[]
    expectDatabase?: string
  }
): Promise<{ written: number; removed: number }> {
  // The ledger's bulk door (ADR-0253 D07): these rows are imported by
  // construction and so leave the budget projection alone, but a source's
  // rows are still written, replaced and retired by the one usage writer.
  const retireSessions = [...new Set([...opts.parsedSessions, ...(opts.goneSessions ?? [])])]
  return commitUsageRows(rows, {
    ...(retireSessions.length > 0 ? { retireSource: sourceId, retireSessions } : {}),
    ...(opts.expectDatabase !== undefined ? { expectDatabase: opts.expectDatabase } : {}),
  })
}

/** Coverage window of the rows an index holds for one source. */
export function coverageOf(rows: readonly SessionUsageRow[]): {
  from: number | null
  to: number | null
} {
  let from: number | null = null
  let to: number | null = null
  for (const r of rows) {
    if (!Number.isFinite(r.at)) continue
    if (from == null || r.at < from) from = r.at
    if (to == null || r.at > to) to = r.at
  }
  return { from, to }
}

function statusFor(batch: {
  truncated: boolean
  failed: number
  degradedReason?: string | undefined
}): UsageSourceStatus {
  if (batch.degradedReason === "root-missing") return "unavailable"
  if (batch.truncated || batch.failed > 0) return "partial"
  return "fresh"
}

/** Scan one source and fold the result into its durable state. */
export async function scanOneSource(
  adapter: AgentSessionSourceAdapter,
  input: SessionScanInput,
  opts: ExternalScanOptions = {}
): Promise<ExternalScanSourceResult> {
  const now = opts.now ?? Date.now()
  const base: ExternalScanSourceResult = {
    sourceId: adapter.id,
    status: "unknown",
    written: 0,
    parsed: 0,
    failed: 0,
    complete: false,
    skipped: null,
  }

  if (adapter.pickerOnly && !input.pickedFiles?.length) {
    await updateUsageSourceState(adapter.id, {
      status: "picker-only",
      parserVersion: USAGE_SCAN_PARSER_VERSION,
      lastScanAt: now,
    })
    return { ...base, status: "picker-only", skipped: "picker-only" }
  }

  // The account this scan reads for. A switch while it runs refuses its writes
  // whole, rows and source state alike, rather than booking them elsewhere.
  const databaseName = activeDatabaseName()
  const pinned = { expectDatabase: databaseName }

  const prior = await getUsageSourceState(adapter.id)
  if (!scanDue(prior, now, opts.force)) {
    return { ...base, status: prior?.status ?? "unknown", skipped: "fresh" }
  }

  // A parser bump restarts the source: resuming an old cursor against a
  // re-parsed corpus would mix two parsers' output into one total.
  let cursor =
    prior && prior.parserVersion === USAGE_SCAN_PARSER_VERSION ? (prior.cursor ?? null) : null

  // One listing per refresh, so every batch below walks the same snapshot.
  // A source with its own `scanUsage` lists for itself.
  let listing: SessionSummary[] | undefined
  if (!adapter.scanUsage) {
    try {
      listing = await adapter.listSessions(input)
    } catch {
      listing = undefined
    }
    if (listing === undefined) {
      // The root is gone, unreadable, or the vendor changed its layout. The
      // rows already held stay: "could not look" is not "nothing there".
      await updateUsageSourceState(
        adapter.id,
        {
          status: "unavailable",
          parserVersion: USAGE_SCAN_PARSER_VERSION,
          lastScanAt: now,
          degradedReason: "root-missing",
        },
        pinned
      )
      return { ...base, status: "unavailable" }
    }
  }

  // Drain the source across bounded batches rather than in one unbounded read.
  // Each batch yields to the event loop between locators, and the batch ceiling
  // caps a single refresh so a pathological corpus cannot pin the main thread
  // indefinitely. What it costs is that such a corpus takes several refreshes
  // to converge, which the `partial` status says out loud.
  const startedFromTop = cursor === null
  const rows: SessionUsageRow[] = []
  const parsedSessions = new Set<string>()
  let parsed = 0
  let failed = 0
  let truncated = false
  let degradedReason: string | undefined
  let fingerprint = ""

  for (let batchIndex = 0; batchIndex < MAX_BATCHES_PER_REFRESH; batchIndex += 1) {
    const batch = await scanSourceUsage(
      adapter,
      input,
      { ...opts.query, signal: opts.signal ?? opts.query?.signal },
      cursor,
      listing
    )
    rows.push(...batch.rows)
    for (const id of batch.parsedSessionIds) parsedSessions.add(id)
    parsed += batch.parsed
    failed += batch.failed
    if (batch.fingerprint) fingerprint = batch.fingerprint
    if (batch.degradedReason) degradedReason = batch.degradedReason
    cursor = batch.cursor
    if (batch.cursor === null) {
      truncated = batch.truncated
      break
    }
    if (batch.degradedReason === "aborted") {
      truncated = true
      break
    }
    if (batchIndex === MAX_BATCHES_PER_REFRESH - 1) {
      truncated = true
      degradedReason = degradedReason ?? "budget"
    }
  }

  // Which held sessions are gone upstream. The generic driver knows from this
  // refresh's listing; a source with its own scan only from a run that read
  // it whole without a failure. An empty listing while rows are held proves
  // nothing (an unmounted home, a root not yet created) and retires nothing.
  const heldSessions = new Set(
    (await rowsForSource(adapter.id)).flatMap((row) =>
      row.sourceSessionId ? [row.sourceSessionId] : []
    )
  )
  let seen: Set<string> | null = null
  if (listing) {
    if (listing.length > 0 || heldSessions.size === 0) {
      seen = new Set(listing.map((summary) => summary.ref.originalSessionId))
    } else {
      degradedReason = degradedReason ?? "root-missing"
    }
  } else if (startedFromTop && cursor === null && !truncated && failed === 0) {
    seen = parsedSessions
  }
  const listed = seen
  const absentNow = listed
    ? [...heldSessions].filter((id) => !listed.has(id) && !parsedSessions.has(id))
    : []
  // Gone only when the previous listing missed it too.
  const absentBefore = new Set(listed ? (prior?.absentSessions ?? []) : [])
  const goneSessions = absentNow.filter((id) => absentBefore.has(id))
  const stillAbsent = listed
    ? absentNow.filter((id) => !absentBefore.has(id))
    : (prior?.absentSessions ?? [])

  const complete = cursor === null && !truncated && failed === 0 && listed !== null
  const { written } = await persistScanRows(adapter.id, rows, {
    parsedSessions: [...parsedSessions],
    goneSessions,
    expectDatabase: databaseName,
  })
  const status: UsageSourceStatus =
    degradedReason === "root-missing" && listed === null
      ? "unavailable"
      : statusFor({ truncated, failed, degradedReason })
  const held = await rowsForSource(adapter.id)
  const coverage = coverageOf(held)

  await updateUsageSourceState(
    adapter.id,
    {
      status,
      parserVersion: USAGE_SCAN_PARSER_VERSION,
      corpusFingerprint: fingerprint,
      coverageFromMs: coverage.from,
      coverageToMs: coverage.to,
      parsedCount: parsed,
      failedCount: failed,
      rowCount: held.length,
      lastScanAt: now,
      cursor,
      absentSessions: stillAbsent,
      ...(status === "fresh" ? { lastSuccessAt: now } : {}),
      ...(degradedReason ? { degradedReason } : {}),
    },
    pinned
  )

  return { sourceId: adapter.id, status, written, parsed, failed, complete, skipped: null }
}

async function rowsForSource(sourceId: string): Promise<SessionUsageRow[]> {
  return getDb().sessionUsage.where("sourceId").equals(sourceId).toArray()
}

/**
 * Scan every due source, at most {@link USAGE_SCAN_CONCURRENCY} at a time.
 * Never throws: a source that fails is recorded as degraded and the run
 * continues, because one broken vendor layout must not hide the other ten.
 */
export async function refreshExternalUsageIndex(
  input: SessionScanInput,
  opts: ExternalScanOptions = {}
): Promise<ExternalScanResult> {
  const startedAt = opts.now ?? Date.now()
  const databaseName = activeDatabaseName()
  const all = getSessionSources()
  const wanted = opts.sourceIds ? new Set(opts.sourceIds) : null
  const queue = all.filter((a) => !wanted || wanted.has(a.id))
  const results: ExternalScanSourceResult[] = []

  let next = 0
  const workers = Array.from(
    { length: Math.min(USAGE_SCAN_CONCURRENCY, queue.length) },
    async () => {
      for (;;) {
        if (opts.signal?.aborted) return
        const index = next
        next += 1
        if (index >= queue.length) return
        const adapter = queue[index]
        try {
          results.push(await scanOneSource(adapter, input, { ...opts, now: startedAt }))
        } catch (error) {
          results.push({
            sourceId: adapter.id,
            status: "unavailable",
            written: 0,
            parsed: 0,
            failed: 0,
            complete: false,
            skipped: null,
          })
          // A scan the account switch refused has nothing to record, and
          // certainly not in the account that is active now.
          if (error instanceof UsageLedgerDatabaseChangedError) return
          await updateUsageSourceState(
            adapter.id,
            { status: "unavailable", lastScanAt: startedAt, degradedReason: "read-failed" },
            { expectDatabase: databaseName }
          ).catch(() => null)
        }
      }
    }
  )
  await Promise.all(workers)

  results.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1))
  return { sources: results, startedAt, finishedAt: Date.now() }
}

/** Every external row currently indexed, newest first. */
export async function listExternalUsageRows(
  opts: {
    sinceMs?: number
    sourceIds?: readonly string[]
  } = {}
): Promise<SessionUsageRow[]> {
  const db = getDb()
  const rows = opts.sinceMs
    ? await db.sessionUsage.where("at").aboveOrEqual(opts.sinceMs).toArray()
    : await db.sessionUsage.toArray()
  const wanted = opts.sourceIds ? new Set(opts.sourceIds) : null
  return rows
    .filter((r) => Boolean(r.sourceId) && (!wanted || wanted.has(r.sourceId as string)))
    .sort((a, b) => b.at - a.at)
}

/** Source diagnostics for the CLI, settings, and the tray's freshness row. */
export async function describeUsageSources(): Promise<
  Array<UsageSourceStateRow & { displayName: string; supportsScan: boolean }>
> {
  const states = await listUsageSourceStates()
  const byId = new Map(states.map((s) => [s.sourceId, s]))
  return getSessionSources().map((adapter) => {
    const state = byId.get(adapter.id)
    return {
      ...(state ?? {
        sourceId: adapter.id,
        status: (adapter.pickerOnly ? "picker-only" : "unknown") as UsageSourceStatus,
        parserVersion: USAGE_SCAN_PARSER_VERSION,
        corpusFingerprint: "",
        coverageFromMs: null,
        coverageToMs: null,
        parsedCount: 0,
        failedCount: 0,
        rowCount: 0,
        lastScanAt: 0,
        lastSuccessAt: null,
      }),
      displayName: adapter.displayName,
      supportsScan: !adapter.pickerOnly,
    }
  })
}
