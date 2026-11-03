/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { purgePluginExternalServices } from "./lifecycle"
import { registerExternalSync, requestExternalSync } from "./sync/runtime"
import { externalSyncRenewalTaskId } from "./sync/renewal"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { clearPluginTables } from "@/lib/plugin/dexie/bridge"
import Dexie from "dexie"
import { queueAccessTeardown, runAccessTeardown } from "./access-teardown"
import {
  listDerivedDataPurgerIds,
  purgeDerivedData,
  registerDerivedDataPurger,
} from "./derived-data-registry"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function independentSyncCore(): typeof import("./sync/core") {
  const schema = jest.requireActual("@/lib/db/schema")
  let core!: typeof import("./sync/core")
  jest.isolateModules(() => {
    // Independent activeRuns and lease/lock runtimes, sharing the fixture's IDB.
    jest.doMock("@/lib/db/schema", () => schema)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    core = require("./sync/core")
  })
  jest.dontMock("@/lib/db/schema")
  return core
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

it("pins the Host purgers with connection provenance today", () => {
  expect(listDerivedDataPurgerIds()).toEqual([
    "integration-events",
    "integration-ingress",
    "integration-event-audit",
    "external-sync",
    "github-issue-mirror",
  ])
})

it.each(["connection", "consumer", "plugin-data", "provider-data"] as const)(
  "purges only the mirror rows owned by a %s, after its sync cursors are gone",
  async (kind) => {
    const db = getDb()
    const rows = [
      {
        id: "a/r#1",
        repoFullName: "a/r",
        connectionRef: "a",
        consumerPluginId: "reader",
        providerPluginId: "auth",
      },
      {
        id: "a/s#1",
        repoFullName: "a/s",
        connectionRef: "a",
        consumerPluginId: "other",
        providerPluginId: "auth",
      },
      {
        id: "b/r#1",
        repoFullName: "b/r",
        connectionRef: "b",
        consumerPluginId: "other",
        providerPluginId: "other-auth",
      },
      { id: "legacy/r#1", repoFullName: "legacy/r" },
    ]
    await db.githubIssueMirror.bulkPut(rows as never)
    await db.externalSyncCursors.put({
      key: "github-mirror:p:a/r",
      owner: "plugin:reader",
      connectionRef: "a" as never,
      failures: 0,
    })
    const target =
      kind === "connection"
        ? { kind: "connection" as const, ref: "a" as never }
        : kind === "consumer"
          ? { kind: "consumer" as const, ref: "a" as never, consumerPluginId: "reader" }
          : { kind: "plugin-data" as const, pluginId: kind === "provider-data" ? "auth" : "reader" }
    // Exercise the real registry: external-sync runs first and removes its only identity record.
    expect((await purgeDerivedData(target)).failed).toEqual([])
    if (kind !== "provider-data") expect(await db.externalSyncCursors.count()).toBe(0)
    expect((await db.githubIssueMirror.toArray()).map((row) => row.id).sort()).toEqual(
      kind === "connection" || kind === "provider-data"
        ? ["b/r#1", "legacy/r#1"]
        : ["a/s#1", "b/r#1", "legacy/r#1"]
    )
    // Retry has no cursor to consult, and must produce the same isolated result.
    expect((await purgeDerivedData(target)).failed).toEqual([])
  }
)

it("purges connection checkpoints, seen ids, renewal tasks and in-flight runtime work", async () => {
  const db = getDb()
  await db.authConnections.put({ id: "ref", status: "connected" } as never)
  await db.externalSyncCursors.bulkPut([
    { key: "owned", owner: "host", connectionRef: "ref" as never, failures: 0 },
    { key: "other", owner: "host", connectionRef: "other-ref" as never, failures: 0 },
  ])
  await db.externalSyncSeen.bulkPut([
    { key: "owned", generation: "old", itemId: "a" },
    { key: "other", generation: "old", itemId: "b" },
  ])
  await schedulerDb.createTask({
    id: externalSyncRenewalTaskId("owned"),
    name: "test",
    type: "external-sync-renewal",
    trigger: { type: "once", runAt: new Date(Date.now() + 60_000) },
    payload: { key: "owned" },
    status: "active",
    config: {},
    notification: {},
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never)
  let entered!: () => void
  let aborted!: () => void
  const started = new Promise<void>((r) => {
    entered = r
  })
  const cancelled = new Promise<void>((r) => {
    aborted = r
  })
  const unregister = registerExternalSync(
    { key: "owned", owner: "host", connectionRef: "ref" as never },
    () => ({
      itemId: String,
      fetchPage: async ({ signal }) => {
        entered()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted()
              resolve()
            },
            { once: true }
          )
        )
        return { items: [], cursor: "late" }
      },
      applyPage: async () => {},
    })
  )
  requestExternalSync("owned", "manual")
  await started
  const report = await purgeDerivedData({ kind: "connection", ref: "ref" as never })
  await cancelled
  expect(report.failed).toEqual([])
  expect(await db.externalSyncCursors.get("owned")).toBeUndefined()
  expect(await db.externalSyncCursors.get("other")).toBeDefined()
  expect((await db.externalSyncSeen.toArray()).map((row) => row.key)).toEqual(["other"])
  expect(await schedulerDb.getTask(externalSyncRenewalTaskId("owned"))).toBeNull()
  unregister()
})

