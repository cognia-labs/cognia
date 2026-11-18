/**
 * Snapshots of a plugin's Dexie tables taken before a data migration
 * (ADR-0258).
 *
 * `runPluginMigrations` calls {@link capturePluginDataSnapshot} inside the
 * migration's own transaction, before any plugin code runs. A migration that
 * throws therefore takes its snapshot with it, and one that commits leaves the
 * rows it changed recoverable. Rollback restores them through
 * `restorePluginDataSnapshot` (`./bridge.ts`); `./data-rollback.ts` decides
 * which snapshot that is.
 *
 * Rows are read and written through Dexie, never the native store: plugin
 * tables are encrypted per row with the table name and key bound in, so only
 * the middleware can move a row from one store to another.
 */
import type Dexie from "dexie"
import type { IndexableType, Table } from "dexie"
import {
  deletePluginDataSnapshotRecords,
  listPluginDataSnapshots,
  pluginDataSnapshotStores,
  type CapturedPluginDataSnapshot,
  type PluginDataSnapshotRecord,
  type PluginDataSnapshotTable,
  type SkippedPluginDataSnapshot,
} from "@/lib/db/plugin-data-snapshots"

/** Rows per stored chunk; bounds how much one read or write holds in memory. */
export const SNAPSHOT_CHUNK_ROWS = 200
/** Snapshots kept per plugin after each capture. */
export const SNAPSHOTS_KEPT_PER_PLUGIN = 2
/** Rows sampled per table to estimate the snapshot's size. */
const SIZE_SAMPLE_ROWS = 100
/**
 * Headroom over the estimate: the copy is encrypted and base64-wrapped like
 * the rows it copies, and IndexedDB adds its own overhead.
 */
const SPACE_FACTOR = 2
const SPACE_MARGIN_BYTES = 1024 * 1024

/** A plugin's data version: its package's major version. */
export function pluginDataVersionOf(packageVersion: string): number {
  return Number.parseInt(packageVersion.split(".")[0], 10)
}

/** The schema string Dexie was given for a store, rebuilt from its parsed spec. */
function schemaOf(table: Table): string {
  return [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(", ")
}

/** A rough structured-clone size, enough to compare against a quota. */
export function estimateValueBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (value === null || value === undefined) return 0
  switch (typeof value) {
    case "string":
      return value.length * 2
    case "number":
    case "bigint":
      return 8
    case "boolean":
      return 4
    case "object":
      break
    default:
      return 0
  }
  const object = value as object
  if (seen.has(object)) return 0
  seen.add(object)
  if (object instanceof Date) return 8
  if (typeof Blob !== "undefined" && object instanceof Blob) return object.size
  if (object instanceof ArrayBuffer) return object.byteLength
  if (ArrayBuffer.isView(object)) return object.byteLength
  if (object instanceof Map) {
    let total = 0
    for (const [key, entry] of object) {
      total += estimateValueBytes(key, seen) + estimateValueBytes(entry, seen)
    }
    return total
  }
  if (object instanceof Set) {
    let total = 0
    for (const entry of object) total += estimateValueBytes(entry, seen)
    return total
  }
  let total = 0
  for (const [key, entry] of Object.entries(object)) {
    total += key.length * 2 + estimateValueBytes(entry, seen)
  }
  return total
}

/** Estimated bytes of every row in `tableNames`, from a count and a sample per table. */
export async function estimatePluginDataBytes(
  db: Dexie,
  tableNames: readonly string[]
): Promise<number> {
  let total = 0
  for (const name of tableNames) {
    const table = db.table(name)
    const count = await table.count()
    if (count === 0) continue
    const sample = await table.limit(SIZE_SAMPLE_ROWS).toArray()
    const sampled = sample.reduce((sum, row) => sum + estimateValueBytes(row), 0)
    total += sample.length === 0 ? 0 : Math.ceil((sampled / sample.length) * count)
  }
  return total
}

/** Space a snapshot of `estimatedBytes` needs, with headroom. */
export function snapshotSpaceRequired(estimatedBytes: number): number {
  return estimatedBytes * SPACE_FACTOR + SPACE_MARGIN_BYTES
}

/** Bytes left in this origin's storage quota, when the platform reports it. */
export async function storageHeadroom(): Promise<number | undefined> {
  const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
  if (typeof storage?.estimate !== "function") return undefined
  try {
    const { quota, usage } = await storage.estimate()
    if (typeof quota !== "number" || typeof usage !== "number") return undefined
    return Math.max(0, quota - usage)
  } catch {
    return undefined
  }
}

/** Whether `error`, or what Dexie wrapped in it, is IndexedDB running out of quota. */
export function isQuotaExceeded(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false
  const candidate = error as {
    name?: unknown
    inner?: unknown
    cause?: unknown
    failures?: unknown
  }
  if (candidate.name === "QuotaExceededError") return true
  if (isQuotaExceeded(candidate.inner, depth + 1)) return true
  if (isQuotaExceeded(candidate.cause, depth + 1)) return true
  return (
    Array.isArray(candidate.failures) &&
    candidate.failures.some((failure) => isQuotaExceeded(failure, depth + 1))
  )
}

