// The ONE place a usage row and its daily budget projection are committed.
//
// Before ADR-0165 the two were written by different code on different clocks:
// `upsertSessionUsage` wrote the canonical per-turn row while
// `recordProviderOutcome` independently incremented `providerCostDaily` from
// its own estimate. The tables therefore disagreed by construction. A turn
// whose SDK cost was 0 but whose tokens were priceable landed in the rollup
// and not in the ledger. A retried turn overwrote its ledger row in place but
// added a SECOND increment to the rollup. Nothing detected either, because no
// reader ever compared them.
//
// This module makes `sessionUsage` the money and `providerCostDaily` a
// projection of it:
//
//   1. cost is resolved and FROZEN once, here, before anything is written,
//   2. the prior row (if any) is read inside the same transaction so an
//      overwrite applies a DELTA rather than a second full increment,
//   3. both tables commit together or neither does,
//   4. `imported` rows (spend paid on another machine, incl. every external
//      scan row) are written to the ledger and excluded from the projection,
//   5. the in-memory budget mirror is reconciled to the committed day total
//      rather than to an optimistic guess.
//
// The mirror is reached through an injected sink so `lib/db` and `lib/usage`
// stay free of a zustand import on the write path. `lib/usage/cost-budget-runtime.ts`
// installs the production sink at boot.

import { getDb } from "@/lib/db/schema"
import {
  buildCostDailyId,
  localDayString,
  type ProviderCostDailyRow,
} from "@/lib/db/provider-cost-daily"
import type { SessionUsageRow, UsagePriceSnapshot } from "@/lib/db/session-usage"
import { priceUsageRow, type PricingResolver } from "@/lib/usage/session-analytics"
import { resolveModelPricingUsd, type PricingSettings } from "@/lib/usage/pricing"

/** What a committed write did to the budget projection. */
export interface UsageCommitDaily {
  day: string
  providerId: string
  /** The provider's committed total for `day`, summed across its models. */
  providerTotalUsd: number
  /** Signed change this write applied. Negative when a retry got cheaper. */
  deltaUsd: number
}

export interface UsageCommitResult {
  /** The row exactly as persisted, with cost frozen. */
  row: SessionUsageRow
  /**
   * Every provider-day the write moved: the new row's bucket, and the old
   * row's when a correction moved it to another provider or day. Empty when
   * neither row counts for the budget.
   */
  dailies: UsageCommitDaily[]
  /** True when this write replaced an existing row rather than inserting one. */
  replaced: boolean
}

/**
 * A usage write started for one account database found another one active
 * when it committed (the account switched while the work was in flight). The
 * write is refused whole rather than booked into the wrong account's ledger.
 */
export class UsageLedgerDatabaseChangedError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(`usage write for database ${expected} refused: ${actual} is active`)
    this.name = "UsageLedgerDatabaseChangedError"
  }
}

function assertDatabase(db: { name: string }, expected: string | undefined): void {
  if (expected !== undefined && db.name !== expected) {
    throw new UsageLedgerDatabaseChangedError(expected, db.name)
  }
}

/**
 * Sink the committed day total is pushed to. Production wires the provider-cost
 * mirror store. Kept injectable so node-env tests exercise the transaction
 * without a React/zustand dependency.
 */
export type BudgetMirrorSink = (committed: UsageCommitDaily) => void

let mirrorSink: BudgetMirrorSink | null = null

/**
 * The user's own rates (custom-provider metadata, account-discovered model
 * pricing), read when a row is frozen. Injected for the same reason as the
 * mirror sink: the write path stays free of the settings store. Without one,
 * only the catalog layers price a row.
 */
export type UsagePricingSettingsSource = () => PricingSettings | undefined

let pricingSettingsSource: UsagePricingSettingsSource | null = null

/** Install the source of the user's pricing settings. Returns a disposer. */
export function setUsagePricingSettingsSource(
  source: UsagePricingSettingsSource | null
): () => void {
  const prior = pricingSettingsSource
  pricingSettingsSource = source
  return () => {
    pricingSettingsSource = prior
  }
}

