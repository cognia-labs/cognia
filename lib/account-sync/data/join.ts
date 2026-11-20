/**
 * Arming capture and joining local data to the account (protocol §5.4).
 *
 * A device starts capturing once its database is armed for its space and
 * device id. What happens to the rows it already has depends on the account:
 *
 * - Nothing local, or nothing in the account yet (the first device): arm and
 *   seed. Every synced row gets clocks (from its own `updatedAt`, else
 *   `createdAt`, else now) and goes into the outbox whole.
 * - A settings key counts as held data only when it holds a value of its own.
 *   Every save writes the whole row, defaults included, so a device that only
 *   picked a microphone holds a "system" theme it never chose; seeding that
 *   with the row's (recent) time beat the account's dark theme on every
 *   device. A key at its default is neither counted nor seeded, and the
 *   account's value lands; a key the person set makes the device one that
 *   holds data, so they are asked, with a backup, like for chats.
 * - Both sides have data: the person chooses. **Merge** seeds as above, and
 *   the account's rows then merge in field by field; **replace** removes the
 *   device's synced rows and takes the account's. Either changes local data,
 *   so a backup is taken first, and a failed backup changes nothing.
 * - The database already synced with another space (another person, or the
 *   same person on another issuer): the person chooses too, however empty
 *   either side is. Its rows came from or went to someone else's account, so
 *   seeding them into this one without asking would hand that account's data
 *   to whoever signed in next on the same profile or host.
 *
 * Re-arming for a new device id (a device that was removed and joined again)
 * keeps the clocks, which are still true orderings in the same space, but
 * starts the cursor over: its sequence numbers belong to the old device.
 *
 * Arming comes first so nothing written while seeding runs is missed, and the
 * capture row says a seed is still owed (`seedPending`) until the last page is
 * queued: a join interrupted between pages (the app closed, the brain killed)
 * resumes seeding on the next start instead of leaving the rows it had not
 * reached yet without clocks, which nothing would ever send.
 */

import { encodeHlc, type Hlc } from "@cognia/sync-protocol"

import type { DeviceKeys } from "@/lib/account-sync/crypto"
import type { SyncApi } from "@/lib/account-sync/sync-api"
import type { CogniaDB } from "@/lib/db/schema"
import { DEFAULTS } from "@/lib/db/settings"

import { settingsPropertyField } from "@cognia/sync-protocol"

import { SETTINGS_VALUE_FIELD, markRemoteTransaction } from "./capture-middleware"
import { ownProperties } from "./settings-properties"
import { sameValue } from "./stable-json"
import {
  SETTINGS_MERGED_BY_PROPERTY,
  SETTINGS_ROW_ID,
  SYNCED_SETTINGS_KEYS,
  SYNCED_TABLES,
  TABLE_POLICIES,
  syncedFields,
  syncsEveryRow,
} from "./tables"
import type {
  AccountSyncCaptureState,
  AccountSyncCursorState,
  AccountSyncOutboxRow,
  SyncClasses,
  SyncFieldClocksRow,
  SyncedTableName,
} from "./types"

/** Rows read and seeded per transaction. */
const SEED_PAGE = 250

type RecordTable = Exclude<SyncedTableName, "settings">

const RECORD_TABLES = SYNCED_TABLES.filter((table): table is RecordTable => table !== "settings")

export type JoinChoice = "merge" | "replace"

/**
 * Why the person is asked: `both-hold-data` when this device and the account
 * both have rows; `other-account` when this database last synced with a
 * different space.
 */
export type JoinQuestion = "both-hold-data" | "other-account"

export interface LocalDataSummary {
  /** Synced rows per table; for settings, the synced keys that hold a value. */
  counts: Record<SyncedTableName, number>
  total: number
}

export type JoinPlan =
  | { kind: "armed" }
  /** Arm and seed without asking: one side is empty. */
  | { kind: "seed"; local: LocalDataSummary }
  /** The person picks merge or replace. */
  | { kind: "ask"; question: JoinQuestion; local: LocalDataSummary; remoteSeq: number }

export interface SeedProgress {
  table: SyncedTableName
  done: number
  total: number
}

export interface JoinTarget {
  db: CogniaDB
  spaceId: string
  deviceId: string
  now: () => number
}

async function captureState(db: CogniaDB): Promise<AccountSyncCaptureState | undefined> {
  return (await db.accountSyncState.get("capture")) as AccountSyncCaptureState | undefined
}

