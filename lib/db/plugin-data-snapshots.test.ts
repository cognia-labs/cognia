/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { CURRENT_SCHEMA } from "./schema"
import {
  deletePluginDataSnapshotRecords,
  listPluginDataSnapshots,
  pluginDataSnapshotStores,
  type PluginDataSnapshotRecord,
} from "./plugin-data-snapshots"

const skipped = (id: string, pluginId: string, createdAt: number): PluginDataSnapshotRecord => ({
  kind: "skipped",
  id,
  pluginId,
  dataVersion: 1,
  migratedTo: 2,
  createdAt,
  reason: "insufficient-space",
})

describe("plugin data snapshot stores", () => {
  let db: Dexie
  beforeEach(async () => {
    db = new Dexie(`plugin-data-snapshots-${crypto.randomUUID()}`)
    db.version(1).stores({
      pluginDataSnapshots: CURRENT_SCHEMA.pluginDataSnapshots!,
      pluginDataSnapshotRows: CURRENT_SCHEMA.pluginDataSnapshotRows!,
    })
    await db.open()
  })
  afterEach(async () => {
    await db.delete()
  })

  it("lists one plugin's snapshots, newest first", async () => {
    const { snapshots } = pluginDataSnapshotStores(db)
    await snapshots.bulkPut([skipped("a", "p", 1), skipped("b", "p", 3), skipped("c", "q", 2)])
    expect((await listPluginDataSnapshots(db, "p")).map((record) => record.id)).toEqual(["b", "a"])
  })

  it("deletes snapshots with their rows, and nothing else", async () => {
    const { snapshots, chunks } = pluginDataSnapshotStores(db)
    await snapshots.bulkPut([skipped("a", "p", 1), skipped("b", "p", 2)])
    await chunks.bulkPut([
      { snapshotId: "a", table: "p:items", chunk: 0, values: [1] },
      { snapshotId: "a", table: "p:items", chunk: 1, values: [2] },
      { snapshotId: "b", table: "p:items", chunk: 0, values: [3] },
    ])
    await deletePluginDataSnapshotRecords(db, ["a"])
    expect(await snapshots.toCollection().primaryKeys()).toEqual(["b"])
    expect(await chunks.toArray()).toEqual([
      { snapshotId: "b", table: "p:items", chunk: 0, values: [3] },
    ])
    await expect(deletePluginDataSnapshotRecords(db, [])).resolves.toBeUndefined()
  })
})