it.each(["uninstall", "delete-data"])(
  "the real plugin %s purges sync state even without plugin tables",
  async (path) => {
    await getDb().externalSyncCursors.bulkPut([
      { key: "one", owner: "plugin:one", failures: 0 },
      { key: "two", owner: "plugin:two", failures: 0 },
      { key: "host", owner: "host", failures: 0 },
    ])
    await getDb().externalSyncSeen.put({ key: "one", generation: "pending", itemId: "a" })
    await schedulerDb.createTask({
      id: externalSyncRenewalTaskId("one"),
      name: "test",
      type: "external-sync-renewal",
      trigger: { type: "once", runAt: new Date(Date.now() + 60_000) },
      payload: { key: "one" },
      status: "active",
      config: {},
      notification: {},
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never)
    expect(await getDb().pluginDexieMeta.get("one")).toBeUndefined()
    if (path === "uninstall") await purgePluginExternalServices("one")
    else await clearPluginTables(getDb(), "one")
    expect(await getDb().externalSyncCursors.get("one")).toBeUndefined()
    expect(await getDb().externalSyncSeen.count()).toBe(0)
    expect(await schedulerDb.getTask(externalSyncRenewalTaskId("one"))).toBeNull()
    expect((await getDb().externalSyncCursors.toArray()).map((row) => row.key).sort()).toEqual([
      "host",
      "two",
    ])
  }
)

it.each(["debounce", "factory"] as const)(
  "purges an unpersisted registration during %s before it can recreate state",
  async (phase) => {
    await getDb().authConnections.put({ id: "pending-ref", status: "connected" } as never)
    let resolveFactory!: (driver: import("./sync/types").ExternalSyncDriver<string>) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const driver = {
      itemId: String,
      fetchPage: jest.fn(async () => ({ items: [], cursor: "late" })),
      applyPage: jest.fn(async () => {}),
    }
    const key = `pending-${phase}`
    const factory = jest.fn(() => {
      entered()
      return new Promise<import("./sync/types").ExternalSyncDriver<string>>((resolve) => {
        resolveFactory = resolve
      })
    })
    const unregister = registerExternalSync(
      { key, owner: "plugin:pending", connectionRef: "pending-ref" as never },
      factory
    )
    try {
      requestExternalSync(key, phase === "factory" ? "manual" : "poll")
      if (phase === "factory") await started
      expect(
        (
          await purgeDerivedData(
            phase === "factory"
              ? { kind: "connection", ref: "pending-ref" as never }
              : { kind: "plugin-data", pluginId: "pending" }
          )
        ).failed
      ).toEqual([])
      if (phase === "factory") resolveFactory(driver)
      requestExternalSync(key, "manual")
      await new Promise((resolve) => setTimeout(resolve, 2100))
      expect(factory).toHaveBeenCalledTimes(phase === "factory" ? 1 : 0)
      expect(driver.fetchPage).not.toHaveBeenCalled()
      expect(await getDb().externalSyncCursors.get(key)).toBeUndefined()
    } finally {
      unregister()
    }
  }
)

it("reports failures without throwing and independently runs all purgers", async () => {
  const target = { kind: "plugin-data" as const, pluginId: "consumer" }
  const good = jest.fn(async () => {})
  const bad = registerDerivedDataPurger({
    id: "broken",
    purge: async () => {
      throw new Error("private credential")
    },
  })
  const dispose = registerDerivedDataPurger({ id: "healthy", purge: good })
  try {
    const report = await purgeDerivedData(target)
    expect(good).toHaveBeenCalledWith(target)
    expect(report.failed).toEqual(["broken"])
    expect(report.purged).toContain("healthy")
    expect(JSON.stringify(report)).not.toContain("private credential")
  } finally {
    bad()
    dispose()
  }
})

it.each([
  ["fetch", false],
  ["apply", false],
  ["fetch", true],
  ["apply", true],
] as const)(
  "waits for an independent runtime paused in %s (connection=%s) before plugin records are cleared",
  async (phase, connection) => {
    const other = independentSyncCore()
    const db = getDb()
    if (connection) await db.authConnections.put({ id: "shared-ref", status: "connected" } as never)
    const records = new Dexie(`external-sync-purge-records-${phase}-${connection}`)
    records.version(1).stores({ records: "&id" })
    await records.open()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pause = async () => {
      entered()
      await gate
    }
    const applyPage = jest.fn(async () => {
      if (phase === "apply") await pause()
      await records.table("records").put({ id: "plugin-record" })
    })
    const pending = other.runExternalSync(
      {
        key: "other-runtime",
        owner: "plugin:p",
        ...(connection ? { connectionRef: "shared-ref" as never } : {}),
      },
      {
        itemId: String,
        fetchPage: async () => {
          if (phase === "fetch") await pause()
          return { items: ["plugin-record"], cursor: "late" }
        },
        applyPage,
      }
    )
    try {
      await started
      let purged = false
      const purge = purgeDerivedData({ kind: "plugin-data", pluginId: "p" }).then((report) => {
        purged = true
        return report
      })
      await until(async () => !(await db.externalSyncCursors.get("other-runtime")))
      expect(purged).toBe(false)
      release()
      expect((await pending).status).toBe("cancelled")
      expect((await purge).failed).toEqual([])
      // The public delete-data flow clears the plugin's data after the barrier.
      await records.table("records").clear()
      expect(await records.table("records").count()).toBe(0)
      expect(await db.externalSyncCursors.get("other-runtime")).toBeUndefined()
      expect(await db.externalSyncSeen.count()).toBe(0)
      if (phase === "fetch") expect(applyPage).not.toHaveBeenCalled()
    } finally {
      release()
      await pending
      await records.delete()
    }
  }
)

it("bounds a connection-backed purge even when another runtime keeps its lease alive", async () => {
  const db = getDb()
  const now = Date.now()
  await db.externalSyncCursors.put({
    key: "leased",
    owner: "plugin:p",
    connectionRef: "ref" as never,
    failures: 0,
  })
  await db.syncLeases.put({
    key: "ref:sync:leased",
    connectionRef: "ref",
    ownerId: "other-runtime",
    token: "held",
    heartbeatAt: now,
    expiresAt: now + 90_000,
  })
  const get = db.syncLeases.get.bind(db.syncLeases)
  let clock = now
  const time = jest.spyOn(Date, "now").mockImplementation(() => clock)
  const read = jest.spyOn(db.syncLeases, "get").mockImplementation((key) =>
    get(key).then((lease) => {
      clock = now + 36_000
      return lease
    })
  )
  try {
    expect((await purgeDerivedData({ kind: "plugin-data", pluginId: "p" })).failed).toContain(
      "external-sync"
    )
    expect(await db.externalSyncCursors.get("leased")).toBeUndefined()
  } finally {
    read.mockRestore()
    time.mockRestore()
  }
})

it("accepts an expired connection lease as released", async () => {
  const db = getDb()
  await db.externalSyncCursors.put({
    key: "expired",
    owner: "plugin:p",
    connectionRef: "ref" as never,
    failures: 0,
  })
  await db.syncLeases.put({
    key: "ref:sync:expired",
    connectionRef: "ref",
    ownerId: "other-runtime",
    token: "expired",
    heartbeatAt: 0,
    expiresAt: Date.now() - 1,
  })
  expect((await purgeDerivedData({ kind: "plugin-data", pluginId: "p" })).failed).toEqual([])
  expect(await db.externalSyncCursors.get("expired")).toBeUndefined()
})

it("bounds the wait when the browser Web Lock never becomes available", async () => {
  await getDb().externalSyncCursors.put({ key: "web-locked", owner: "plugin:p", failures: 0 })
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks")
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const request = jest.fn(() => {
    entered()
    return new Promise(() => {})
  })
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } })
  jest.useFakeTimers({
    doNotFake: ["setImmediate", "clearImmediate", "nextTick", "queueMicrotask"],
  })
  try {
    const purge = purgeDerivedData({ kind: "plugin-data", pluginId: "p" })
    await started
    expect(request).toHaveBeenCalledWith("cognia-external-sync:web-locked", expect.any(Function))
    await jest.advanceTimersByTimeAsync(5000)
    expect((await purge).failed).toContain("external-sync")
  } finally {
    jest.useRealTimers()
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor)
    else Reflect.deleteProperty(navigator, "locks")
  }
})

