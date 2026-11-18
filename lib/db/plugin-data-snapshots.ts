/**
 * Rows of the two stores that keep a plugin's Dexie data as it was before a
 * data migration (ADR-0258, v257).
 *
 * A plugin's data version is its package's major version. When a newer major
 * migrates the data, its rows are copied first, in the same transaction, so a
 * rollback to the older package can put them back instead of refusing to run
 * it (`PluginDataVersionError`). `lib/plugin/dexie/data-snapshots.ts` writes
 * and prunes them; `lib/plugin/dexie/bridge.ts` restores them.
 *
 * Both stores are device-local and never synced or exported, like the plugin
 * tables they copy (`lib/data-governance/table-catalog.ts`).
 */
import type Dexie from "dexie"
import type { Table } from "dexie"

export const PLUGIN_DATA_SNAPSHOTS_TABLE = "pluginDataSnapshots"
export const PLUGIN_DATA_SNAPSHOT_ROWS_TABLE = "pluginDataSnapshotRows"

/** One plugin table as it was captured. */
export interface PluginDataSnapshotTable {
  /** Namespaced store name, `<pluginId>:<table>`. */
  name: string
  /** The Dexie schema the store was declared with, to declare it again on restore. */
  schema: string
  rows: number
  /** Chunks the rows were written in, numbered from 0. */
  chunks: number
  /** The primary key lives outside the value, so restoring passes the keys back. */
  outboundKeys: boolean
}

interface PluginDataSnapshotBase {
  id: string
  pluginId: string
  /** The data version the rows were at: the version the migration started from. */
  dataVersion: number
  /** The data version the migration that followed moved them to. */
  migratedTo: number
  createdAt: number
}

export interface CapturedPluginDataSnapshot extends PluginDataSnapshotBase {
  kind: "captured"
  tables: PluginDataSnapshotTable[]
  rows: number
  /** Estimated size of the copied rows. */
  bytes: number
}

/**
 * A migration that ran without a snapshot, so the data it changed cannot be
 * restored. Kept so the plugin's page can say so.
 */
export interface SkippedPluginDataSnapshot extends PluginDataSnapshotBase {
  kind: "skipped"
  /** The user, or a Host with nobody to ask, chose to migrate without one. */
  reason: "insufficient-space"
}

export type PluginDataSnapshotRecord = CapturedPluginDataSnapshot | SkippedPluginDataSnapshot

/** Up to a chunk's worth of one table's rows. */
export interface PluginDataSnapshotChunk {
  snapshotId: string
  table: string
  chunk: number
  /** Primary keys, in the order of `values`; only for outbound keys. */
  keys?: unknown[]
  values: unknown[]
}

export interface PluginDataSnapshotStores {
  snapshots: Table<PluginDataSnapshotRecord, string>
  chunks: Table<PluginDataSnapshotChunk, [string, string, number]>
}

export function pluginDataSnapshotStores(db: Dexie): PluginDataSnapshotStores {
  return {
    snapshots: db.table<PluginDataSnapshotRecord, string>(PLUGIN_DATA_SNAPSHOTS_TABLE),
    chunks: db.table<PluginDataSnapshotChunk, [string, string, number]>(
      PLUGIN_DATA_SNAPSHOT_ROWS_TABLE
    ),
  }
}

/** A plugin's snapshots, newest first. */
export async function listPluginDataSnapshots(
  db: Dexie,
  pluginId: string
): Promise<PluginDataSnapshotRecord[]> {
  const records = await pluginDataSnapshotStores(db)
    .snapshots.where("pluginId")
    .equals(pluginId)
    .toArray()
  // Creation times strictly increase per plugin (`lib/plugin/dexie/data-snapshots.ts`).
  return records.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Delete snapshots and their rows. Joins the caller's transaction when it
 * covers both stores, so a restore and the deletes it implies commit together.
 */
export async function deletePluginDataSnapshotRecords(
  db: Dexie,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return
  const { snapshots, chunks } = pluginDataSnapshotStores(db)
  await db.transaction("rw", [snapshots, chunks], async () => {
    for (const id of ids) {
      await chunks.where("snapshotId").equals(id).delete()
      await snapshots.delete(id)
    }
  })
}
