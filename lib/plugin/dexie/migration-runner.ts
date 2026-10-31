/**
 * Runs plugin-declared Dexie migrations on schema version bumps.
 *
 * Plugins can declare an optional `migrations` array in their manifest.dexie
 * block. Each entry has a `toVersion` (the manifest version it targets) and an
 * `upgrade` key that names an exported function in the plugin's entry module.
 *
 * Cognia runs the matching upgrade functions once — and only once — when the
 * plugin version advances past each migration's toVersion.
 */

import Dexie, { type Transaction } from "dexie"
import type { PluginDexieMigrationDef } from "@/types/plugin"
import type { PluginDexieMeta } from "./meta"
import { loggers } from "@/lib/plugin/core/logger"

/** A package rollback cannot roll back already committed plugin data. */
export class PluginDataVersionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly currentVersion: number,
    readonly appliedMigrationVersion: number
  ) {
    super(
      `Plugin "${pluginId}" data was migrated to v${appliedMigrationVersion}; ` +
        `update to v${appliedMigrationVersion} or later, or clear plugin data before activating v${currentVersion}`
    )
    this.name = "PluginDataVersionError"
  }
}

export function assertPluginDataVersion(
  pluginId: string,
  currentVersion: number,
  appliedMigrationVersion: number | undefined
): void {
  if (appliedMigrationVersion !== undefined && currentVersion < appliedMigrationVersion) {
    throw new PluginDataVersionError(pluginId, currentVersion, appliedMigrationVersion)
  }
}

export interface MigrationContext {
  /** The plugin manifest version before this upgrade. */
  previousVersion: number
  /** The plugin manifest version being installed now. */
  currentVersion: number
  /** Resolved upgrade functions exported by the plugin entry module. */
  upgradeHandlers: Record<string, (tx: Transaction) => Promise<void>>
}

/**
 * Runs all pending migrations whose toVersion is > previousVersion and
 * <= currentVersion, in ascending toVersion order.
 *
 * Callers are responsible for:
 *  1. Opening a Dexie transaction covering the tables that may be mutated.
 *  2. Passing the resolved plugin export map as upgradeHandlers.
 *
 * Throws if a migration's `upgrade` name is not found in upgradeHandlers.
 */
export async function runPendingMigrations(
  tx: Transaction,
  migrations: PluginDexieMigrationDef[],
  ctx: MigrationContext
): Promise<void> {
  const pending = migrations
    .filter((m) => m.toVersion > ctx.previousVersion && m.toVersion <= ctx.currentVersion)
    .sort((a, b) => a.toVersion - b.toVersion)

  for (const mig of pending) {
    const fn = Object.hasOwn(ctx.upgradeHandlers, mig.upgrade)
      ? ctx.upgradeHandlers[mig.upgrade]
      : undefined
    if (typeof fn !== "function") {
      throw new Error(
        `Migration upgrade function "${mig.upgrade}" not found in plugin exports ` +
          `(toVersion=${mig.toVersion})`
      )
    }
    await fn(tx)
  }
}

/** Commit all backfills and their durable version together, before activation. */
export async function runPluginMigrations(
  db: Dexie,
  pluginId: string,
  currentVersion: number,
  migrations: PluginDexieMigrationDef[],
  moduleExports: Record<string, unknown>
): Promise<void> {
  const metaTable = db.table<PluginDexieMeta, string>("pluginDexieMeta")
  const meta = await metaTable.get(pluginId)
  if (!meta) throw new Error(`Plugin "${pluginId}" has no Dexie registration`)
  let baselinedUnknownVersion = false
  await db.transaction(
    "rw",
    [metaTable, ...meta.tableNames.map((name) => db.table(name))],
    async (tx) => {
      // Read inside the write transaction so concurrent windows cannot run the
      // same pending backfill after both observed an older version.
      const current = await metaTable.get(pluginId)
      if (!current) throw new Error(`Plugin "${pluginId}" has no Dexie registration`)
      if (current.appliedMigrationVersion === undefined) {
        // Legacy data already has the installed shape. Without evidence of the
        // old version, replaying historical transformations could corrupt it.
        await metaTable.put({ ...current, appliedMigrationVersion: currentVersion })
        baselinedUnknownVersion = true
        return
      }
      const previousVersion = current.appliedMigrationVersion
      assertPluginDataVersion(pluginId, currentVersion, previousVersion)
      if (currentVersion === previousVersion) return
      const upgradeHandlers: MigrationContext["upgradeHandlers"] = {}
      for (const migration of migrations) {
        const handler = Object.hasOwn(moduleExports, migration.upgrade)
          ? moduleExports[migration.upgrade]
          : undefined
        if (typeof handler === "function") {
          upgradeHandlers[migration.upgrade] =
            handler as MigrationContext["upgradeHandlers"][string]
        }
      }
      await Dexie.waitFor(
        runPendingMigrations(tx, migrations, {
          previousVersion,
          currentVersion,
          upgradeHandlers,
        })
      )
      await metaTable.put({ ...current, appliedMigrationVersion: currentVersion })
    }
  )
  if (baselinedUnknownVersion) {
    loggers.manager.warn(
      `[plugin:${pluginId}] Dexie migration previous version is unknown; baselined at ${currentVersion} without replaying migrations`
    )
  }
}
