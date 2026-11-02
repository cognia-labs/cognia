/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { fenceConnectionSyncLeases } from "../sync-lease"
import { runExternalSync } from "./core"
import {
  ExternalSyncCursorInvalid,
  ExternalSyncRateLimited,
  type ExternalSyncDriver,
} from "./types"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
afterEach(() => jest.restoreAllMocks())
const target = { key: "test", owner: "host" as const }
const options = { now: () => 1000, random: () => 0.5 }
const driver = (): ExternalSyncDriver<string> => ({
  itemId: (id) => id,
  fetchPage: jest.fn(async () => ({ items: ["a"], cursor: "new" })),
  applyPage: jest.fn(async () => {}),
})
const row = () => getDb().externalSyncCursors.get(target.key)

it("persists before fetching and re-applies a page after an apply/checkpoint crash", async () => {
  const d = driver()
  const checkpoint = jest.spyOn(getDb().externalSyncSeen, "bulkPut")
  checkpoint.mockRejectedValueOnce(new Error("crash after applying"))
  d.fetchPage = jest.fn(async () => {
    expect((await row())?.generation).toBeDefined()
    return { items: ["a"], cursor: "new" }
  })
  expect((await runExternalSync(target, d, options)).status).toBe("failed")
  expect((await row())?.cursor).toBeUndefined()
  expect(d.applyPage).toHaveBeenCalledTimes(1)
  expect((await row())?.generation?.pages).toBe(0)
  expect(await getDb().externalSyncSeen.count()).toBe(0)
  const generation = (await row())!.generation!.id
  expect((await runExternalSync(target, d, { ...options, mode: "full" })).status).toBe("completed")
  expect(d.applyPage).toHaveBeenCalledTimes(2)
  expect(d.applyPage).toHaveBeenLastCalledWith(
    { items: ["a"], deleted: [] },
    expect.objectContaining({ generation })
  )
  checkpoint.mockRestore()
})

it("resumes page 3 of 5 with durable seen ids and tombstones known minus seen", async () => {
  await getDb().externalSyncCursors.put({ ...target, cursor: "old", failures: 0 })
  const d = driver()
  let fail = true
  const fetched: number[] = []
  d.fetchPage = jest.fn(async ({ page }) => {
    const n = Number(page ?? 1)
    fetched.push(n)
    if (n === 3 && fail) throw new Error("private remote body")
    return { items: [String(n)], ...(n < 5 ? { nextPage: String(n + 1) } : { cursor: "new" }) }
  })
  d.listKnownIds = jest.fn(async () => ["1", "2", "3", "4", "5", "gone"])
  d.tombstone = jest.fn(async () => {})
  expect((await runExternalSync(target, d, { ...options, mode: "full" })).status).toBe("failed")
  expect(await row()).toMatchObject({ cursor: "old", generation: { page: "3", pages: 2 } })
  expect(await getDb().externalSyncSeen.count()).toBe(2)
  fail = false
  expect(await runExternalSync(target, d, { ...options, mode: "full" })).toMatchObject({
    status: "completed",
    pages: 5,
    applied: 5,
    tombstoned: 1,
  })
  expect(fetched).toEqual([1, 2, 3, 3, 4, 5])
  expect(d.tombstone).toHaveBeenCalledWith(["gone"], expect.anything())
  expect(await getDb().externalSyncSeen.count()).toBe(0)
  expect((await row())?.cursor).toBe("new")
})

it.each(["terminal-cursor-missing", "page-cursor-repeated"])(
  "rejects %s without advancing cursor",
  async (code) => {
    const d = driver()
    d.fetchPage = jest.fn(async () => ({
      items: [],
      ...(code === "page-cursor-repeated" ? { nextPage: "same" } : {}),
    }))
    expect(await runExternalSync(target, d, options)).toMatchObject({
      status: "failed",
      errorCode: code,
    })
    expect((await row())?.cursor).toBeUndefined()
  }
)

it("passes incremental deletions to the driver", async () => {
  await getDb().externalSyncCursors.put({ ...target, cursor: "old", failures: 0 })
  const d = driver()
  d.fetchPage = jest.fn(async () => ({ items: [], deleted: ["gone"], cursor: "new" }))
  expect(await runExternalSync(target, d, options)).toMatchObject({
    status: "completed",
    mode: "incremental",
  })
  expect(d.applyPage).toHaveBeenCalledWith(
    { items: [], deleted: ["gone"] },
    expect.objectContaining({ mode: "incremental" })
  )
})