it("throws from a timed-out purger so durable teardown retries still drain deleted keys", async () => {
  const other = independentSyncCore()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = other.runExternalSync(
    { key: "stuck-runtime", owner: "plugin:p" },
    {
      itemId: String,
      fetchPage: async () => {
        entered()
        await gate
        return { items: ["late"], cursor: "late" }
      },
      applyPage: jest.fn(async () => {}),
    }
  )
  const target = { kind: "plugin-data" as const, pluginId: "p" }
  try {
    await started
    await queueAccessTeardown(target)
    expect((await runAccessTeardown(target)).failed).toContain("external-sync")
    expect(await getDb().externalSyncCursors.get("stuck-runtime")).toBeUndefined()
    expect(
      await getDb().integrationAudit.where("kind").equals("access.cleanup.pending").count()
    ).toBe(1)
    const barrier = (await getDb()
      .integrationAudit.where("kind")
      .equals("external-sync.purge.pending")
      .first())!
    expect(barrier.detail?.targets).toEqual([
      { key: "stuck-runtime", owner: "plugin:p", connectionRef: undefined },
    ])
    let completed = false
    const retry = runAccessTeardown(target).then((report) => {
      completed = true
      return report
    })
    await until(
      async () =>
        (await getDb().integrationAudit.get(barrier.id))?.detail?.generation !==
        barrier.detail?.generation
    )
    expect(completed).toBe(false)
    release()
    expect((await pending).status).toBe("cancelled")
    expect((await retry).failed).toEqual([])
    expect(
      await getDb().integrationAudit.where("kind").equals("access.cleanup.pending").count()
    ).toBe(0)
    expect(await getDb().integrationAudit.get(barrier.id)).toBeUndefined()
  } finally {
    release()
    await pending
  }
})
