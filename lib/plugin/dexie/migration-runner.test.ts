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
import { HOST_BACKGROUND, pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import { CURRENT_SCHEMA } from "@/lib/db/schema"
import { capturePluginDataSnapshot } from "./data-snapshots"
import {
  listPluginDataSnapshots,
  pluginDataSnapshotStores,
  type CapturedPluginDataSnapshot,
} from "@/lib/db/plugin-data-snapshots"
import {
  __resetPluginDataSnapshotSpaceRequestsForTests,
  resolvePluginDataSnapshotSpaceRequest,
  subscribePluginDataSnapshotSpaceRequests,
  type PluginDataSnapshotSpaceDecision,
  type PluginDataSnapshotSpaceRequest,
} from "./snapshot-space-requests"

jest.mock("@/lib/plugin/core/logger", () => ({
  loggers: { manager: { warn: jest.fn() } },
}))

// The real copy, wrapped so one test can make IndexedDB refuse it.
jest.mock("./data-snapshots", () => {
  const actual = jest.requireActual("./data-snapshots")
  return {
    ...actual,
    capturePluginDataSnapshot: jest.fn(
      (...args: Parameters<typeof actual.capturePluginDataSnapshot>) =>
        actual.capturePluginDataSnapshot(...args)
    ),
  }
})

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
    db.version(1).stores({
      pluginDexieMeta: "&pluginId",
      pluginDataSnapshots: CURRENT_SCHEMA.pluginDataSnapshots!,
      pluginDataSnapshotRows: CURRENT_SCHEMA.pluginDataSnapshotRows!,
      "plugin:items": "id",
    })
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

  it("binds Host database reconciliation callbacks through actual settlement", async () => {
    await runPluginMigrations(db, "plugin", 1, [{ toVersion: 1, upgrade: "upgrade" }], {
      upgrade: async () => {
        await Promise.resolve()
        expect(pluginExecutionContext("plugin")).toEqual(HOST_BACKGROUND)
      },
    })
    expect(pluginExecutionContext("plugin")).toBeUndefined()
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

describe("runPluginMigrations data snapshots (ADR-0258)", () => {
  let db: Dexie
  const upgrade = async (tx: Transaction) => {
    await tx
      .table("plugin:items")
      .toCollection()
      .modify((row: { shape: number }) => {
        row.shape = 2
      })
  }
  const toV2 = [{ toVersion: 2, upgrade: "upgrade" }]

  const setStorage = (estimate: { quota: number; usage: number } | undefined) =>
    Object.defineProperty(globalThis.navigator, "storage", {
      configurable: true,
      value: estimate ? { estimate: async () => estimate } : undefined,
    })

  /** Answer every space question with `decision`; returns what was asked. */
  function answerSpace(decision: PluginDataSnapshotSpaceDecision) {
    const asked: PluginDataSnapshotSpaceRequest[] = []
    const stop = subscribePluginDataSnapshotSpaceRequests((state) => {
      if (state.current && !asked.some((request) => request.id === state.current!.id)) {
        asked.push(state.current)
        resolvePluginDataSnapshotSpaceRequest(state.current.id, decision)
      }
    })
    return { asked, stop }
  }

  beforeEach(async () => {
    setStorage(undefined)
    db = new Dexie(`migration-snapshot-${crypto.randomUUID()}`)
    db.version(1).stores({
      pluginDexieMeta: "&pluginId",
      pluginDataSnapshots: CURRENT_SCHEMA.pluginDataSnapshots!,
      pluginDataSnapshotRows: CURRENT_SCHEMA.pluginDataSnapshotRows!,
      "plugin:items": "id",
    })
    await db.table("pluginDexieMeta").put({
      pluginId: "plugin",
      tableNames: ["plugin:items"],
      dexieVersion: 1,
      appliedAt: 1,
      appliedMigrationVersion: 1,
    })
    await db.table("plugin:items").bulkPut([
      { id: 1, shape: 1 },
      { id: 2, shape: 1 },
    ])
  })
  afterEach(async () => {
    __resetPluginDataSnapshotSpaceRequestsForTests()
    setStorage(undefined)
    await db.delete()
  })

  it("copies the rows as they were before migrating them", async () => {
    await runPluginMigrations(db, "plugin", 2, toV2, { upgrade })
    const [snapshot] = (await listPluginDataSnapshots(db, "plugin")) as CapturedPluginDataSnapshot[]
    expect(snapshot).toMatchObject({
      kind: "captured",
      pluginId: "plugin",
      dataVersion: 1,
      migratedTo: 2,
      rows: 2,
      tables: [{ name: "plugin:items", schema: "id", rows: 2, chunks: 1, outboundKeys: false }],
    })
    const chunk = await pluginDataSnapshotStores(db).chunks.get([snapshot!.id, "plugin:items", 0])
    expect(chunk?.values).toEqual([
      { id: 1, shape: 1 },
      { id: 2, shape: 1 },
    ])
    expect(await db.table("plugin:items").toArray()).toEqual([
      { id: 1, shape: 2 },
      { id: 2, shape: 2 },
    ])
  })

  it("takes its snapshot with it when the migration fails", async () => {
    await expect(
      runPluginMigrations(db, "plugin", 2, toV2, {
        upgrade: async () => {
          throw new Error("bad upgrade")
        },
      })
    ).rejects.toThrow("bad upgrade")
    expect(await listPluginDataSnapshots(db, "plugin")).toEqual([])
    expect(await pluginDataSnapshotStores(db).chunks.count()).toBe(0)
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(1)
  })

  it("takes no snapshot when the data version does not move", async () => {
    await runPluginMigrations(db, "plugin", 1, toV2, { upgrade })
    expect(await listPluginDataSnapshots(db, "plugin")).toEqual([])
  })

  it("asks when the copy will not fit, and records that it ran without one", async () => {
    setStorage({ quota: 1000, usage: 999 })
    const { asked, stop } = answerSpace("continue-without-snapshot")
    await runPluginMigrations(db, "plugin", 2, toV2, { upgrade })
    stop()
    expect(asked).toEqual([
      expect.objectContaining({
        pluginId: "plugin",
        fromVersion: 1,
        toVersion: 2,
        availableBytes: 1,
      }),
    ])
    expect(asked[0]!.requiredBytes).toBeGreaterThan(1)
    expect(await listPluginDataSnapshots(db, "plugin")).toEqual([
      expect.objectContaining({ kind: "skipped", reason: "insufficient-space", dataVersion: 1 }),
    ])
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(2)
  })

  it("cancelling leaves the data where it was", async () => {
    setStorage({ quota: 1000, usage: 999 })
    const { stop } = answerSpace("cancel")
    await expect(runPluginMigrations(db, "plugin", 2, toV2, { upgrade })).rejects.toMatchObject({
      name: "PluginDataSnapshotDeclinedError",
      pluginId: "plugin",
      fromVersion: 1,
      toVersion: 2,
    })
    stop()
    expect((await db.table("pluginDexieMeta").get("plugin")).appliedMigrationVersion).toBe(1)
    expect(await db.table("plugin:items").get(1)).toEqual({ id: 1, shape: 1 })
    expect(await listPluginDataSnapshots(db, "plugin")).toEqual([])
  })

  it("asks again when IndexedDB refuses the copy the estimate allowed", async () => {
    jest.mocked(capturePluginDataSnapshot).mockImplementationOnce(async () => {
      throw Object.assign(new Error("quota"), { name: "QuotaExceededError" })
    })
    const { asked, stop } = answerSpace("continue-without-snapshot")
    await runPluginMigrations(db, "plugin", 2, toV2, { upgrade })
    stop()
    expect(asked).toEqual([expect.not.objectContaining({ availableBytes: expect.anything() })])
    expect(await listPluginDataSnapshots(db, "plugin")).toEqual([
      expect.objectContaining({ kind: "skipped" }),
    ])
    expect(await db.table("plugin:items").get(1)).toEqual({ id: 1, shape: 2 })
  })

  it("keeps each plugin's two newest snapshots", async () => {
    const steps = [2, 3, 4]
    const migrations = steps.map((toVersion) => ({ toVersion, upgrade: "upgrade" }))
    for (const step of steps) await runPluginMigrations(db, "plugin", step, migrations, { upgrade })
    const kept = await listPluginDataSnapshots(db, "plugin")
    expect(kept.map((record) => record.dataVersion)).toEqual([3, 2])
    expect(await pluginDataSnapshotStores(db).chunks.count()).toBe(2)
  })
})