it("restarts an invalid cursor once as full and fails a second invalidation", async () => {
  await getDb().externalSyncCursors.put({ ...target, cursor: "old", failures: 0 })
  const d = driver()
  d.fetchPage = jest
    .fn()
    .mockRejectedValueOnce(new ExternalSyncCursorInvalid())
    .mockResolvedValue({ items: [], cursor: "new" })
  expect(await runExternalSync(target, d, options)).toMatchObject({
    status: "completed",
    mode: "full",
  })
  expect(d.fetchPage).toHaveBeenLastCalledWith(
    expect.objectContaining({ mode: "full", cursor: undefined })
  )
  d.fetchPage = jest.fn(async () => {
    throw new ExternalSyncCursorInvalid()
  })
  expect(await runExternalSync(target, d, options)).toMatchObject({
    status: "failed",
    errorCode: "cursor-invalid",
  })
  expect(d.fetchPage).toHaveBeenCalledTimes(2)
  expect((await row())?.cursor).toBeUndefined()
})

it.each([
  [0, 1000],
  [9_000_000, 3_600_000],
])("clamps retryAfter %s and manual full bypasses backoff", async (retry, delay) => {
  const d = driver()
  d.fetchPage = jest.fn(async () => {
    throw new ExternalSyncRateLimited(retry)
  })
  expect((await runExternalSync(target, d, options)).status).toBe("backoff")
  expect(await row()).toMatchObject({
    failures: 1,
    backoffUntil: 1000 + delay,
    lastErrorCode: "rate-limited",
  })
  await runExternalSync(target, d, options)
  expect(d.fetchPage).toHaveBeenCalledTimes(1)
  await runExternalSync(target, d, { ...options, mode: "full" })
  expect(d.fetchPage).toHaveBeenCalledTimes(2)
})

it("grows generic backoff within jitter bounds without retaining error text", async () => {
  const d = driver()
  d.fetchPage = jest.fn(async () => {
    throw new Error("private service message")
  })
  for (const [random, delay] of [
    [0, 27_000],
    [1, 66_000],
    [0.5, 120_000],
  ]) {
    await runExternalSync(target, d, { ...options, mode: "full", random: () => random })
    expect((await row())?.backoffUntil).toBe(1000 + delay)
  }
  expect(JSON.stringify(await row())).not.toContain("private service message")
})

it("defers offline without modifying the checkpoint or failures", async () => {
  await getDb().externalSyncCursors.put({ ...target, cursor: "old", failures: 4 })
  const d = driver()
  expect((await runExternalSync(target, d, { isOffline: () => true })).status).toBe(
    "deferred-offline"
  )
  expect(await row()).toEqual({ ...target, cursor: "old", failures: 4, deferredOffline: true })
  expect(d.fetchPage).not.toHaveBeenCalled()
})

it.each([false, true])(
  "returns busy for a second runner (connection=%s) and fences checkpoint writes",
  async (connection) => {
    const t = { ...target, ...(connection ? { connectionRef: "ref" as never } : {}) }
    await getDb().authConnections.put({ id: "ref", status: "connected" } as never)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    const gate = new Promise<void>((r) => {
      release = r
    })
    const d = driver()
    const controller = new AbortController()
    d.applyPage = async () => {
      entered()
      await gate
    }
    const first = runExternalSync(t, d, { ...options, signal: controller.signal })
    await started
    expect((await runExternalSync(t, driver(), options)).status).toBe("busy")
    if (connection) await fenceConnectionSyncLeases("ref")
    else controller.abort()
    release()
    expect((await first).status).toBe("cancelled")
    expect(await row()).toMatchObject({ failures: 0, generation: { pages: 0 } })
    expect((await row())?.cursor).toBeUndefined()
  }
)

it("abandons a different pending generation and its seen set", async () => {
  await getDb().externalSyncCursors.put({
    ...target,
    cursor: "old",
    failures: 0,
    generation: {
      id: "old-generation",
      mode: "incremental",
      startedAt: 0,
      page: "old-page",
      pages: 1,
      applied: 1,
    },
  })
  await getDb().externalSyncSeen.put({
    key: target.key,
    generation: "old-generation",
    itemId: "stale",
  })
  const d = driver()
  await runExternalSync(target, d, { ...options, mode: "full" })
  expect(d.fetchPage).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "full", page: undefined })
  )
  expect(await getDb().externalSyncSeen.count()).toBe(0)
})