async function cursorState(db: CogniaDB): Promise<AccountSyncCursorState | undefined> {
  return (await db.accountSyncState.get("cursor")) as AccountSyncCursorState | undefined
}

/**
 * The space this database last synced with, if any. The cursor outlives a
 * disarm (removal from a space), so a database that was removed from one
 * account still remembers whose data it holds.
 */
export async function lastSyncedSpace(db: CogniaDB): Promise<string | undefined> {
  return (await captureState(db))?.spaceId ?? (await cursorState(db))?.spaceId
}

export function isArmedFor(
  state: AccountSyncCaptureState | undefined,
  spaceId: string,
  deviceId: string
): boolean {
  return state?.spaceId === spaceId && state.deviceId === deviceId
}

/**
 * Whether a synced settings key holds a value this device chose, rather than
 * the default every save writes into the row. A key merged by property holds
 * one when any of its properties differs from the default's.
 */
export function holdsOwnSetting(key: string, value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (SETTINGS_MERGED_BY_PROPERTY.has(key)) return ownProperties(key, value).length > 0
  return !sameValue(value, (DEFAULTS as unknown as Record<string, unknown>)[key])
}

function ownSettingKeys(row: Record<string, unknown> | undefined): string[] {
  if (!row) return []
  return [...SYNCED_SETTINGS_KEYS].filter((key) => holdsOwnSetting(key, row[key]))
}

/** How much synced data this device holds (built-ins and project memories do not count). */
export async function summarizeLocalData(db: CogniaDB): Promise<LocalDataSummary> {
  const counts = {} as Record<SyncedTableName, number>
  for (const table of RECORD_TABLES) {
    const policy = TABLE_POLICIES[table]
    counts[table] =
      policy.syncsRow === syncsEveryRow
        ? await db.table(table).count()
        : await db
            .table(table)
            .filter((row: Record<string, unknown>) => policy.syncsRow(row))
            .count()
  }
  const settings = (await db.settings.get(SETTINGS_ROW_ID)) as Record<string, unknown> | undefined
  // Defaults are not data (every save writes them); a setting of its own is.
  counts.settings = ownSettingKeys(settings).length
  const total = SYNCED_TABLES.reduce((sum, table) => sum + counts[table], 0)
  return { counts, total }
}

/** The account's op log length (0 before any device pushed). */
export async function remoteLogLength(api: SyncApi, device: DeviceKeys): Promise<number> {
  return (await api.pullOps(device, Number.MAX_SAFE_INTEGER)).lastSeq
}

export async function planJoin(
  target: JoinTarget,
  api: SyncApi,
  device: DeviceKeys
): Promise<JoinPlan> {
  const capture = await captureState(target.db)
  if (isArmedFor(capture, target.spaceId, target.deviceId)) {
    // Armed, but the seed it was armed for did not finish: finish it.
    return capture?.seedPending
      ? { kind: "seed", local: await summarizeLocalData(target.db) }
      : { kind: "armed" }
  }
  const local = await summarizeLocalData(target.db)
  const previous = await lastSyncedSpace(target.db)
  if (previous !== undefined && previous !== target.spaceId) {
    return {
      kind: "ask",
      question: "other-account",
      local,
      remoteSeq: await remoteLogLength(api, device),
    }
  }
  if (local.total === 0) return { kind: "seed", local }
  const remoteSeq = await remoteLogLength(api, device)
  return remoteSeq === 0
    ? { kind: "seed", local }
    : { kind: "ask", question: "both-hold-data", local, remoteSeq }
}

/**
 * Writes the capture row; a new space or device id also starts the cursor and
 * inbox over. `seed` marks the seed it is armed for as owed until
 * {@link armAndSeed} finishes it.
 */
async function arm(target: JoinTarget, options: { seed: boolean }): Promise<void> {
  const { db, spaceId, deviceId } = target
  await db.transaction("rw", [db.accountSyncState, db.accountSyncInbox], async () => {
    const previous = await captureState(db)
    if (isArmedFor(previous, spaceId, deviceId)) {
      if (options.seed && !previous!.seedPending)
        await db.accountSyncState.put({ ...previous!, seedPending: true })
      return
    }
    const state: AccountSyncCaptureState = {
      id: "capture",
      spaceId,
      deviceId,
      classes: previous?.classes ?? { content: true, settings: true },
      hlc: previous?.hlc ?? null,
      ...(options.seed ? { seedPending: true as const } : {}),
    }
    const cursor: AccountSyncCursorState = { id: "cursor", spaceId, serverSeq: 0, deviceSeq: 0 }
    await db.accountSyncState.bulkPut([state, cursor])
    await db.accountSyncInbox.clear()
  })
}

function timeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime()
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** The clock a row's existing fields are given: when the row says it last changed, never later than now. */
function seedClock(row: Record<string, unknown>, deviceId: string, now: number): string {
  const ms = Math.min(timeOf(row.updatedAt) ?? timeOf(row.createdAt) ?? now, now)
  const hlc: Hlc = { ms: Math.floor(ms), c: 0, deviceId }
  return encodeHlc(hlc)
}

function resendEntry(
  table: SyncedTableName,
  rowId: string,
  previous: AccountSyncOutboxRow | undefined,
  now: number
): AccountSyncOutboxRow {
  return {
    table,
    rowId,
    fields: table === "settings" ? [SETTINGS_VALUE_FIELD] : [],
    deleted: false,
    ...(table === "settings" ? {} : { resend: true }),
    mutationId: crypto.randomUUID(),
    rev: (previous?.rev ?? 0) + 1,
    since: previous?.since ?? now,
  }
}

async function seedRecords(
  target: JoinTarget,
  table: RecordTable,
  onProgress?: (progress: SeedProgress) => void
): Promise<void> {
  const { db, deviceId } = target
  const policy = TABLE_POLICIES[table]
  const fields = syncedFields(policy)
  const store = db.table(table)
  const total = await store.count()
  let done = 0
  let after: string | null = null
  for (;;) {
    const page = (await (
      after === null
        ? store.orderBy(":id").limit(SEED_PAGE)
        : store.where(":id").above(after).limit(SEED_PAGE)
    ).toArray()) as Record<string, unknown>[]
    if (page.length === 0) break
    after = String(page.at(-1)!.id)
    const rows = page.filter((row) => policy.syncsRow(row))
    if (rows.length > 0) {
      const now = target.now()
      // Clocks and queue only: a write captured meanwhile already holds real
      // clocks, and the fresh reads below keep them.
      await db.transaction("rw", [db.syncFieldClocks, db.accountSyncOutbox], async () => {
        const keys = rows.map((row) => [table, String(row.id)] as [string, string])
        const [clocks, queued] = await Promise.all([
          db.syncFieldClocks.bulkGet(keys),
          db.accountSyncOutbox.bulkGet(keys),
        ])
        const clockRows: SyncFieldClocksRow[] = []
        const outboxRows: AccountSyncOutboxRow[] = []
        rows.forEach((row, index) => {
          const rowId = String(row.id)
          const held = clocks[index]
          const at = seedClock(row, deviceId, now)
          const next = { ...held?.fields }
          for (const name of fields)
            if (next[name] === undefined && row[name] !== undefined && row[name] !== null)
              next[name] = at
          clockRows.push({ ...held, table, rowId, fields: next })
          outboxRows.push(resendEntry(table, rowId, queued[index], now))
        })
        await db.syncFieldClocks.bulkPut(clockRows)
        await db.accountSyncOutbox.bulkPut(outboxRows)
      })
    }
    done += page.length
    onProgress?.({ table, done, total })
  }
}

/**
 * The fields to seed for a settings key this device holds a value of: the
 * key's `value`, or for a key merged by property each own property. A field
 * that already has a clock keeps it; in a key merged by property, so does
 * every property its whole-write clock stands for. Empty when nothing is left.
 */
function settingSeedFields(
  key: string,
  value: unknown,
  held: SyncFieldClocksRow | undefined
): string[] {
  const fields = held?.fields ?? {}
  if (!SETTINGS_MERGED_BY_PROPERTY.has(key))
    return fields[SETTINGS_VALUE_FIELD] ? [] : [SETTINGS_VALUE_FIELD]
  if (fields[SETTINGS_VALUE_FIELD]) return []
  return ownProperties(key, value)
    .map(settingsPropertyField)
    .filter((field) => fields[field] === undefined)
}

