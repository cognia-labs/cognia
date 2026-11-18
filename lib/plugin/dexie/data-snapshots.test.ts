/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"
import { CURRENT_SCHEMA } from "@/lib/db/schema"
import {
  listPluginDataSnapshots,
  pluginDataSnapshotStores,
  type CapturedPluginDataSnapshot,
  type PluginDataSnapshotRecord,
} from "@/lib/db/plugin-data-snapshots"
import {
  SNAPSHOT_CHUNK_ROWS,
  capturePluginDataSnapshot,
  deletePluginDataSnapshots,
  estimatePluginDataBytes,
  estimateValueBytes,
  isQuotaExceeded,
  pluginDataVersionOf,
  prunePluginDataSnapshots,
  recordSkippedPluginDataSnapshot,
  selectRestoreSnapshot,
  snapshotSpaceRequired,
  storageHeadroom,
} from "./data-snapshots"

function captured(id: string, dataVersion: number, createdAt: number): CapturedPluginDataSnapshot {
  return {
    kind: "captured",
    id,
    pluginId: "p",
    dataVersion,
    migratedTo: dataVersion + 1,
    createdAt,
    tables: [],
    rows: 0,
    bytes: 0,
  }
}

describe("pluginDataVersionOf", () => {
  it("is the package's major version", () => {
    expect(pluginDataVersionOf("3.4.5")).toBe(3)
    expect(pluginDataVersionOf("12.0.0-beta.1")).toBe(12)
  })
})

describe("estimateValueBytes", () => {
  it("counts strings, numbers, binaries and nested values once", () => {
    const shared = { label: "ab" }
    expect(estimateValueBytes("abcd")).toBe(8)
    expect(estimateValueBytes(1)).toBe(8)
    expect(estimateValueBytes(new Uint8Array(10))).toBe(10)
    expect(estimateValueBytes(new Blob(["12345"]))).toBe(5)
    expect(estimateValueBytes({ a: shared, b: shared })).toBe(
      2 + (10 + 4) + 2 // "a" key + label key/value; the second reference is not counted
    )
    expect(estimateValueBytes(new Map([["k", 1]]))).toBe(10)
    expect(estimateValueBytes(null)).toBe(0)
  })
})

describe("snapshotSpaceRequired", () => {
  it("leaves room for encryption and IndexedDB overhead", () => {
    expect(snapshotSpaceRequired(0)).toBe(1024 * 1024)
    expect(snapshotSpaceRequired(1000)).toBe(2000 + 1024 * 1024)
  })
})

describe("storageHeadroom", () => {
  const setStorage = (value: unknown) =>
    Object.defineProperty(globalThis.navigator, "storage", { configurable: true, value })
  afterEach(() => setStorage(undefined))

  it("is the unused quota when the platform reports one", async () => {
    setStorage({ estimate: async () => ({ quota: 500, usage: 120 }) })
    await expect(storageHeadroom()).resolves.toBe(380)
  })

  it("is unknown when the platform cannot say", async () => {
    setStorage(undefined)
    await expect(storageHeadroom()).resolves.toBeUndefined()
    setStorage({
      estimate: async () => {
        throw new Error("denied")
      },
    })
    await expect(storageHeadroom()).resolves.toBeUndefined()
    setStorage({ estimate: async () => ({}) })
    await expect(storageHeadroom()).resolves.toBeUndefined()
  })
})

describe("isQuotaExceeded", () => {
  it("finds a quota failure however Dexie wrapped it", () => {
    const quota = { name: "QuotaExceededError" }
    expect(isQuotaExceeded(quota)).toBe(true)
    expect(isQuotaExceeded({ name: "AbortError", inner: quota })).toBe(true)
    expect(
      isQuotaExceeded({ name: "BulkError", failures: [{ name: "ConstraintError" }, quota] })
    ).toBe(true)
    expect(isQuotaExceeded(Object.assign(new Error("x"), { cause: quota }))).toBe(true)
    expect(isQuotaExceeded(new Error("bad upgrade"))).toBe(false)
    expect(isQuotaExceeded(undefined)).toBe(false)
  })
})

describe("selectRestoreSnapshot", () => {
  it("takes the closest captured data version at or below the target", () => {
    const records: PluginDataSnapshotRecord[] = [
      captured("v3", 3, 30),
      {
        kind: "skipped",
        id: "v2-skipped",
        pluginId: "p",
        dataVersion: 2,
        migratedTo: 3,
        createdAt: 20,
        reason: "insufficient-space",
      },
      captured("v1", 1, 10),
    ]
    expect(selectRestoreSnapshot(records, 3)?.id).toBe("v3")
    // Nothing captured at 2: the snapshot of 1 is the closest that exists.
    expect(selectRestoreSnapshot(records, 2)?.id).toBe("v1")
    expect(selectRestoreSnapshot(records, 0)).toBeUndefined()
  })

  it("prefers the newest of two snapshots of one data version", () => {
    expect(selectRestoreSnapshot([captured("old", 1, 10), captured("new", 1, 20)], 1)?.id).toBe(
      "new"
    )
  })
})