/** The resolver a row is frozen against when the caller passes none. */
export function ledgerPricingResolver(): PricingResolver {
  let settings: PricingSettings | undefined
  try {
    settings = pricingSettingsSource?.()
  } catch {
    settings = undefined
  }
  return (providerId, modelId) =>
    resolveModelPricingUsd(providerId, modelId, settings ? { settings } : {})
}

/**
 * localStorage key marking that the one-time v218 projection rebuild has run.
 * Owned here rather than by the initializer so the ledger and its repair path
 * agree on the name without the ledger importing a React module.
 */
export const USAGE_LEDGER_RECONCILE_MARKER = "usage.ledger.reconciled.v218"

/** Install the production budget-mirror sink. Returns a disposer. */
export function setBudgetMirrorSink(sink: BudgetMirrorSink | null): () => void {
  const prior = mirrorSink
  mirrorSink = sink
  return () => {
    mirrorSink = prior
  }
}

const num = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * Resolve and FREEZE a row's cost, if it is not frozen already.
 *
 * A row that already carries `costSource` was frozen by an earlier writer and
 * is returned untouched. Everything else is priced once here, so the frozen
 * fields are set by exactly one code path instead of by each of the seven
 * `record*Usage` helpers guessing separately.
 */
export function freezeUsageCost(
  row: SessionUsageRow,
  resolve: PricingResolver = ledgerPricingResolver()
): SessionUsageRow {
  if (row.costSource !== undefined) return row
  if (row.costUsd > 0) return { ...row, costSource: "sdk", costKnown: true }
  const priced = priceUsageRow(row, resolve)
  if (priced.pricing === null)
    return { ...row, costUsd: 0, costSource: "unknown", costKnown: false }
  return {
    ...row,
    // A billed unit with no rate leaves the figure a lower bound: kept, so the
    // budget counts what is known, and marked unknown, so no reader calls it
    // the price.
    costUsd: priced.cost,
    costSource: priced.known ? "derived" : "unknown",
    costKnown: priced.known,
    priceSnapshot: snapshotOf(priced.pricing, priced.rateMultiplier),
  }
}

/** The rates a frozen cost was computed against, so it can be re-derived later. */
function snapshotOf(
  pricing: NonNullable<ReturnType<PricingResolver>>,
  rateMultiplier: number
): UsagePriceSnapshot {
  return {
    ...(pricing.promptPer1M !== undefined ? { promptPer1M: pricing.promptPer1M } : {}),
    ...(pricing.completionPer1M !== undefined ? { completionPer1M: pricing.completionPer1M } : {}),
    ...(pricing.cachedInputPer1M !== undefined
      ? { cachedInputPer1M: pricing.cachedInputPer1M }
      : {}),
    ...(pricing.cacheCreationPer1M !== undefined
      ? { cacheCreationPer1M: pricing.cacheCreationPer1M }
      : {}),
    ...(rateMultiplier !== 1 ? { rateMultiplier } : {}),
    currency: "USD",
  }
}

/**
 * True when a row contributes to the local daily budget projection.
 *
 * Imported spend never does: it was paid in another agent, often on another
 * account, and blending it in would misfire the budget gate. A row with no
 * provider or no model has nowhere to land in a `[day, provider, model]`
 * rollup, so it stays ledger-only.
 */
export function contributesToBudget(row: SessionUsageRow): boolean {
  // Inlined rather than imported from `lib/db/session-usage` so this module
  // holds only a TYPE edge back to the ledger table. `upsertSessionUsage`
  // imports `commitUsageRow`, and a second value edge in the other direction
  // would make the pair a genuine runtime cycle.
  const local = row.imported !== true
  return local && Boolean(row.providerId) && Boolean(row.model)
}

/** Signed contribution a row makes to the rollup, or zeros when it makes none. */
function rollupContribution(row: SessionUsageRow | null | undefined): {
  costUsd: number
  inputTokens: number
  outputTokens: number
  requestCount: number
  key: { day: string; providerId: string; modelId: string } | null
} {
  if (!row || !contributesToBudget(row)) {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, key: null }
  }
  // An unknown cost contributes what was priced of it: 0 when nothing was, a
  // lower bound when a billed unit had no rate. Never more than is known.
  const costUsd = Math.max(0, num(row.costUsd))
  return {
    costUsd,
    inputTokens: Math.max(0, num(row.inputTokens)),
    outputTokens: Math.max(0, num(row.outputTokens)),
    requestCount: 1,
    key: {
      day: localDayString(row.at),
      providerId: row.providerId as string,
      modelId: row.model as string,
    },
  }
}

