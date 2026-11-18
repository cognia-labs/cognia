/**
 * What rolling a plugin's package back means for its data (ADR-0258).
 *
 * A package can only run on data at or below its own data version (its
 * major version). Going back past a data migration therefore needs the
 * snapshot taken before that migration:
 *
 * - an explicit rollback asks the user first, because restoring discards
 *   whatever the plugin saved since the snapshot ({@link describePluginDataRollback});
 * - a failed update undoes its own migration without asking, from a snapshot
 *   taken during that update ({@link restoreDataTakenSince});
 * - without a snapshot, nothing is restored and the older package still
 *   refuses the data (`PluginDataVersionError`).
 */
import type Dexie from "dexie"
import { listPluginDataSnapshots } from "@/lib/db/plugin-data-snapshots"
import { restorePluginDataSnapshot } from "./bridge"
import { pluginDataVersionOf, selectRestoreSnapshot } from "./data-snapshots"
import type { PluginDexieMeta } from "./meta"

type DexieSource = Dexie | (() => Dexie)

const resolveDb = (source: DexieSource): Dexie => (typeof source === "function" ? source() : source)

export type PluginDataRollback =
  /** The target package can read the data as it is. */
  | { kind: "none" }
  /** The data goes back to a snapshot; what the plugin saved since is discarded. */
  | {
      kind: "restore"
      snapshotId: string
      /** When the snapshot was taken; everything saved after it is lost. */
      capturedAt: number
      /** The data version the snapshot holds. */
      dataVersion: number
      /** The data version now. */
      currentDataVersion: number
      /** Rows the plugin has now, all of which are replaced. */
      currentRows: number
      /** Rows the snapshot puts back. */
      snapshotRows: number
    }
  /** The data is newer than the target can read and no snapshot can bring it back. */
  | { kind: "unavailable"; currentDataVersion: number; targetDataVersion: number }

/**
 * A rollback that would discard data was not confirmed for this snapshot.
 * Thrown before anything is touched.
 */
export class PluginDataRestoreUnconfirmedError extends Error {
  constructor(
    readonly pluginId: string,
    readonly snapshotId: string
  ) {
    super(
      `Rolling back plugin "${pluginId}" restores its data from snapshot ${snapshotId} ` +
        `and discards what it saved since; confirm that first`
    )
    this.name = "PluginDataRestoreUnconfirmedError"
  }
}

async function readMeta(db: Dexie, pluginId: string): Promise<PluginDexieMeta | undefined> {
  return db.table<PluginDexieMeta, string>("pluginDexieMeta").get(pluginId)
}

async function countRows(db: Dexie, tableNames: readonly string[]): Promise<number> {
  const live = new Set(db.tables.map((table) => table.name))
  let total = 0
  for (const name of tableNames) {
    if (live.has(name)) total += await db.table(name).count()
  }
  return total
}

/** What moving `pluginId`'s package to `targetVersion` does to its data. */
export async function describePluginDataRollback(
  dbSource: DexieSource,
  pluginId: string,
  targetVersion: string
): Promise<PluginDataRollback> {
  const db = resolveDb(dbSource)
  const meta = await readMeta(db, pluginId)
  const current = meta?.appliedMigrationVersion
  const target = pluginDataVersionOf(targetVersion)
  if (!meta || current === undefined || !Number.isFinite(target) || target >= current) {
    return { kind: "none" }
  }
  const snapshot = selectRestoreSnapshot(await listPluginDataSnapshots(db, pluginId), target)
  if (!snapshot) {
    return { kind: "unavailable", currentDataVersion: current, targetDataVersion: target }
  }
  return {
    kind: "restore",
    snapshotId: snapshot.id,
    capturedAt: snapshot.createdAt,
    dataVersion: snapshot.dataVersion,
    currentDataVersion: current,
    currentRows: await countRows(db, meta.tableNames),
    snapshotRows: snapshot.rows,
  }
}

/**
 * After a failed update put the previous package back, undo the data
 * migration that update ran, from the snapshot it took (`since` is when the
 * update started). Earlier snapshots are never used here: restoring one would
 * discard data the user did not agree to lose.
 */
export async function restoreDataTakenSince(
  dbSource: DexieSource,
  pluginId: string,
  packageVersion: string,
  since: number
): Promise<"not-needed" | "restored" | "unavailable"> {
  const db = resolveDb(dbSource)
  const meta = await readMeta(db, pluginId)
  const target = pluginDataVersionOf(packageVersion)
  const current = meta?.appliedMigrationVersion
  if (current === undefined || !Number.isFinite(target) || current <= target) return "not-needed"
  const records = await listPluginDataSnapshots(db, pluginId)
  const snapshot = selectRestoreSnapshot(
    records.filter((record) => record.createdAt >= since),
    target
  )
  if (!snapshot) return "unavailable"
  await restorePluginDataSnapshot(dbSource, pluginId, snapshot.id)
  return "restored"
}