it.each(["deleted", "regenerated", "owner", "connection"])(
  "cancels a checkpoint whose target was %s without writing seen ids or failures",
  async (change) => {
    const d = driver()
    let replacement: Awaited<ReturnType<typeof row>>
    d.applyPage = jest.fn(async () => {
      const current = (await row())!
      if (change === "deleted") await getDb().externalSyncCursors.delete(target.key)
      else {
        replacement = {
          ...current,
          ...(change === "regenerated"
            ? { generation: { ...current.generation!, id: "replacement" } }
            : change === "owner"
              ? { owner: "plugin:other" as const }
              : { connectionRef: "other" as never }),
        }
        await getDb().externalSyncCursors.put(replacement)
      }
    })
    d.listKnownIds = jest.fn(async () => ["a", "gone"])
    d.tombstone = jest.fn(async () => {})
    expect((await runExternalSync(target, d, options)).status).toBe("cancelled")
    expect(await row()).toEqual(replacement)
    expect(await getDb().externalSyncSeen.count()).toBe(0)
    expect(d.fetchPage).toHaveBeenCalledTimes(1)
    expect(d.listKnownIds).not.toHaveBeenCalled()
    expect(d.tombstone).not.toHaveBeenCalled()
  }
)

it.each(["page", "invalidation", "failure"])(
  "cancels removal during fetch before %s can call a driver or write state",
  async (result) => {
    const d = driver()
    d.fetchPage = jest.fn(async () => {
      await getDb().externalSyncCursors.delete(target.key)
      if (result === "invalidation") throw new ExternalSyncCursorInvalid()
      if (result === "failure") throw new Error("private remote content")
      return { items: ["a"], cursor: "late" }
    })
    expect((await runExternalSync(target, d, options)).status).toBe("cancelled")
    expect(await row()).toBeUndefined()
    expect(await getDb().externalSyncSeen.count()).toBe(0)
    expect(d.fetchPage).toHaveBeenCalledTimes(1)
    expect(d.applyPage).not.toHaveBeenCalled()
  }
)

it.each(["initial", "locked"])(
  "refuses to recreate a row removed after its %s read",
  async (read) => {
    await getDb().externalSyncCursors.put({ ...target, failures: 0 })
    const table = getDb().externalSyncCursors
    const get = table.get.bind(table)
    const spy = jest.spyOn(table, "get")
    if (read === "locked") spy.mockImplementationOnce((key) => get(key))
    spy.mockImplementationOnce((key) =>
      get(key).then(async (current) => {
        await table.delete(target.key)
        return current
      })
    )
    const d = driver()
    expect((await runExternalSync(target, d, options)).status).toBe("cancelled")
    expect(await row()).toBeUndefined()
    expect(d.fetchPage).not.toHaveBeenCalled()
  }
)

it("rolls back seen ids and cancels when a checkpoint update affects no row", async () => {
  const d = driver()
  d.applyPage = async () => {
    jest.spyOn(getDb().externalSyncCursors, "update").mockResolvedValueOnce(0)
  }
  expect((await runExternalSync(target, d, options)).status).toBe("cancelled")
  expect(await row()).toMatchObject({ failures: 0, generation: { pages: 0 } })
  expect(await getDb().externalSyncSeen.count()).toBe(0)
})

it("cancels finalization if tombstoning replaces the generation", async () => {
  const d = driver()
  d.listKnownIds = async () => ["gone"]
  d.tombstone = async () => {
    const current = (await row())!
    await getDb().externalSyncCursors.put({
      ...current,
      generation: { ...current.generation!, id: "replacement" },
    })
  }
  expect((await runExternalSync(target, d, options)).status).toBe("cancelled")
  expect(await row()).toMatchObject({ failures: 0, generation: { id: "replacement" } })
  expect((await row())?.cursor).toBeUndefined()
})

it("fullScanOnly preserves retry delays and finalizes after tombstones under exclusion", async () => {
  const d = driver()
  d.fullScanOnly = true
  d.fetchPage = jest.fn(async () => {
    throw new ExternalSyncRateLimited(90_000)
  })
  expect(await runExternalSync(target, d, options)).toMatchObject({ status: "backoff" })
  expect(await runExternalSync(target, d, { now: () => 90_999 })).toMatchObject({
    status: "backoff",
  })
  expect(d.fetchPage).toHaveBeenCalledTimes(1)
  d.fetchPage = jest.fn(async () => ({ items: ["a"], cursor: "next" }))
  d.listKnownIds = async () => ["gone"]
  const order: string[] = []
  d.tombstone = async () => {
    order.push("tombstone")
  }
  d.complete = async () => {
    order.push("complete")
    expect((await row())?.cursor).toBeUndefined()
    expect((await runExternalSync(target, driver(), options)).status).toBe("busy")
  }
  expect(await runExternalSync(target, d, { now: () => 91_000 })).toMatchObject({
    status: "completed",
    mode: "full",
  })
  expect(order).toEqual(["tombstone", "complete"])
  expect((await row())?.cursor).toBe("next")
})