/**
 * Apply a signed contribution to one rollup bucket. Exported for the rebuild
 * path and for tests. Never lets a bucket go negative, and deletes a bucket
 * that a retraction empties so the table does not accumulate zero rows.
 */
export async function applyRollupDelta(
  table: {
    get(id: string): Promise<ProviderCostDailyRow | undefined>
    put(row: ProviderCostDailyRow): Promise<unknown>
    delete(id: string): Promise<unknown>
  },
  key: { day: string; providerId: string; modelId: string },
  delta: { costUsd: number; inputTokens: number; outputTokens: number; requestCount: number },
  now: number
): Promise<void> {
  const id = buildCostDailyId(key.day, key.providerId, key.modelId)
  const existing = await table.get(id)
  const next: ProviderCostDailyRow = {
    id,
    day: key.day,
    providerId: key.providerId,
    modelId: key.modelId,
    totalCostUsd: Math.max(0, (existing?.totalCostUsd ?? 0) + delta.costUsd),
    requestCount: Math.max(0, (existing?.requestCount ?? 0) + delta.requestCount),
    inputTokens: Math.max(0, (existing?.inputTokens ?? 0) + delta.inputTokens),
    outputTokens: Math.max(0, (existing?.outputTokens ?? 0) + delta.outputTokens),
    updatedAt: now,
  }
  if (next.requestCount === 0 && next.totalCostUsd === 0 && next.inputTokens === 0) {
    if (existing) await table.delete(id)
    return
  }
  await table.put(next)
}

/**
 * Commit one usage row and its budget projection atomically.
 *
 * Idempotent on `messageId`: writing the same id twice leaves the ledger with
 * one row AND the projection with one turn's worth of spend, which is the
 * invariant `usage-ledger.test.ts` pins for every surface.
 */
export async function commitUsageRow(
  row: SessionUsageRow,
  opts: { now?: number; resolve?: PricingResolver; expectDatabase?: string } = {}
): Promise<UsageCommitResult | null> {
  if (!row.messageId || !row.sessionId) return null
  const now = opts.now ?? Date.now()
  const frozen = freezeUsageCost(row, opts.resolve)
  const db = getDb()

  let committed: Omit<UsageCommitResult, "row"> = { replaced: false, dailies: [] }
  await db.transaction("rw", db.sessionUsage, db.providerCostDaily, async () => {
    assertDatabase(db, opts.expectDatabase)
    committed = await putWithProjection(db, frozen, now)
  })

  for (const daily of committed.dailies) pushToMirror(daily)
  return { row: frozen, ...committed }
}

/**
 * Commit many usage rows and their projection in ONE transaction: the bulk
 * door to the same ledger (ADR-0253 D07). Every row is frozen, put, and its
 * projection delta applied exactly as {@link commitUsageRow} would, so a row
 * that replaces one this device already booked retracts what it replaces
 * instead of leaving the old spend in the rollup.
 *
 * `retireSource` is a complete scan's answer for one source: that source's
 * rows absent from `rows` are deleted, their contribution (if any) retracted.
 * `assertCurrent` runs inside the transaction before anything is written, so a
 * caller whose scope moved on (a sync for a target no longer active) aborts it
 * whole. Malformed rows (no message or session id) are skipped.
 */
