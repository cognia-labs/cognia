/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import type { PluginDexieMeta } from "@/lib/db/schema"

// Mock getDb() to return our test db.
let testDb: (Dexie & { pluginDexieMeta: Dexie.Table<PluginDexieMeta, string> }) | null = null

jest.mock("@/lib/db/schema", () => ({
  getDb: () => testDb,
}))

// Import AFTER mocking so the module picks up our mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dexieMetaModule = require("./meta")
const {
  getPluginDexieMeta,
  putPluginDexiaMeta,
  deletePluginDexiaMeta,
  getAllPluginDexiaMeta,
  baselinePluginMigrationVersion,
} = dexieMetaModule

function makeDb() {
  const db = new Dexie(`test-meta-${Math.random().toString(36).slice(2)}`) as Dexie & {
    pluginDexieMeta: Dexie.Table<PluginDexieMeta, string>
  }
  db.version(1).stores({ pluginDexieMeta: "&pluginId, appliedAt" })
  return db
}

describe("dexie-meta helpers", () => {
  beforeEach(() => {
    testDb = makeDb()
  })

  afterEach(async () => {
    await testDb?.delete()
    testDb = null
  })

  it("initializes only existing legacy rows and never advances an established ledger", async () => {
    expect(await baselinePluginMigrationVersion(testDb!, "missing", 3)).toBeUndefined()
    expect(await getPluginDexieMeta("missing")).toBeUndefined()
    await putPluginDexiaMeta({ pluginId: "legacy", tableNames: [], dexieVersion: 1, appliedAt: 1 })
    expect(await baselinePluginMigrationVersion(testDb!, "legacy", 2)).toBe(2)
    expect(await baselinePluginMigrationVersion(testDb!, "legacy", 3)).toBe(2)
    expect((await getPluginDexieMeta("legacy"))?.appliedMigrationVersion).toBe(2)
  })

  describe("getPluginDexieMeta", () => {
    it("returns undefined for unknown pluginId", async () => {
      const result = await getPluginDexieMeta("unknown")
      expect(result).toBeUndefined()
    })

    it("returns the row when it exists", async () => {
      const row: PluginDexieMeta = {
        pluginId: "github-delivery",
        tableNames: ["github-delivery:repos"],
        dexieVersion: 28,
        appliedAt: 1000,
      }
      await testDb!.pluginDexieMeta.put(row)
      const result = await getPluginDexieMeta("github-delivery")
      expect(result).toEqual(row)
    })
  })

  describe("putPluginDexiaMeta", () => {
    it("does not overwrite a committed migration version with a stale schema repair", async () => {
      const row = {
        pluginId: "migrated",
        tableNames: ["migrated:items"],
        dexieVersion: 5,
        appliedAt: 1,
        appliedMigrationVersion: 1,
      }
      await putPluginDexiaMeta({ ...row, appliedMigrationVersion: 3 })
      await putPluginDexiaMeta({ ...row, dexieVersion: 6 })
      expect(await getPluginDexieMeta("migrated")).toMatchObject({
        dexieVersion: 6,
        appliedMigrationVersion: 3,
      })
    })
    it("persists schema fingerprints and migration versions on the existing row", async () => {
      const row = {
        pluginId: "migrated",
        tableNames: ["migrated:items"],
        dexieVersion: 5,
        appliedAt: 1,
        schemaFingerprint: "sha256",
        appliedMigrationVersion: 3,
      }
      await putPluginDexiaMeta(row)
      expect(await getPluginDexieMeta("migrated")).toEqual(row)
    })
    it("inserts and retrieves a row", async () => {
      const row: PluginDexieMeta = {
        pluginId: "test-plugin",
        tableNames: ["test-plugin:items"],
        dexieVersion: 5,
        appliedAt: 2000,
      }
      await putPluginDexiaMeta(row)
      const result = await testDb!.pluginDexieMeta.get("test-plugin")
      expect(result).toEqual(row)
    })

    it("overwrites an existing row (upsert)", async () => {
      const row: PluginDexieMeta = {
        pluginId: "test-plugin",
        tableNames: ["test-plugin:items"],
        dexieVersion: 5,
        appliedAt: 2000,
      }
      await putPluginDexiaMeta(row)
      await putPluginDexiaMeta({ ...row, dexieVersion: 6, appliedAt: 3000 })
      const result = await testDb!.pluginDexieMeta.get("test-plugin")
      expect(result!.dexieVersion).toBe(6)
    })
  })

  describe("deletePluginDexiaMeta", () => {
    it("removes the row", async () => {
      await testDb!.pluginDexieMeta.put({
        pluginId: "to-delete",
        tableNames: [],
        dexieVersion: 1,
        appliedAt: 0,
      })
      await deletePluginDexiaMeta("to-delete")
      const result = await testDb!.pluginDexieMeta.get("to-delete")
      expect(result).toBeUndefined()
    })

    it("is a no-op for non-existent pluginId", async () => {
      await expect(deletePluginDexiaMeta("ghost")).resolves.toBeUndefined()
    })
  })

  describe("getAllPluginDexiaMeta", () => {
    it("returns all rows", async () => {
      await testDb!.pluginDexieMeta.bulkPut([
        { pluginId: "a", tableNames: [], dexieVersion: 1, appliedAt: 0 },
        { pluginId: "b", tableNames: [], dexieVersion: 2, appliedAt: 0 },
      ])
      const result = await getAllPluginDexiaMeta()
      expect(result).toHaveLength(2)
    })

    it("returns empty array when table is empty", async () => {
      const result = await getAllPluginDexiaMeta()
      expect(result).toEqual([])
    })
  })
})
