/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { CURRENT_SCHEMA } from "@/lib/db/schema"
import { listPluginDataSnapshots } from "@/lib/db/plugin-data-snapshots"
import { applyPluginTables } from "./bridge"
import { runPluginMigrations } from "./migration-runner"
import { describePluginDataRollback, restoreDataTakenSince } from "./data-rollback"

// The bridge reads and writes the ledger through `./meta`'s getDb(); point it
// at the test database.
let mockDb: Dexie | null = null
jest.mock("./meta", () => {
  const actual = jest.requireActual("./meta")
  const table = () => mockDb!.table("pluginDexieMeta")
  return {
    ...actual,
    getPluginDexieMeta: async (id: string) => table().get(id),
    getAllPluginDexiaMeta: async () => table().toArray(),
    putPluginDexiaMeta: async (row: unknown) => {
      await table().put(row)
    },
    deletePluginDexiaMeta: async (id: string) => {
      await table().delete(id)
    },
  }
})

describe("plugin data rollback", () => {
  let db: Dexie
  const reshape = async (tx: import("dexie").Transaction) => {
    await tx
      .table("p:items")
      .toCollection()
      .modify((row: { shape: number }) => {
        row.shape += 1
      })
  }
  const migrateTo = (version: number) =>
    runPluginMigrations(db, "p", version, [{ toVersion: version, upgrade: "reshape" }], { reshape })

  beforeEach(async () => {
    db = new Dexie(`data-rollback-${crypto.randomUUID()}`)
    db.version(1).stores({
      pluginDexieMeta: "&pluginId, appliedAt",
      pluginDataSnapshots: CURRENT_SCHEMA.pluginDataSnapshots!,
      pluginDataSnapshotRows: CURRENT_SCHEMA.pluginDataSnapshotRows!,
    })
    mockDb = db
    await applyPluginTables(db, "p", { tables: [{ name: "items", schema: "id" }] }, 1)
    await db.table("p:items").bulkPut([
      { id: 1, shape: 1 },
      { id: 2, shape: 1 },
    ])
  })
  afterEach(async () => {
    db.close()
    await Dexie.delete(db.name)
  })

  describe("describePluginDataRollback", () => {
    it("changes nothing for a version that reads the data as it is", async () => {
      await migrateTo(2)
      await expect(describePluginDataRollback(db, "p", "2.3.0")).resolves.toEqual({
        kind: "none",
      })
      await expect(describePluginDataRollback(db, "unknown", "1.0.0")).resolves.toEqual({
        kind: "none",
      })
    })

    it("names the snapshot and what restoring it replaces", async () => {
      await migrateTo(2)
      await db.table("p:items").put({ id: 3, shape: 2 })
      const [snapshot] = await listPluginDataSnapshots(db, "p")
      await expect(describePluginDataRollback(db, "p", "1.4.0")).resolves.toEqual({
        kind: "restore",
        snapshotId: snapshot!.id,
        capturedAt: snapshot!.createdAt,
        dataVersion: 1,
        currentDataVersion: 2,
        currentRows: 3,
        snapshotRows: 2,
      })
    })

    it("says the data cannot be brought back when no snapshot is old enough", async () => {
      await migrateTo(2)
      await expect(describePluginDataRollback(db, "p", "0.9.0")).resolves.toEqual({
        kind: "unavailable",
        currentDataVersion: 2,
        targetDataVersion: 0,
      })
    })
  })

  describe("restoreDataTakenSince", () => {
    it("undoes the migration the failed update ran", async () => {
      const started = Date.now()
      await migrateTo(2)
      await expect(restoreDataTakenSince(db, "p", "1.0.0", started)).resolves.toBe("restored")
      expect(await db.table("p:items").get(1)).toEqual({ id: 1, shape: 1 })
      expect((await db.table("pluginDexieMeta").get("p")).appliedMigrationVersion).toBe(1)
    })

    it("never uses a snapshot from before the update started", async () => {
      await migrateTo(2)
      const [snapshot] = await listPluginDataSnapshots(db, "p")
      await expect(restoreDataTakenSince(db, "p", "1.0.0", snapshot!.createdAt + 1)).resolves.toBe(
        "unavailable"
      )
      expect((await db.table("pluginDexieMeta").get("p")).appliedMigrationVersion).toBe(2)
    })

    it("does nothing when the restored package reads the data", async () => {
      await expect(restoreDataTakenSince(db, "p", "1.0.0", 0)).resolves.toBe("not-needed")
      expect(await listPluginDataSnapshots(db, "p")).toEqual([])
    })
  })
})