export async function commitUsageRows(
  rows: readonly SessionUsageRow[],
  opts: {
    now?: number
    resolve?: PricingResolver
    retireSource?: string
    /**
     * Retire only these upstream sessions' rows that `rows` does not carry,
     * instead of every row of `retireSource`. A scan that read some sessions
     * replaces exactly those, and a session it did not read keeps its rows.
     */
    retireSessions?: readonly string[]
    assertCurrent?: () => void
    /** The account database the rows belong to; another active one refuses the write. */
    expectDatabase?: string
  } = {}
): Promise<{ written: number; removed: number }> {
  const now = opts.now ?? Date.now()
  // One row per id, the last given winning, as one put after another would.
  const byId = new Map<string, SessionUsageRow>()
  for (const row of rows) {
    if (row.messageId && row.sessionId) byId.set(row.messageId, row)
  }
  const resolve = opts.resolve ?? ledgerPricingResolver()
  const frozen = [...byId.values()].map((row) => freezeUsageCost(row, resolve))
  if (frozen.length === 0 && opts.retireSource === undefined) return { written: 0, removed: 0 }
  const db = getDb()

  const dailies = new Map<string, UsageCommitDaily>()
  const keep = (daily: UsageCommitDaily | null) => {
    if (!daily) return
    const key = `${daily.providerId}\u0000${daily.day}`
    const prior = dailies.get(key)
    dailies.set(key, { ...daily, deltaUsd: (prior?.deltaUsd ?? 0) + daily.deltaUsd })
  }
  let removed = 0
  await db.transaction("rw", db.sessionUsage, db.providerCostDaily, async () => {
    assertDatabase(db, opts.expectDatabase)
    opts.assertCurrent?.()
    if (opts.retireSource !== undefined) {
      const source = opts.retireSource
      const present = new Set(frozen.map((row) => row.messageId))
      const existing = opts.retireSessions
        ? (
            await db.sessionUsage
              .where("[sourceId+sourceSessionId]")
              .anyOf(opts.retireSessions.map((session) => [source, session]))
              .toArray()
          ).filter((row) => row.sourceId === source)
        : await db.sessionUsage.where("sourceId").equals(source).toArray()
      const stale = existing.filter((row) => !present.has(row.messageId))
      if (stale.length > 0) await db.sessionUsage.bulkDelete(stale.map((row) => row.messageId))
      for (const row of stale)
        for (const daily of await moveProjection(db, row, null, now)) keep(daily)
      removed = stale.length
    }
    // Bulk reads and writes: a scan commits thousands of rows, and only the
    // ones that do or did count for the budget touch the projection.
    const priors = await db.sessionUsage.bulkGet(frozen.map((row) => row.messageId))
    if (frozen.length > 0) await db.sessionUsage.bulkPut(frozen)
    for (const [index, row] of frozen.entries()) {
      for (const daily of await moveProjection(db, priors[index], row, now)) keep(daily)
    }
  })

  for (const daily of dailies.values()) pushToMirror(daily)
  return { written: frozen.length, removed }
}

type LedgerDb = ReturnType<typeof getDb>

/** Put one frozen row and move the projection by the difference it makes. */
async function putWithProjection(
  db: LedgerDb,
  frozen: SessionUsageRow,
  now: number
): Promise<Omit<UsageCommitResult, "row">> {
  const prior = await db.sessionUsage.get(frozen.messageId)
  await db.sessionUsage.put(frozen)
  return {
    replaced: prior != null,
    dailies: await moveProjection(db, prior, frozen, now),
  }
}

/**
 * Move the rollup from `prior`'s contribution to `next`'s, inside the caller's
 * transaction, and read back the committed day total of every provider-day it
 * touched. A correction that moved the row to another provider or day touches
 * two, and the old one's total must reach the mirror as well: it went down.
 */