/** Queues the settings keys that hold a value of their own and have no clock yet. */
async function seedSettings(target: JoinTarget): Promise<void> {
  const { db, deviceId } = target
  const row = (await db.settings.get(SETTINGS_ROW_ID)) as Record<string, unknown> | undefined
  const keys = ownSettingKeys(row)
  if (!row || keys.length === 0) return
  const now = target.now()
  const at = seedClock(row, deviceId, now)
  await db.transaction("rw", [db.syncFieldClocks, db.accountSyncOutbox], async () => {
    const ids = keys.map((key) => ["settings", key] as [string, string])
    const [clocks, queued] = await Promise.all([
      db.syncFieldClocks.bulkGet(ids),
      db.accountSyncOutbox.bulkGet(ids),
    ])
    const clockRows: SyncFieldClocksRow[] = []
    const outboxRows: AccountSyncOutboxRow[] = []
    keys.forEach((key, index) => {
      const held = clocks[index]
      const seeded = settingSeedFields(key, row[key], held)
      if (seeded.length === 0) return
      const fields = { ...held?.fields }
      for (const field of seeded) fields[field] = at
      clockRows.push({ ...held, table: "settings", rowId: key, fields })
      const entry = resendEntry("settings", key, queued[index], now)
      const pending = queued[index] && !queued[index]!.deleted ? queued[index]!.fields : []
      outboxRows.push({ ...entry, fields: [...new Set([...pending, ...seeded])].sort() })
    })
    await db.syncFieldClocks.bulkPut(clockRows)
    await db.accountSyncOutbox.bulkPut(outboxRows)
  })
}

/**
 * Arms capture, then queues every synced row whole (merge, and the first
 * device). Seeding is idempotent (a row with clocks keeps them), so a seed
 * resumed after an interruption simply runs again.
 */
export async function armAndSeed(
  target: JoinTarget,
  onProgress?: (progress: SeedProgress) => void
): Promise<void> {
  // Armed first, so nothing written while seeding runs is missed.
  await arm(target, { seed: true })
  for (const table of RECORD_TABLES) await seedRecords(target, table, onProgress)
  await seedSettings(target)
  await target.db.transaction("rw", target.db.accountSyncState, async () => {
    const state = await captureState(target.db)
    if (!state?.seedPending || !isArmedFor(state, target.spaceId, target.deviceId)) return
    const { seedPending: _done, ...seeded } = state
    await target.db.accountSyncState.put(seeded)
  })
  onProgress?.({ table: "settings", done: 1, total: 1 })
}

/**
 * Queues a class's rows again when it is switched back on (protocol §9). Edits
 * made while it was off were captured with their own clocks and wait in the
 * outbox; this covers rows that have no clock to send.
 */
export async function seedClass(target: JoinTarget, cls: keyof SyncClasses): Promise<void> {
  if (cls === "settings") {
    await seedSettings(target)
    return
  }
  for (const table of RECORD_TABLES)
    if (TABLE_POLICIES[table].cls === cls) await seedRecords(target, table)
}

/**
 * Removes this device's synced rows (built-ins and project memories stay) and
 * everything queued for them, then arms with the cursor at the start, so the
 * next round pulls the whole account. Settings keep their values, but their
 * clocks go, so the account's values win.
 */
export async function replaceWithAccount(target: JoinTarget): Promise<void> {
  const { db } = target
  const stores = [
    ...RECORD_TABLES.map((table) => db.table(table)),
    db.syncFieldClocks,
    db.accountSyncOutbox,
    db.accountSyncInbox,
  ]
  await db.transaction("rw", stores, async (tx) => {
    markRemoteTransaction(tx.idbtrans)
    for (const table of RECORD_TABLES) {
      const policy = TABLE_POLICIES[table]
      if (policy.syncsRow === syncsEveryRow) {
        await db.table(table).clear()
        continue
      }
      const ids = (await db
        .table(table)
        .filter((row: Record<string, unknown>) => policy.syncsRow(row))
        .primaryKeys()) as string[]
      await db.table(table).bulkDelete(ids)
    }
    await db.syncFieldClocks.clear()
    await db.accountSyncOutbox.clear()
    await db.accountSyncInbox.clear()
  })
  await db.accountSyncState.delete("capture")
  await arm(target, { seed: false })
}

export interface JoinOptions {
  /** Takes a backup of this device's data; must resolve before anything changes. */
  backup: () => Promise<void>
  onProgress?: (progress: SeedProgress) => void
}

/** Carries out the person's choice for a device that has data while the account does too. */
export async function joinWithChoice(
  target: JoinTarget,
  choice: JoinChoice,
  options: JoinOptions
): Promise<void> {
  await options.backup()
  if (choice === "replace") await replaceWithAccount(target)
  else await armAndSeed(target, options.onProgress)
}

/** Stops capturing on this database (removal, or sync turned off): queued data stays. */
export async function disarm(db: CogniaDB): Promise<void> {
  await db.accountSyncState.delete("capture")
}
