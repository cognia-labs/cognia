/**
 * Brain durability (ADR-0059): `startDurability` arms the SQLite durability
 * store for one account, plus its exit hooks and RSS gauge.
 *
 * Every boot must meet an unopened `CogniaDB`: the store installs its capture
 * middleware before Dexie opens and refuses an already-open database, and
 * `lib/db/schema.ts` caches ONE singleton per module registry. `resetDb()`
 * deletes and forgets it around every test.
 *
 * @jest-environment node
 */
import fs from "node:fs"
import { getDb } from "@/lib/db/schema"
import os from "node:os"
import path from "node:path"

import { DEFAULT_EXECUTION_CONFIG, DEFAULT_NOTIFICATION_CONFIG } from "@/types/scheduler"

import { startDurability } from "./durability"
import { durabilityRoot } from "./persistence/backend"
import { encodeKey } from "./persistence/canonical"
import { openSqliteBackend, sqliteFile } from "./persistence/sqlite"
import { hasLiveWriter } from "./persistence/writer-lock"
import { __resetCliDbForTesting } from "../db/bootstrap"

jest.setTimeout(30_000)

/** Forget the in-memory database, so the next boot only sees what durability restores. */
async function resetDb(): Promise<void> {
  const { __resetDbForTesting } = await import("@/lib/db/schema")
  await getDb()
    .delete()
    .catch(() => {})
  __resetDbForTesting()
  __resetCliDbForTesting()
}

function session(id: string) {
  return { id, title: id, createdAt: Date.now(), updatedAt: Date.now() } as never
}

type Proc = Pick<NodeJS.Process, "on" | "off" | "memoryUsage">

function fakeProc(rss: () => number, listeners = new Map<string, () => void>()): Proc {
  const proc = {
    on: (event: string, fn: () => void) => {
      listeners.set(event, fn)
      return proc
    },
    off: (event: string) => {
      listeners.delete(event)
      return proc
    },
    memoryUsage: () => ({ rss: rss() }) as NodeJS.MemoryUsage,
  }
  return proc as unknown as Proc
}

beforeAll(async () => {
  const { installFakeIndexedDb } = await import("@/lib/headless/node-indexeddb")
  await installFakeIndexedDb()
})

beforeEach(resetDb)
afterEach(resetDb)

