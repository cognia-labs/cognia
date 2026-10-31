/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie, { type Transaction } from "dexie"
import {
  runPendingMigrations,
  runPluginMigrations,
  type MigrationContext,
} from "./migration-runner"
import type { PluginDexieMigrationDef } from "@/types/plugin"
import { loggers } from "@/lib/plugin/core/logger"

jest.mock("@/lib/plugin/core/logger", () => ({
  loggers: { manager: { warn: jest.fn() } },
}))

function makeTx(): Transaction {
  // jest mock — we only test that the right handlers are called
  return {} as Transaction
}

describe("runPendingMigrations", () => {
  it("runs migrations whose toVersion is > previousVersion and <= currentVersion", async () => {
    const v2 = jest.fn().mockResolvedValue(undefined)
    const v3 = jest.fn().mockResolvedValue(undefined)
    const migrations: PluginDexieMigrationDef[] = [
      { toVersion: 2, upgrade: "migrateToV2" },
      { toVersion: 3, upgrade: "migrateToV3" },
    ]
    const ctx: MigrationContext = {
      previousVersion: 1,
      currentVersion: 3,
      upgradeHandlers: { migrateToV2: v2, migrateToV3: v3 },
    }
    await runPendingMigrations(makeTx(), migrations, ctx)
    expect(v2).toHaveBeenCalledTimes(1)
    expect(v3).toHaveBeenCalledTimes(1)
  })

  it("skips migrations that are already applied (toVersion <= previousVersion)", async () => {
    const v2 = jest.fn().mockResolvedValue(undefined)
    const migrations: PluginDexieMigrationDef[] = [{ toVersion: 2, upgrade: "migrateToV2" }]
    const ctx: MigrationContext = {
      previousVersion: 2,
      currentVersion: 3,
      upgradeHandlers: { migrateToV2: v2 },
    }
    await runPendingMigrations(makeTx(), migrations, ctx)
    expect(v2).not.toHaveBeenCalled()
  })

  it("runs migrations in ascending toVersion order", async () => {
    const order: number[] = []
    const v2 = jest.fn().mockImplementation(async () => {
      order.push(2)
    })
    const v3 = jest.fn().mockImplementation(async () => {
      order.push(3)
    })
    const migrations: PluginDexieMigrationDef[] = [
      { toVersion: 3, upgrade: "v3" },
      { toVersion: 2, upgrade: "v2" },
    ]
    const ctx: MigrationContext = {
      previousVersion: 1,
      currentVersion: 3,
      upgradeHandlers: { v2, v3 },
    }
    await runPendingMigrations(makeTx(), migrations, ctx)
    expect(order).toEqual([2, 3])
  })

  it("throws when an upgrade function is not found", async () => {
    const migrations: PluginDexieMigrationDef[] = [{ toVersion: 2, upgrade: "missingFn" }]
    const ctx: MigrationContext = {
      previousVersion: 1,
      currentVersion: 2,
      upgradeHandlers: {},
    }
    await expect(runPendingMigrations(makeTx(), migrations, ctx)).rejects.toThrow(
      /missingFn.*not found/
    )
  })

  it("does not treat inherited object properties as exported migration handlers", async () => {
    await expect(
      runPendingMigrations(makeTx(), [{ toVersion: 1, upgrade: "toString" }], {
        previousVersion: 0,
        currentVersion: 1,
        upgradeHandlers: {},
      })
    ).rejects.toThrow("not found")
  })

  it("does nothing when migrations array is empty", async () => {
    await expect(
      runPendingMigrations(makeTx(), [], {
        previousVersion: 1,
        currentVersion: 5,
        upgradeHandlers: {},
      })
    ).resolves.toBeUndefined()
  })
})

describe("runPluginMigrations", () => {
  let db: Dexie
  beforeEach(async () => {
    db = new Dexie(`migration-ledger-${crypto.randomUUID()}`)
    db.version(1).stores({ pluginDexieMeta: "&pluginId", "plugin:items": "id" })
    await db.table("pluginDexieMeta").put({
      pluginId: "plugin",
      tableNames: ["plugin:items"],
      dexieVersion: 1,
      appliedAt: 1,
      appliedMigrationVersion: 0,
    })
  })
  afterEach(async () => {
    await db.delete()
  })

  it("serializes concurrent backfills and preserves the durable ledger across reopen", async () => {
    const upgrade = jest.fn(async (tx: Transaction) => {
      await tx.table("plugin:items").put({ id: 1, migrated: true })
    })
    const migrations = [{ toVersion: 2, upgrade: "upgrade" }]
    await Promise.all([
      runPluginMigrations(db, "plugin", 2, migrations, { upgrade }),
      runPluginMigrations(db, "plugin", 2, migrations, { upgrade }),
    ])
    db.close()
    await db.open()
    await runPluginMigrations(db, "plugin", 2, migrations, { upgrade })
    expect(upgrade).toHaveBeenCalledTimes(1)
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(2)
  })

  it("refuses a package below the committed data version without running handlers", async () => {
    await runPluginMigrations(db, "plugin", 2, [], {})
    const upgrade = jest.fn(async () => undefined)
    await expect(
      runPluginMigrations(db, "plugin", 1, [{ toVersion: 1, upgrade: "upgrade" }], { upgrade })
    ).rejects.toMatchObject({
      name: "PluginDataVersionError",
      pluginId: "plugin",
      currentVersion: 1,
      appliedMigrationVersion: 2,
    })
    expect(upgrade).not.toHaveBeenCalled()
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(2)
  })

  it("baselines legacy rows with no known previous version without replaying backfills", async () => {
    await db.table("pluginDexieMeta").update("plugin", { appliedMigrationVersion: undefined })
    const upgrade = jest.fn(async () => undefined)
    await runPluginMigrations(
      db,
      "plugin",
      3,
      [
        { toVersion: 2, upgrade: "upgrade" },
        { toVersion: 3, upgrade: "upgrade" },
      ],
      { upgrade }
    )
    expect(upgrade).not.toHaveBeenCalled()
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(3)
    expect(loggers.manager.warn).toHaveBeenCalledWith(
      expect.stringContaining("previous version is unknown")
    )
  })

  it("aborts data and ledger writes on missing handlers and permits a corrected retry", async () => {
    const upgrade = jest.fn(async (tx: Transaction) => {
      await tx.table("plugin:items").put({ id: 1 })
    })
    const migrations = [
      { toVersion: 1, upgrade: "upgrade" },
      { toVersion: 2, upgrade: "missing" },
    ]
    await expect(runPluginMigrations(db, "plugin", 2, migrations, { upgrade })).rejects.toThrow(
      "not found"
    )
    expect(await db.table("plugin:items").count()).toBe(0)
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(0)
    await runPluginMigrations(db, "plugin", 2, migrations, {
      upgrade,
      missing: async () => undefined,
    })
    expect(await db.table("plugin:items").count()).toBe(1)
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(2)
  })
})
