import { getDb, type PluginDexieMeta as CorePluginDexieMeta } from "@/lib/db/schema"
import type Dexie from "dexie"

/** Unindexed ledger fields on the existing row; no core schema change. */
export interface PluginDexieMeta extends CorePluginDexieMeta {
  schemaFingerprint?: string
  appliedMigrationVersion?: number
}

export async function getPluginDexieMeta(pluginId: string): Promise<PluginDexieMeta | undefined> {
  return getDb().pluginDexieMeta.get(pluginId)
}

/** Establish a known legacy baseline without creating a registration or advancing an existing ledger. */
export async function baselinePluginMigrationVersion(
  db: Dexie,
  pluginId: string,
  version: number
): Promise<number | undefined> {
  const table = db.table<PluginDexieMeta, string>("pluginDexieMeta")
  return db.transaction("rw", table, async () => {
    const current = await table.get(pluginId)
    if (!current) return undefined
    if (current.appliedMigrationVersion !== undefined) return current.appliedMigrationVersion
    await table.put({ ...current, appliedMigrationVersion: version })
    return version
  })
}

export async function putPluginDexiaMeta(row: PluginDexieMeta): Promise<void> {
  const db = getDb()
  const table = db.table<PluginDexieMeta, string>("pluginDexieMeta")
  await db.transaction("rw", table, async () => {
    const current = await table.get(row.pluginId)
    // A schema repair may have read its row before another window committed
    // a migration. Never roll the ledger back with that stale schema snapshot.
    const next = { ...current, ...row }
    if (current?.appliedMigrationVersion !== undefined) {
      next.appliedMigrationVersion = Math.max(
        current.appliedMigrationVersion,
        row.appliedMigrationVersion ?? 0
      )
    }
    await table.put(next)
  })
}

export async function deletePluginDexiaMeta(pluginId: string): Promise<void> {
  await getDb().pluginDexieMeta.delete(pluginId)
}

export async function getAllPluginDexiaMeta(): Promise<PluginDexieMeta[]> {
  return getDb().pluginDexieMeta.toArray()
}