describe("startDurability", () => {
  it("boots a fresh account on sqlite and persists the first commit", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sqlite-default-"))
    let second: Awaited<ReturnType<typeof startDurability>> | undefined
    try {
      const first = await startDurability({ home, accountId: "acct_fresh" })
      expect(first.backend).toBe("sqlite-v5")
      // Before seeding an empty store, this first commit referenced a database
      // with no schema row and failed its foreign key.
      await getDb().sessions.put(session("fresh-session"))
      await first.dispose()
      expect(fs.existsSync(sqliteFile(durabilityRoot(home, "acct_fresh")))).toBe(true)

      await resetDb()
      second = await startDurability({ home, accountId: "acct_fresh" })
      expect(second.backend).toBe("sqlite-v5")
      expect(await getDb().sessions.get("fresh-session")).toEqual(
        expect.objectContaining({ id: "fresh-session" })
      )
    } finally {
      await second?.dispose()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("retains device-local kept-copy bindings across a restart", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-kept-copy-"))
    const row = {
      captureId: "capture",
      providerId: "plugin:vendor/docs",
      connectionRef: "local-ref",
      identityKey: "local-identity",
      capturedAt: 1,
      sourceDeletedAt: 2,
    }
    let durability: Awaited<ReturnType<typeof startDurability>> | undefined
    try {
      durability = await startDurability({ home, accountId: "acct_kept" })
      await getDb().remoteDocumentConnections.put(row as never)
      await durability.dispose()
      await resetDb()
      durability = await startDurability({ home, accountId: "acct_kept" })
      expect(await getDb().remoteDocumentConnections.get(row.captureId)).toEqual(row)
    } finally {
      await durability?.dispose()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("arms the signal hooks, reports the rss gauge and detaches on dispose", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-durability-"))
    const listeners = new Map<string, () => void>()
    try {
      const durability = await startDurability({
        home,
        accountId: "acct_test_1",
        proc: fakeProc(() => 42_000_000, listeners),
      })
      expect([...listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"])

      const before = durability.rss()
      expect(before.rssBytes).toBe(42_000_000)
      expect(before.lastFlushAt).toBe(0)

      // Every commit is already durable: the write hook is a no-op.
      expect(() => durability.notifyDbWrite()).not.toThrow()
      await getDb().sessions.put(session("gauge-session"))
      expect(durability.rss().lastFlushAt).toBe(1)

      await durability.dispose()
      expect(listeners.size).toBe(0)
      expect(hasLiveWriter(durabilityRoot(home, "acct_test_1"), "sqlite")).toBe(false)
      // Idempotent.
      await durability.dispose()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("alerts once per RSS ceiling crossing and re-arms after recovery", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-rss-"))
    let rssBytes = 120
    const onRssWarning = jest.fn()
    try {
      const durability = await startDurability({
        home,
        accountId: "acct_rss",
        proc: fakeProc(() => rssBytes),
        rssWarningBytes: 100,
        onRssWarning,
      })
      durability.rss()
      durability.rss()
      expect(onRssWarning).toHaveBeenCalledTimes(1)
      expect(onRssWarning).toHaveBeenCalledWith(120, 100)

      rssBytes = 80
      durability.rss()
      rssBytes = 130
      durability.rss()
      expect(onRssWarning).toHaveBeenCalledTimes(2)
      await durability.dispose()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // A brain is stopped with a signal far more often than it is disposed
  // cleanly, so SIGTERM must release the store with every commit on disk.
  it("closes the store on SIGTERM and keeps every commit", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-signal-"))
    const root = durabilityRoot(home, "acct_signal")
    const listeners = new Map<string, () => void>()
    let durability: Awaited<ReturnType<typeof startDurability>> | undefined
    let revived: Awaited<ReturnType<typeof startDurability>> | undefined
    try {
      durability = await startDurability({
        home,
        accountId: "acct_signal",
        proc: fakeProc(() => 1, listeners),
      })
      await getDb().sessions.put(session("signalled-session"))
      expect(hasLiveWriter(root, "sqlite")).toBe(true)

      listeners.get("SIGTERM")!()
      for (let attempt = 0; attempt < 400 && hasLiveWriter(root, "sqlite"); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(hasLiveWriter(root, "sqlite")).toBe(false)
      expect(listeners.size).toBe(0)

      await resetDb()
      revived = await startDurability({ home, accountId: "acct_signal" })
      expect(await getDb().sessions.get("signalled-session")).toEqual(
        expect.objectContaining({ id: "signalled-session" })
      )
    } finally {
      await durability?.dispose().catch(() => {})
      await revived?.dispose().catch(() => {})
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // A `cognia serve` brain that restarts must come back with its schedule
  // intact. The schedule used to be a second database that was never
  // persisted, so the brain rebooted with an empty task table while still
  // reporting the scheduler runtime as running. Since schema v219 it is
  // `scheduledTasks` inside the account database, and the guard that survives
  // is the same one: the schedule persists, the run history does not.
  it("round-trips a scheduled task across a restart, without persisting executions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-sched-"))
    const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
    const now = new Date()
    const task = {
      id: "task_persist_1",
      name: "brain digest",
      type: "connection:scheduled:digest",
      trigger: { type: "interval" as const, intervalMs: 3_600_000 },
      payload: { adapterId: "a1", conversationKey: "k1", characterId: "c1", prompt: "hi" },
      config: DEFAULT_EXECUTION_CONFIG,
      notification: DEFAULT_NOTIFICATION_CONFIG,
      status: "active" as const,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    }

    let second: Awaited<ReturnType<typeof startDurability>> | undefined
    try {
      const first = await startDurability({ home, accountId: "acct_sched" })
      const name = getDb().name
      await schedulerDb.createTask(task as never)
      await schedulerDb.createExecution({
        id: "exec_1",
        taskId: task.id,
        taskName: task.name,
        taskType: task.type,
        status: "completed",
        retryAttempt: 0,
        startedAt: now,
        logs: [],
      } as never)
      await first.dispose()

      // The durable store carries the task but not the execution history.
      const backend = openSqliteBackend({ root: durabilityRoot(home, "acct_sched") })
      try {
        const persisted = (await backend.load()).dbs[name]
        expect(persisted.schema.tables).toContain("scheduledTasks")
        expect(persisted.schema.tables).not.toContain("scheduledTaskRuns")
        expect(persisted.rows.scheduledTasks[encodeKey(task.id)]).toBeDefined()
        expect(persisted.rows.scheduledTaskRuns).toBeUndefined()
      } finally {
        await backend.close()
      }

      // Restart: a fresh in-memory database, restored from disk alone.
      await resetDb()
      second = await startDurability({ home, accountId: "acct_sched" })
      expect(await schedulerDb.getTask(task.id)).not.toBeNull()
      expect(await getDb().scheduledTaskRuns.count()).toBe(0)
    } finally {
      await second?.dispose()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("ledger restore over built-in plugin tables", () => {
  // A built-in plugin's tables lift the account database one version above the
  // code's once they exist, and a compaction pins that version into the
  // store. A restarted brain opens at the code version, before any plugin
  // runs; without re-declaring those tables first, the restore refused the
  // store and the brain exited on every start (the always-on host's bot
  // went down this way after one image update).
  it("restores a store persisted above the code version", async () => {
    const [{ installFakeIndexedDb }, { __resetDbForTesting, CURRENT_SCHEMA_VERSION }] =
      await Promise.all([import("@/lib/headless/node-indexeddb"), import("@/lib/db/schema")])
    const [{ openDurabilityStore }, { restorePluginTables }, { getBrowserBuiltinRegistry }] =
      await Promise.all([
        import("./persistence/store"),
        import("@/lib/plugin/dexie/bridge"),
        import("@/lib/plugin/core/browser-builtin-registry"),
      ])
    const { prepareBuiltinPluginSchema } = await import("../db/bootstrap")
    await installFakeIndexedDb()
    __resetCliDbForTesting()
    __resetDbForTesting()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-plugin-"))
    // The plugin whose tables lifted the box's account database.
    const plugin = getBrowserBuiltinRegistry().find(
      (entry) => entry.manifest.id === "zhihu-content-pipeline"
    )!
    const table = `${plugin.manifest.id}:${plugin.manifest.dexie!.tables[0].name}`
    const sources = async () => {
      const db = getDb()
      return [{ name: db.name, db: db as never }]
    }

    try {
      const first = await openDurabilityStore({
        home,
        accountId: "acct_plugin",
        getSources: sources,
        compactEveryCommits: 0,
      })
      await restorePluginTables(
        () => getDb(),
        new Map([[plugin.manifest.id, plugin.manifest.dexie!]]),
        { registerMissing: true }
      )
      expect(getDb().verno).toBe(CURRENT_SCHEMA_VERSION + 1)
      await getDb().table(table).put({ id: "row-1" })
      const binding = {
        consumerPluginId: "calendar",
        providerId: "vendor",
        connectionRef: "host-ref",
        createdAt: 1,
        updatedAt: 1,
      }
      await getDb().table("connectionBindings").put(binding)
      await first.compact()
      await first.close()

      // Restart: a fresh in-memory database at the code version.
      await getDb().delete()
      __resetDbForTesting()

      const second = await openDurabilityStore({
        home,
        accountId: "acct_plugin",
        getSources: sources,
        prepareDynamicSchema: (dbs, versions) => prepareBuiltinPluginSchema(dbs as never, versions),
      })
      expect(getDb().verno).toBe(CURRENT_SCHEMA_VERSION + 1)
      expect(await getDb().table(table).get("row-1")).toEqual({ id: "row-1" })
      expect(await getDb().table("connectionBindings").get(["calendar", "vendor"])).toEqual(binding)
      await second.close()
    } finally {
      await getDb()
        .delete()
        .catch(() => {})
      __resetDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("plugin tables after the code version catches up", () => {
  // Code 247 + one plugin lifts the store to 248; a later build whose own
  // schema is 248 then opens at the same number without the plugin table, and
  // the version alone used to say "nothing to lift", dropping the plugin rows.
  it("re-declares the persisted plugin tables before restoring", async () => {
    const [{ installFakeIndexedDb }, { __resetDbForTesting, CURRENT_SCHEMA_VERSION }] =
      await Promise.all([import("@/lib/headless/node-indexeddb"), import("@/lib/db/schema")])
    const [{ openDurabilityStore }, { restorePluginTables }, { getBrowserBuiltinRegistry }] =
      await Promise.all([
        import("./persistence/store"),
        import("@/lib/plugin/dexie/bridge"),
        import("@/lib/plugin/core/browser-builtin-registry"),
      ])
    const { prepareBuiltinPluginSchema } = await import("../db/bootstrap")
    await installFakeIndexedDb()
    __resetCliDbForTesting()
    __resetDbForTesting()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-catchup-"))
    const plugin = getBrowserBuiltinRegistry().find(
      (entry) => entry.manifest.id === "zhihu-content-pipeline"
    )!
    const table = `${plugin.manifest.id}:${plugin.manifest.dexie!.tables[0].name}`
    const sources = async () => {
      const db = getDb()
      return [{ name: db.name, db: db as never }]
    }

    try {
      const first = await openDurabilityStore({
        home,
        accountId: "acct_catchup",
        getSources: sources,
        compactEveryCommits: 0,
      })
      await restorePluginTables(
        () => getDb(),
        new Map([[plugin.manifest.id, plugin.manifest.dexie!]]),
        { registerMissing: true }
      )
      await getDb().table(table).put({ id: "row-1" })
      await first.compact()
      await first.close()

      await getDb().delete()
      __resetDbForTesting()
      // The "newer build": its own schema already reaches the persisted number.
      getDb()
        .version(CURRENT_SCHEMA_VERSION + 1)
        .stores({})

      const second = await openDurabilityStore({
        home,
        accountId: "acct_catchup",
        getSources: sources,
        prepareDynamicSchema: (dbs, versions, tables) =>
          prepareBuiltinPluginSchema(dbs as never, versions, tables),
      })
      expect(await getDb().table(table).get("row-1")).toEqual({ id: "row-1" })
      await second.close()
    } finally {
      await getDb()
        .delete()
        .catch(() => {})
      __resetDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("value codec 1", () => {
  // What IndexedDB keeps for a row (structured clone) must be what a restart
  // hands back.
  it("round-trips every structured-clone type across a restart", async () => {
    const [{ installFakeIndexedDb }, { __resetDbForTesting }] = await Promise.all([
      import("@/lib/headless/node-indexeddb"),
      import("@/lib/db/schema"),
    ])
    await installFakeIndexedDb()
    __resetCliDbForTesting()
    __resetDbForTesting()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-serve-codec-"))
    const accountId = "acct_codec"
    const large = Uint8Array.from({ length: 40_000 }, (_, index) => index % 251)
    const holes = [1, , 3]
    const row = {
      id: "pack-1",
      displayName: "Pack",
      createdAt: 1,
      large: new Blob([large], { type: "video/mp4" }),
      small: new Blob([Uint8Array.from([1, 2, 3])], { type: "image/png" }),
      file: new File([Uint8Array.from([9])], "a.txt", { type: "text/plain", lastModified: 5 }),
      u16: Uint16Array.from([1, 65535]),
      f64: Float64Array.from([Math.PI]),
      buffer: Uint8Array.from([7, 8]).buffer,
      view: new DataView(Uint8Array.from([4, 5]).buffer),
      at: new Date("2026-11-01T00:00:00.000Z"),
      map: new Map<string, unknown>([["k", new Date(0)]]),
      set: new Set([1, "two"]),
      pattern: /ab+/gi,
      failure: new RangeError("boom"),
      special: [Number.NaN, -0, Infinity],
      big: BigInt("12345678901234567890"),
      gone: undefined,
      holes,
    }
    const tag = (value: unknown) => Object.prototype.toString.call(value)
    let second: Awaited<ReturnType<typeof startDurability>> | undefined
    try {
      const first = await startDurability({ home, accountId })
      await getDb().table("petMediaPacks").put(row)
      await first.dispose()
      // Restart: a fresh in-memory database, restored from disk alone.
      await getDb().delete()
      __resetDbForTesting()
      __resetCliDbForTesting()

      second = await startDurability({ home, accountId })
      const back = (await getDb().table("petMediaPacks").get("pack-1")) as typeof row & {
        view: DataView
      }
      expect(back).toBeDefined()
      expect(tag(back.large)).toBe("[object Blob]")
      expect(back.large.type).toBe("video/mp4")
      expect(new Uint8Array(await back.large.arrayBuffer())).toEqual(large)
      expect(Array.from(new Uint8Array(await back.small.arrayBuffer()))).toEqual([1, 2, 3])
      expect(tag(back.file)).toBe("[object File]")
      expect([back.file.name, back.file.lastModified, back.file.type]).toEqual([
        "a.txt",
        5,
        "text/plain",
      ])
      expect(tag(back.u16)).toBe("[object Uint16Array]")
      expect(Array.from(back.u16)).toEqual([1, 65535])
      expect(tag(back.f64)).toBe("[object Float64Array]")
      expect(tag(back.buffer)).toBe("[object ArrayBuffer]")
      expect(Array.from(new Uint8Array(back.buffer))).toEqual([7, 8])
      expect(tag(back.view)).toBe("[object DataView]")
      expect(back.view.getUint8(1)).toBe(5)
      expect(tag(back.at)).toBe("[object Date]")
      expect(back.at.toISOString()).toBe("2026-11-01T00:00:00.000Z")
      expect(tag(back.map)).toBe("[object Map]")
      expect(tag(back.map.get("k"))).toBe("[object Date]")
      expect([...back.set]).toEqual([1, "two"])
      expect(String(back.pattern)).toBe("/ab+/gi")
      expect([back.failure.name, back.failure.message]).toEqual(["RangeError", "boom"])
      expect(back.special[0]).toBeNaN()
      expect(Object.is(back.special[1], -0)).toBe(true)
      expect(back.special[2]).toBe(Infinity)
      expect(back.big).toBe(BigInt("12345678901234567890"))
      expect(Object.hasOwn(back, "gone")).toBe(true)
      expect(back.holes).toHaveLength(3)
      expect(Object.hasOwn(back.holes, 1)).toBe(false)
      await second.dispose()
    } finally {
      await getDb()
        .delete()
        .catch(() => {})
      __resetDbForTesting()
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