async function moveProjection(
  db: LedgerDb,
  prior: SessionUsageRow | null | undefined,
  next: SessionUsageRow | null,
  now: number
): Promise<UsageCommitDaily[]> {
  const before = rollupContribution(prior)
  const after = rollupContribution(next)
  if (!before.key && !after.key) return []

  const sameBucket =
    before.key != null &&
    after.key != null &&
    before.key.day === after.key.day &&
    before.key.providerId === after.key.providerId &&
    before.key.modelId === after.key.modelId

  if (before.key && !sameBucket) {
    // The retry moved buckets (different day, provider or model). Retract the
    // old contribution in full before adding the new one, otherwise a model
    // switch on a retry double-counts under two model ids forever.
    await applyRollupDelta(
      db.providerCostDaily,
      before.key,
      {
        costUsd: -before.costUsd,
        inputTokens: -before.inputTokens,
        outputTokens: -before.outputTokens,
        requestCount: -before.requestCount,
      },
      now
    )
  }

  if (after.key) {
    const base = sameBucket
      ? before
      : { costUsd: 0, inputTokens: 0, outputTokens: 0, requestCount: 0 }
    await applyRollupDelta(
      db.providerCostDaily,
      after.key,
      {
        costUsd: after.costUsd - base.costUsd,
        inputTokens: after.inputTokens - base.inputTokens,
        outputTokens: after.outputTokens - base.outputTokens,
        requestCount: after.requestCount - base.requestCount,
      },
      now
    )
  }

  // Sum each affected provider's committed rows for its day INSIDE the
  // transaction. This is what lets the synchronous budget mirror snap to
  // durable state instead of drifting when a write is lost.
  const targets: Array<{ key: { day: string; providerId: string }; deltaUsd: number }> = []
  const movedProviderDay =
    before.key != null &&
    after.key != null &&
    (before.key.providerId !== after.key.providerId || before.key.day !== after.key.day)
  if (after.key) {
    targets.push({
      key: after.key,
      deltaUsd: movedProviderDay ? after.costUsd : after.costUsd - before.costUsd,
    })
  }
  if (before.key && (!after.key || movedProviderDay)) {
    targets.push({ key: before.key, deltaUsd: -before.costUsd })
  }
  const out: UsageCommitDaily[] = []
  for (const target of targets) {
    const dayRows = await db.providerCostDaily
      .where("[providerId+day]")
      .equals([target.key.providerId, target.key.day])
      .toArray()
    out.push({
      day: target.key.day,
      providerId: target.key.providerId,
      providerTotalUsd: dayRows.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0),
      deltaUsd: target.deltaUsd,
    })
  }
  return out
}

function pushToMirror(daily: UsageCommitDaily): void {
  if (!mirrorSink) return
  try {
    mirrorSink(daily)
  } catch {
    // The mirror is an accelerator for the budget gate, never the record.
    // A failing sink must not fail a committed write.
  }
}

/**
 * Rebuild the last {@param days} days of `providerCostDaily` from the ledger,
 * atomically. This is the one-time reconciliation the app runs on idle after
 * the v218 upgrade, and the repair path when a projection is suspected wrong.
 *
 * Every bucket in the window is recomputed from `sessionUsage`, so a projection
 * that drifted for any reason converges in one pass. Buckets outside the window
 * are untouched.
 */
export async function rebuildProviderCostDaily(
  days = 90,
  opts: { now?: number; resolve?: PricingResolver } = {}
): Promise<{ days: number; buckets: number; rows: number }> {
  const now = opts.now ?? Date.now()
  const windowDays = Math.max(1, Math.floor(days))
  // The window is whole local days: buckets are deleted by day, so the rows
  // they are rebuilt from must start at that first day's midnight. Reading
  // from "now minus N×24h" rebuilt the first day from its afternoon only.
  const first = new Date(now - windowDays * 86_400_000)
  const fromMs = new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime()
  const fromDay = localDayString(fromMs)
  const toDay = localDayString(now)
  const db = getDb()

  let buckets = 0
  let rows = 0
  await db.transaction("rw", db.sessionUsage, db.providerCostDaily, async () => {
    const ledger = await db.sessionUsage.where("at").aboveOrEqual(fromMs).toArray()
    const next = new Map<string, ProviderCostDailyRow>()
    const resolve = opts.resolve ?? ledgerPricingResolver()
    for (const raw of ledger) {
      const contribution = rollupContribution(freezeUsageCost(raw, resolve))
      if (!contribution.key) continue
      rows += 1
      const { day, providerId, modelId } = contribution.key
      const id = buildCostDailyId(day, providerId, modelId)
      const acc = next.get(id) ?? {
        id,
        day,
        providerId,
        modelId,
        totalCostUsd: 0,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        updatedAt: now,
      }
      acc.totalCostUsd += contribution.costUsd
      acc.requestCount += contribution.requestCount
      acc.inputTokens = (acc.inputTokens ?? 0) + contribution.inputTokens
      acc.outputTokens = (acc.outputTokens ?? 0) + contribution.outputTokens
      next.set(id, acc)
    }
    const stale = await db.providerCostDaily
      .where("day")
      .between(fromDay, toDay, true, true)
      .primaryKeys()
    if (stale.length > 0) await db.providerCostDaily.bulkDelete(stale as string[])
    const values = [...next.values()]
    if (values.length > 0) await db.providerCostDaily.bulkPut(values)
    buckets = values.length
  })

  return { days: windowDays, buckets, rows }
}