describe("snapshot storage", () => {
  let db: Dexie
  beforeEach(async () => {
    db = new Dexie(`data-snapshots-${crypto.randomUUID()}`)
    db.version(1).stores({
      pluginDataSnapshots: CURRENT_SCHEMA.pluginDataSnapshots!,
      pluginDataSnapshotRows: CURRENT_SCHEMA.pluginDataSnapshotRows!,
      "p:items": "++id, name",
      "p:kv": "",
    })
    await db.open()
  })
  afterEach(async () => {
    await db.delete()
  })

  // An async scope function: Dexie only keeps the transaction across native
  // awaits for those, which is how every production caller writes it.
  const capture = (tableNames = ["p:items"]) =>
    db.transaction(
      "rw",
      ["pluginDataSnapshots", "pluginDataSnapshotRows", ...tableNames],
      async () =>
        capturePluginDataSnapshot(db, {
          pluginId: "p",
          tableNames,
          dataVersion: 1,
          migratedTo: 2,
          bytes: 42,
        })
    )

  it("estimates from a sample of each table", async () => {
    await db.table("p:items").bulkAdd(Array.from({ length: 3 }, () => ({ name: "abcd" })))
    const perRow = estimateValueBytes({ id: 1, name: "abcd" })
    await expect(estimatePluginDataBytes(db, ["p:items", "p:kv"])).resolves.toBe(perRow * 3)
  })

  it("copies rows in chunks and records the schema each store had", async () => {
    const total = SNAPSHOT_CHUNK_ROWS * 2 + 5
    await db.table("p:items").bulkAdd(Array.from({ length: total }, (_, i) => ({ name: `n${i}` })))

    const snapshot = await capture()

    expect(snapshot).toMatchObject({
      kind: "captured",
      dataVersion: 1,
      migratedTo: 2,
      rows: total,
      bytes: 42,
      tables: [
        { name: "p:items", schema: "++id, name", rows: total, chunks: 3, outboundKeys: false },
      ],
    })
    const { chunks } = pluginDataSnapshotStores(db)
    const last = await chunks.get([snapshot.id, "p:items", 2])
    expect(last?.values).toHaveLength(5)
    expect(last?.keys).toBeUndefined()
    expect((await chunks.get([snapshot.id, "p:items", 0]))?.values[0]).toEqual({
      id: 1,
      name: "n0",
    })
  })

  it("keeps outbound keys next to their values", async () => {
    await db.table("p:kv").bulkPut([{ v: "a" }, { v: "b" }], ["k1", "k2"])
    const snapshot = await capture(["p:kv"])
    expect(snapshot.tables[0]).toMatchObject({ outboundKeys: true, rows: 2, chunks: 1 })
    expect(await pluginDataSnapshotStores(db).chunks.get([snapshot.id, "p:kv", 0])).toMatchObject({
      keys: ["k1", "k2"],
      values: [{ v: "a" }, { v: "b" }],
    })
  })

  it("records an empty table with no chunks", async () => {
    const snapshot = await capture()
    expect(snapshot.tables[0]).toMatchObject({ rows: 0, chunks: 0 })
  })

  it("orders snapshots strictly even within one millisecond", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(1000)
    try {
      const first = await capture()
      const skipped = await db.transaction("rw", ["pluginDataSnapshots"], async () =>
        recordSkippedPluginDataSnapshot(db, { pluginId: "p", dataVersion: 2, migratedTo: 3 })
      )
      expect(skipped.createdAt).toBeGreaterThan(first.createdAt)
      expect((await listPluginDataSnapshots(db, "p")).map((record) => record.id)).toEqual([
        skipped.id,
        first.id,
      ])
    } finally {
      now.mockRestore()
    }
  })

  it("prunes to the newest snapshots and deletes their rows", async () => {
    await db.table("p:items").add({ name: "x" })
    const oldest = await capture()
    await capture()
    await capture()
    await prunePluginDataSnapshots(db, "p")
    const kept = await listPluginDataSnapshots(db, "p")
    expect(kept).toHaveLength(2)
    expect(kept.map((record) => record.id)).not.toContain(oldest.id)
    expect(await pluginDataSnapshotStores(db).chunks.count()).toBe(2)

    await deletePluginDataSnapshots(db, "p")
    expect(await listPluginDataSnapshots(db, "p")).toEqual([])
    expect(await pluginDataSnapshotStores(db).chunks.count()).toBe(0)
  })
})