/**
 * A creation time strictly after the plugin's newest snapshot, so snapshots
 * taken within one millisecond still order, and "this one and every newer
 * one" means exactly that.
 */
async function nextSnapshotTime(db: Dexie, pluginId: string): Promise<number> {
  const [newest] = await listPluginDataSnapshots(db, pluginId)
  return Math.max(Date.now(), newest ? newest.createdAt + 1 : 0)
}

export interface SnapshotTarget {
  pluginId: string
  /** Namespaced stores to copy. */
  tableNames: readonly string[]
  dataVersion: number
  migratedTo: number
  /** Estimated size, recorded on the snapshot. */
  bytes: number
}

/**
 * Copy every row of `target.tableNames` into a new snapshot. Must run inside
 * a read-write transaction over those stores and both snapshot stores, so the
 * copy commits or aborts with the migration that follows it.
 */
export async function capturePluginDataSnapshot(
  db: Dexie,
  target: SnapshotTarget
): Promise<CapturedPluginDataSnapshot> {
  const { snapshots, chunks } = pluginDataSnapshotStores(db)
  const id = crypto.randomUUID()
  const tables: PluginDataSnapshotTable[] = []
  let rows = 0
  for (const name of target.tableNames) {
    const store = db.table(name)
    const outboundKeys = !store.schema.primKey.keyPath
    let chunk = 0
    let count = 0
    let lastKey: IndexableType | undefined
    for (;;) {
      const page = lastKey === undefined ? store.toCollection() : store.where(":id").above(lastKey)
      const keys = await page.limit(SNAPSHOT_CHUNK_ROWS).primaryKeys()
      if (keys.length === 0) break
      const values = await store.bulkGet(keys)
      await chunks.add({
        snapshotId: id,
        table: name,
        chunk,
        ...(outboundKeys ? { keys } : {}),
        values,
      })
      chunk += 1
      count += keys.length
      lastKey = keys[keys.length - 1]
      if (keys.length < SNAPSHOT_CHUNK_ROWS) break
    }
    tables.push({ name, schema: schemaOf(store), rows: count, chunks: chunk, outboundKeys })
    rows += count
  }
  const record: CapturedPluginDataSnapshot = {
    kind: "captured",
    id,
    pluginId: target.pluginId,
    dataVersion: target.dataVersion,
    migratedTo: target.migratedTo,
    createdAt: await nextSnapshotTime(db, target.pluginId),
    tables,
    rows,
    bytes: target.bytes,
  }
  await snapshots.add(record)
  return record
}

/** Record that a migration ran without a snapshot. Same transaction rules as a capture. */
export async function recordSkippedPluginDataSnapshot(
  db: Dexie,
  target: Omit<SnapshotTarget, "tableNames" | "bytes">
): Promise<SkippedPluginDataSnapshot> {
  const record: SkippedPluginDataSnapshot = {
    kind: "skipped",
    id: crypto.randomUUID(),
    pluginId: target.pluginId,
    dataVersion: target.dataVersion,
    migratedTo: target.migratedTo,
    createdAt: await nextSnapshotTime(db, target.pluginId),
    reason: "insufficient-space",
  }
  await pluginDataSnapshotStores(db).snapshots.add(record)
  return record
}

/** Keep each plugin's newest {@link SNAPSHOTS_KEPT_PER_PLUGIN} snapshots. */
export async function prunePluginDataSnapshots(
  db: Dexie,
  pluginId: string,
  keep = SNAPSHOTS_KEPT_PER_PLUGIN
): Promise<void> {
  const records = await listPluginDataSnapshots(db, pluginId)
  await deletePluginDataSnapshotRecords(
    db,
    records.slice(keep).map((record) => record.id)
  )
}

/** Delete every snapshot of a plugin, for when its data is cleared or purged. */
export async function deletePluginDataSnapshots(db: Dexie, pluginId: string): Promise<void> {
  const records = await listPluginDataSnapshots(db, pluginId)
  await deletePluginDataSnapshotRecords(
    db,
    records.map((record) => record.id)
  )
}

/**
 * The snapshot that brings the data down to `targetDataVersion` or below,
 * losing the least: the captured one with the highest data version not above
 * the target, the newest of those. A package at the target migrates the rest
 * of the way itself. Skipped records only explain why nothing closer exists.
 */
export function selectRestoreSnapshot(
  records: readonly PluginDataSnapshotRecord[],
  targetDataVersion: number
): CapturedPluginDataSnapshot | undefined {
  let best: CapturedPluginDataSnapshot | undefined
  for (const record of records) {
    if (record.kind !== "captured" || record.dataVersion > targetDataVersion) continue
    if (
      !best ||
      record.dataVersion > best.dataVersion ||
      (record.dataVersion === best.dataVersion && record.createdAt > best.createdAt)
    ) {
      best = record
    }
  }
  return best
}
