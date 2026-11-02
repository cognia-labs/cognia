/** @jest-environment jsdom */
/** @cognia-host-integration-test */
import { createHash, webcrypto } from "node:crypto"
Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle })
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createSyncAPI, clearSyncForPlugin } from "@/lib/plugin/api/sync-api"
import { purgeDerivedData } from "@/lib/external-services/derived-data-registry"
jest.mock("@/lib/plugin/auth/connection-access", () => ({
  connectionAccess: () => ({
    connected: async (ref: string) => ({
      id: ref,
      status: "connected",
      ownerPluginId: "feishu-calendar",
    }),
    checked: async (task: () => Promise<unknown>) => task(),
  }),
}))
const database = createDbTestFixture({ seeded: false })
beforeAll(database.initialize)
beforeEach(async () => {
  await database.restore()
  for (const id of ["ref-a", "ref-b"])
    await getDb().authConnections.put({ id, status: "connected" } as never)
})
afterEach(() => clearSyncForPlugin("feishu-calendar"))
afterAll(database.dispose)
const targetKey = (accountId = "a", calendarId = "cal") =>
  `calendar:${createHash("sha256")
    .update(JSON.stringify([accountId, calendarId]))
    .digest("hex")}`
const cursor = () => getDb().externalSyncCursors.get(`plugin:feishu-calendar/${targetKey()}`)
const allowRetry = () =>
  getDb().externalSyncCursors.update(`plugin:feishu-calendar/${targetKey()}`, {
    backoffUntil: undefined,
  })
import { createCalendarSync, type CalendarSyncHost } from "./sync"

function fixture() {
  const values = new Map<string, unknown>()
  const request = jest.fn()
  const published = new Map<string, unknown>()
  const publishEvent = jest.fn(async (event: { id: string }) => {
    const inserted = !published.has(event.id)
    published.set(event.id, event)
    return { inserted }
  })
  const host = {
    sync: createSyncAPI("feishu-calendar", { hasPermission: () => true }),
    auth: {
      connections: {
        get: jest.fn(async () => ({
          ref: "ref-a",
          revision: 1,
          status: "connected",
          issuer: "https://accounts.feishu.cn",
        })),
        list: jest.fn(async () => [
          { ref: "ref-b", revision: 1, status: "connected", issuer: "https://accounts.feishu.cn" },
        ]),
      },
    },
    storage: {
      get: jest.fn(async (key: string) =>
        values.has(key) ? structuredClone(values.get(key)) : undefined
      ),
      set: jest.fn(async (key: string, value: unknown) => {
        values.set(key, structuredClone(value))
      }),
    },
    integrations: {
      authenticatedRequest: request,
      publishEvent,
      listAccounts: jest.fn(async () => [
        { id: "a", enabled: true, connectionId: "ref-a" },
        { id: "b", enabled: false, connectionId: "ref-b" },
      ]),
      checkAccountHealth: jest.fn(async () => ({
        health: "healthy",
        checkedAt: "2026-11-01T00:00:00Z",
      })),
      listSubscriptions: jest.fn(async () => [
        { accountId: "a", enabled: true, resourceKind: "calendar", resourceId: "cal" },
      ]),
    },
  } as unknown as CalendarSyncHost
  const page = (items: unknown[], syncToken = "s1", more?: string) =>
    request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        code: 0,
        data: {
          items,
          has_more: !!more,
          ...(more ? { page_token: more } : { sync_token: syncToken }),
        },
      },
    })
  return { host, values, request, page, publishEvent, published, sync: createCalendarSync(host) }
}

const eventIdOf = (e: { id: string }) =>
  (e as unknown as { payload: { event: { event_id: string } } }).payload.event.event_id

const event = (summary = "Meeting") => ({ event_id: "ev", summary, status: "confirmed" })

it.each(["team@example.com", "team/calendar", "x".repeat(1024)])(
  "hashes remote calendar ids into valid bounded Host keys: %s",
  async (calendarId) => {
    const f = fixture()
    f.page([])
    await f.sync.syncCalendar("a", calendarId)
    const rows = await getDb().externalSyncCursors.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe(`plugin:feishu-calendar/${targetKey("a", calendarId)}`)
    expect(targetKey("a", calendarId)).toMatch(/^calendar:[a-f0-9]{64}$/)
    expect([...f.values.keys()]).toEqual([`calendar-sync:${JSON.stringify(["a", calendarId])}`])
  }
)

it("keeps colon-ambiguous account/calendar tuples in separate Host targets", async () => {
  const f = fixture()
  jest.mocked(f.host.integrations.listAccounts).mockResolvedValue([
    { id: "a", enabled: true, connectionId: "ref-a" },
    { id: "a:b", enabled: true, connectionId: "ref-a" },
  ] as never)
  for (const [accountId, calendarId] of [
    ["a", "b:c"],
    ["a:b", "c"],
  ]) {
    f.page([])
    await f.sync.syncCalendar(accountId, calendarId)
  }
  expect((await getDb().externalSyncCursors.toArray()).map((r) => r.key).sort()).toEqual(
    [
      `plugin:feishu-calendar/${targetKey("a", "b:c")}`,
      `plugin:feishu-calendar/${targetKey("a:b", "c")}`,
    ].sort()
  )
})

it("persists each publication across a partial page, cursor invalidation and full tombstone reconciliation", async () => {
  const f = fixture()
  f.page([{ event_id: "removed", summary: "Old" }], "base")
  await f.sync.syncCalendar("a", "cal")
  const a = { event_id: "A", summary: "First" }
  const b = { event_id: "B", summary: "Second" }
  f.page([a, b], "unused")
  f.publishEvent
    .mockImplementationOnce(async (e) => {
      f.published.set(e.id, e)
      return { inserted: true }
    })
    .mockRejectedValueOnce(new Error("publish B failed"))
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
  expect(await cursor()).toMatchObject({ cursor: "base" })
  const saved = f.values.get('calendar-sync:["a","cal"]') as {
    fingerprints: Record<string, string>
  }
  expect(Object.keys(saved.fingerprints).sort()).toEqual(["A", "removed"])
  await allowRetry()
  f.page([a, b], "rebuilt")
  await f.sync.syncCalendar("a", "cal")
  const accepted = [...f.published.values()] as {
    eventType: string
    payload: { event: { event_id: string } }
  }[]
  expect(f.publishEvent.mock.calls.filter(([e]) => eventIdOf(e) === "A")).toHaveLength(1)
  expect(accepted.filter((e) => e.payload.event.event_id === "B")).toHaveLength(1)
  expect(
    accepted
      .filter((e) => e.eventType === "calendar.event.deleted")
      .map((e) => e.payload.event.event_id)
  ).toEqual(["removed"])
  expect(await cursor()).toMatchObject({ cursor: "rebuilt" })
})

it("dedupes the crash window after publish but before fingerprint persistence across generations", async () => {
  const f = fixture()
  f.page([], "base")
  await f.sync.syncCalendar("a", "cal")
  f.page([event()], "unused")
  f.publishEvent.mockImplementationOnce(async (e) => {
    f.published.set(e.id, e)
    jest
      .mocked(f.host.storage.set)
      .mockRejectedValueOnce(new Error("crash before fingerprint write"))
    return { inserted: true }
  })
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
  const firstGeneration = (await cursor())?.generation?.id
  await allowRetry()
  let rebuiltGeneration: string | undefined
  f.publishEvent.mockImplementationOnce(async (e) => {
    rebuiltGeneration = (await cursor())?.generation?.id
    const inserted = !f.published.has(e.id)
    f.published.set(e.id, e)
    return { inserted }
  })
  f.page([event()], "rebuilt")
  await f.sync.syncCalendar("a", "cal")
  expect(rebuiltGeneration).not.toBe(firstGeneration)
  expect(f.publishEvent).toHaveBeenCalledTimes(2)
  expect(f.publishEvent.mock.calls[0][0].id).toBe(f.publishEvent.mock.calls[1][0].id)
  expect(f.published.size).toBe(1)
})

it("republishes A after accepted B loses its fingerprint and cursor invalidation rebuilds A", async () => {
  const f = fixture()
  const key = 'calendar-sync:["a","cal"]'
  f.page([event("A")], "base")
  await f.sync.syncCalendar("a", "cal")
  const saved = f.values.get(key) as { fingerprints: Record<string, string> }
  f.publishEvent.mockImplementationOnce(async (e) => {
    f.published.set(e.id, e)
    jest.mocked(f.host.storage.set).mockRejectedValueOnce(new Error("fingerprint write failed"))
    return { inserted: true }
  })
  f.page([event("B")], "lost")
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
  expect(f.values.get(key)).toEqual({
    version: 2,
    fingerprints: saved.fingerprints,
    pending: { ev: { previous: saved.fingerprints.ev } },
  })
  const failedGeneration = (await cursor())?.generation?.id
  await allowRetry()
  // Pending work invalidates the incremental cursor via the same Host path as 190008.
  f.page([event("A")], "rebuilt")
  expect(await f.sync.syncCalendar("a", "cal")).toMatchObject({ mode: "full", published: 1 })
  expect(f.publishEvent).toHaveBeenCalledTimes(3)
  expect(f.publishEvent.mock.calls.at(-1)![0]).toMatchObject({
    eventType: "calendar.event.updated",
    payload: { event: event("A") },
  })
  expect(new Set(f.publishEvent.mock.calls.map(([e]) => e.id)).size).toBe(3)
  expect(new URL(f.request.mock.calls.at(-1)![1]).searchParams.has("sync_token")).toBe(false)
  expect(await cursor()).toMatchObject({ cursor: "rebuilt" })
  expect((await cursor())?.generation).toBeUndefined()
  expect(failedGeneration).toBeDefined()
  expect(f.values.get(key)).toEqual({ version: 2, fingerprints: saved.fingerprints })
})

it("replays after a crash between the durable pending write and publication", async () => {
  const f = fixture()
  f.page([], "base")
  await f.sync.syncCalendar("a", "cal")
  jest.mocked(f.host.storage.set).mockImplementationOnce(async (key, value) => {
    f.values.set(key, structuredClone(value))
    throw new Error("process stopped after pending write")
  })
  f.page([event()], "lost")
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
  expect(f.publishEvent).not.toHaveBeenCalled()
  expect(f.values.get('calendar-sync:["a","cal"]')).toMatchObject({
    fingerprints: {},
    pending: { ev: {} },
  })
  await allowRetry()
  clearSyncForPlugin("feishu-calendar")
  f.host.sync = createSyncAPI("feishu-calendar", { hasPermission: () => true })
  f.page([event()], "rebuilt")
  expect(await createCalendarSync(f.host).syncCalendar("a", "cal")).toMatchObject({
    mode: "full",
    published: 1,
  })
  expect(f.publishEvent).toHaveBeenCalledTimes(1)
  expect(await cursor()).toMatchObject({ cursor: "rebuilt" })
})

it.each(["cancellation", "tombstone"])(
  "uses one deletion delivery identity when a %s loses its fingerprint and recovery uses the other path",
  async (first) => {
    const f = fixture()
    f.page([event("A")], "base")
    await f.sync.syncCalendar("a", "cal")
    const saved = f.values.get('calendar-sync:["a","cal"]') as {
      fingerprints: Record<string, string>
    }
    f.publishEvent.mockImplementationOnce(async (e) => {
      f.published.set(e.id, e)
      jest.mocked(f.host.storage.set).mockRejectedValueOnce(new Error("deletion fingerprint lost"))
      return { inserted: true }
    })
    if (first === "tombstone") await f.host.sync.reset(targetKey())
    f.page(first === "cancellation" ? [{ event_id: "ev", status: "cancelled" }] : [], "lost")
    await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
    await allowRetry()
    if (first === "tombstone") await f.host.sync.reset(targetKey())
    f.page(first === "cancellation" ? [] : [{ event_id: "ev", status: "cancelled" }], "rebuilt")
    await f.sync.syncCalendar("a", "cal")
    const deletions = f.publishEvent.mock.calls.map(([e]) => e).slice(1)
    expect(deletions).toHaveLength(2)
    expect(new Set(deletions.map((e) => e.id)).size).toBe(1)
    expect(f.published.size).toBe(2)
    expect(f.values.get('calendar-sync:["a","cal"]')).toEqual({
      version: 2,
      fingerprints: { ev: `deleted:${saved.fingerprints.ev}` },
    })
    expect(await cursor()).toMatchObject({ cursor: "rebuilt" })
  }
)

it("settles an unseen pending creation with a tombstone even without a saved fingerprint", async () => {
  const f = fixture()
  f.page([], "base")
  await f.sync.syncCalendar("a", "cal")
  f.publishEvent.mockImplementationOnce(async (e) => {
    f.published.set(e.id, e)
    jest.mocked(f.host.storage.set).mockRejectedValueOnce(new Error("creation fingerprint lost"))
    return { inserted: true }
  })
  f.page([event()], "lost")
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
  await allowRetry()
  f.page([], "rebuilt")
  await f.sync.syncCalendar("a", "cal")
  expect(f.publishEvent.mock.calls.at(-1)![0]).toMatchObject({
    eventType: "calendar.event.deleted",
    payload: { event: { event_id: "ev" } },
  })
  expect(f.values.get('calendar-sync:["a","cal"]')).toEqual({
    version: 2,
    fingerprints: { ev: expect.stringMatching(/^deleted:/) },
  })
})

it.each([1, 2])("loads a v%s fingerprint state without pending publications", async (version) => {
  const f = fixture()
  f.page([event()], "base")
  await f.sync.syncCalendar("a", "cal")
  const key = 'calendar-sync:["a","cal"]'
  const saved = f.values.get(key) as { fingerprints: Record<string, string> }
  f.values.set(key, { version, fingerprints: saved.fingerprints })
  await getDb().externalSyncCursors.clear()
  f.page([event()], "rebuilt")
  expect(await f.sync.syncCalendar("a", "cal")).toMatchObject({ mode: "full", published: 0 })
  expect(f.publishEvent).toHaveBeenCalledTimes(1)
  expect(f.values.get(key)).toEqual({ version: 2, fingerprints: saved.fingerprints })
})

describe("Feishu calendar incremental sync", () => {
  it.each(["ConsumerGrantRequired", "ConnectionRevisionChanged", "ConnectionUnavailableError"])(
    "keeps the completed cursor when %s stops a read and does not prompt in background",
    async (name) => {
      const f = fixture()
      f.page([], "old-cursor")
      const sync = f.sync
      await sync.syncCalendar("a", "cal")
      f.request.mockRejectedValueOnce(Object.assign(new Error("Host refused read"), { name }))
      const result = await sync.syncSubscriptions()
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(
        /consumer-grant-required|connection-revision-changed|connection-unavailable/
      )
      expect(await cursor()).toMatchObject({ cursor: "old-cursor" })
      expect(f.host.integrations.checkAccountHealth).toHaveBeenCalledWith("a")
      expect(f.host.auth.connections.get).toHaveBeenCalledWith({
        service: "auth.feishu",
        scopes: ["calendar:calendar:readonly"],
      })
    }
  )

  it("retains its cursor when the connection revision changes during event publication", async () => {
    const f = fixture()
    f.page([], "old-cursor")
    const sync = f.sync
    await sync.syncCalendar("a", "cal")
    f.page([event()], "must-not-commit")
    f.publishEvent.mockImplementationOnce(async () => {
      jest.mocked(f.host.auth.connections.get).mockResolvedValue({
        ref: "ref-a",
        status: "connected",
        revision: 2,
        issuer: "https://accounts.feishu.cn",
      } as never)
      return { inserted: true }
    })
    await expect(sync.syncCalendar("a", "cal")).rejects.toMatchObject({
      name: "ConnectionRevisionChanged",
    })
    expect(await cursor()).toMatchObject({ cursor: "old-cursor" })
  })

  it("retains its cursor when the read grant is revoked during event publication", async () => {
    const f = fixture()
    f.page([], "old-cursor")
    const sync = f.sync
    await sync.syncCalendar("a", "cal")
    f.page([event()], "must-not-commit")
    f.publishEvent.mockImplementationOnce(async () => {
      jest.mocked(f.host.integrations.checkAccountHealth).mockResolvedValue({
        health: "degraded",
        code: "consumer-grant-required",
        checkedAt: "2026-11-01T00:00:00Z",
      })
      return { inserted: true }
    })
    await expect(sync.syncCalendar("a", "cal")).rejects.toMatchObject({
      name: "ConsumerGrantRequired",
    })
    expect(await cursor()).toMatchObject({ cursor: "old-cursor" })
  })

  it("paginates a full scan and persists the terminal sync token for the next scan", async () => {
    const f = fixture()
    f.page([event()], "", "p2")
    f.page([{ event_id: "ev2", summary: "Second" }], "s1")
    const first = await f.sync.syncCalendar("a", "cal")
    expect(first).toMatchObject({ pages: 2, published: 2, mode: "full" })
    expect(new URL(f.request.mock.calls[0][1]).searchParams.get("anchor_time")).toBe("0")
    expect(new URL(f.request.mock.calls[1][1]).searchParams.get("page_token")).toBe("p2")
    f.page([event("Updated")], "s2")
    await f.sync.syncCalendar("a", "cal")
    expect(new URL(f.request.mock.calls[2][1]).searchParams.get("sync_token")).toBe("s1")
    expect(f.publishEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      eventType: "calendar.event.updated",
    })
  })

  it("does not advance a cursor after partial publish and replays with stable delivery ids", async () => {
    const f = fixture()
    f.page([event(), { event_id: "ev2", summary: "Second" }])
    f.publishEvent.mockImplementationOnce(async (e) => {
      f.published.set(e.id, e)
      return { inserted: true }
    })
    f.publishEvent.mockRejectedValueOnce(new Error("database unavailable"))
    await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
    await allowRetry()
    f.page([event(), { event_id: "ev2", summary: "Second" }])
    await f.sync.syncCalendar("a", "cal")
    expect(f.publishEvent.mock.calls.filter(([e]) => eventIdOf(e) === "ev")).toHaveLength(1)
    expect(f.published.size).toBe(2)
    expect(new URL(f.request.mock.calls[1][1]).searchParams.has("sync_token")).toBe(false)
  })

  it("resets expired tokens and reconciles removals only after a complete full scan", async () => {
    const f = fixture()
    f.page([event()])
    await f.sync.syncCalendar("a", "cal")
    f.request.mockResolvedValueOnce({
      status: 400,
      headers: {},
      data: { code: 190008, msg: "expired" },
    })
    f.page([], "s2")
    await f.sync.syncCalendar("a", "cal")
    expect(new URL(f.request.mock.calls.at(-1)?.[1]).searchParams.has("sync_token")).toBe(false)
    expect(f.publishEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      eventType: "calendar.event.deleted",
      payload: { event: { event_id: "ev" } },
    })
  })

  it("does not emit unchanged data, but does emit a later return to an earlier value", async () => {
    const f = fixture()
    const sync = f.sync
    for (const [title, token] of [
      ["A", "s1"],
      ["A", "s2"],
      ["B", "s3"],
      ["A", "s4"],
    ]) {
      f.page([event(title)], token)
      await sync.syncCalendar("a", "cal")
    }
    expect(f.publishEvent).toHaveBeenCalledTimes(3)
    expect(new Set(f.publishEvent.mock.calls.map(([e]) => e.id)).size).toBe(3)
  })

  it("publishes cancellation tombstones and isolates account/calendar checkpoints", async () => {
    const f = fixture()
    const sync = f.sync
    f.page([event()])
    await sync.syncCalendar("a", "cal")
    f.page([{ event_id: "ev", status: "cancelled" }], "s2")
    await sync.syncCalendar("a", "cal")
    expect(f.publishEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      eventType: "calendar.event.deleted",
      resource: { kind: "calendar", id: "cal" },
    })
    f.page([event()])
    await sync.syncCalendar("b", "cal")
    expect(new URL(f.request.mock.calls.at(-1)?.[1]).searchParams.has("sync_token")).toBe(false)
  })

  it("refuses a missing terminal token and repeated page token without committing", async () => {
    const f = fixture()
    f.page([], "")
    await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow(/sync.token/i)
    await f.host.sync.reset(targetKey())
    f.page([], "", "p")
    f.page([], "", "p")
    await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow(/page.token/i)
  })

  it("does not publish the same cancellation twice during a full reset or a repeated delta", async () => {
    const f = fixture()
    const sync = f.sync
    f.page([event()])
    await sync.syncCalendar("a", "cal")
    f.request.mockResolvedValueOnce({ status: 400, headers: {}, data: { code: 190008 } })
    f.page([{ event_id: "ev", status: "cancelled" }], "s2")
    await sync.syncCalendar("a", "cal")
    f.page([{ event_id: "ev", status: "cancelled" }], "s3")
    await sync.syncCalendar("a", "cal")
    expect(f.publishEvent).toHaveBeenCalledTimes(2)
  })

  it("stops on cancellation before persisting a successful checkpoint", async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(f.sync.syncCalendar("a", "cal", controller.signal)).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.values.size).toBe(0)
  })

  it("coalesces overlapping scans and discovers only enabled calendar subscriptions", async () => {
    const f = fixture()
    f.page([event()])
    const sync = f.sync
    await Promise.all([sync.syncCalendar("a", "cal"), sync.syncCalendar("a", "cal")])
    expect(f.request).toHaveBeenCalledTimes(1)
    f.page([], "s2")
    await sync.syncSubscriptions()
    expect(f.request).toHaveBeenCalledTimes(2)
  })

  it("enumerates account-wide subscriptions and deduplicates overlapping calendars", async () => {
    const f = fixture()
    ;(f.host.integrations.listSubscriptions as jest.Mock).mockResolvedValue([
      { enabled: true },
      { enabled: true, resourceKind: "calendar", resourceId: "cal" },
      { enabled: false, resourceKind: "calendar", resourceId: "disabled" },
    ])
    f.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        code: 0,
        data: { calendar_list: [{ calendar_id: "cal" }], has_more: true, page_token: "p2" },
      },
    })
    f.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: { code: 0, data: { calendar_list: [{ calendar_id: "second" }], has_more: false } },
    })
    f.page([])
    f.page([])
    const result = await f.sync.syncSubscriptions()
    expect(result.errors).toEqual([])
    expect(result.results.map((r) => r.calendarId)).toEqual(["cal", "second"])
    expect(f.request).toHaveBeenCalledTimes(4)
  })

  it("aborts an in-flight scan on plugin disposal and keeps the previous checkpoint", async () => {
    const f = fixture()
    const lifecycle = new AbortController()
    const sync = createCalendarSync(f.host, lifecycle.signal)
    f.page([event()], "s1")
    await sync.syncCalendar("a", "cal")
    f.request.mockImplementationOnce(async () => {
      lifecycle.abort()
      return {
        status: 200,
        headers: {},
        data: { code: 0, data: { items: [event("changed")], has_more: false, sync_token: "s2" } },
      }
    })
    await expect(sync.syncCalendar("a", "cal")).rejects.toThrow()
    expect(await cursor()).toMatchObject({ cursor: "s1" })
    expect(f.publishEvent).toHaveBeenCalledTimes(1)
  })

  it("keeps identical event ids in different calendars in separate Inbox threads", async () => {
    const f = fixture()
    const sync = f.sync
    f.page([event()])
    await sync.syncCalendar("a", "first")
    f.page([event()])
    await sync.syncCalendar("a", "second")
    const payloads = f.publishEvent.mock.calls.map(
      ([e]) => (e as unknown as { payload: { threadKey: string } }).payload
    )
    expect(payloads[0].threadKey).not.toEqual(payloads[1].threadKey)
  })
})

it("resumes the failed incremental page using the Host checkpoint", async () => {
  const f = fixture()
  f.page([event()], "base")
  await f.sync.syncCalendar("a", "cal")
  f.page([event("updated")], "", "page-two")
  f.request.mockRejectedValueOnce(new Error("private response"))
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
  expect(await cursor()).toMatchObject({
    cursor: "base",
    generation: { mode: "incremental", page: "page-two" },
  })
  await allowRetry()
  f.page([{ event_id: "ev2", summary: "second" }], "next")
  await f.sync.syncCalendar("a", "cal")
  expect(new URL(f.request.mock.calls.at(-1)![1]).searchParams.get("page_token")).toBe("page-two")
  expect(await cursor()).toMatchObject({ cursor: "next" })
})

it("restates an interrupted v1 scan once without seeding the old cursor, cleaning only after completion", async () => {
  const f = fixture()
  f.page([event()], "first")
  await f.sync.syncCalendar("a", "cal")
  const storageKey = [...f.values.keys()][0]
  const saved = f.values.get(storageKey) as { fingerprints: Record<string, string> }
  // A v1 scan published before saving fingerprints, so its pending generation
  // means an accepted change may be newer than the stored fingerprint.
  f.values.set(storageKey, {
    version: 1,
    fingerprints: saved.fingerprints,
    syncToken: "legacy-token",
    pending: { id: "legacy-generation", mode: "incremental", startedAt: "2026-11-01T00:00:00Z" },
  })
  await getDb().externalSyncCursors.clear()
  f.page([event()], "", "legacy-rebuild-page-two")
  f.request.mockRejectedValueOnce(new Error("remote unavailable"))
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("sync-failed")
  // The unchanged event is restated even though its fingerprint matches.
  expect(f.publishEvent).toHaveBeenCalledTimes(2)
  expect(f.publishEvent.mock.calls[1][0]).toMatchObject({ eventType: "calendar.event.updated" })
  expect(f.values.get(storageKey)).toMatchObject({
    version: 1,
    syncToken: "legacy-token",
    restate: "legacy-generation",
  })
  await allowRetry()
  f.page([], "fresh")
  await f.sync.syncCalendar("a", "cal")
  expect(new URL(f.request.mock.calls.at(-1)![1]).searchParams.has("sync_token")).toBe(false)
  expect(new URL(f.request.mock.calls.at(-1)![1]).searchParams.get("page_token")).toBe(
    "legacy-rebuild-page-two"
  )
  expect(f.publishEvent).toHaveBeenCalledTimes(2)
  expect(f.values.get(storageKey)).toEqual({ version: 2, fingerprints: saved.fingerprints })
  expect(await cursor()).toMatchObject({ cursor: "fresh" })
  // Restated once: a later full pass over the same data publishes nothing.
  await f.host.sync.reset(targetKey())
  f.page([event()], "again")
  expect(await f.sync.syncCalendar("a", "cal")).toMatchObject({ published: 0 })
})

it("publishes nothing when a write-ahead entry does not persist", async () => {
  const f = fixture()
  f.page([], "base")
  await f.sync.syncCalendar("a", "cal")
  // ctx.storage logs and swallows quota failures: the write "succeeds".
  jest.mocked(f.host.storage.set).mockImplementationOnce(async () => undefined)
  f.page([event("Changed")], "next")
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow()
  expect(f.publishEvent).not.toHaveBeenCalled()
  expect(await cursor()).toMatchObject({ cursor: "base" })
})

it.each([
  [429, undefined],
  [200, 99991400],
])("retains the cursor and obeys backoff for HTTP %s / code %s", async (status, code) => {
  const f = fixture()
  f.page([], "base")
  await f.sync.syncCalendar("a", "cal")
  f.request.mockResolvedValueOnce({
    status,
    headers: { "retry-after": "60" },
    data: { code: code ?? 99991400 },
  })
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("rate-limited")
  expect(await cursor()).toMatchObject({ cursor: "base", lastErrorCode: "rate-limited" })
  const calls = f.request.mock.calls.length
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toThrow("rate-limited")
  expect(f.request).toHaveBeenCalledTimes(calls)
})

it("dedupes unchanged fingerprints after a 190008 full rebuild", async () => {
  const f = fixture()
  f.page([event()], "base")
  await f.sync.syncCalendar("a", "cal")
  f.request.mockResolvedValueOnce({ status: 400, headers: {}, data: { code: 190008 } })
  f.page([event()], "rebuilt")
  expect(await f.sync.syncCalendar("a", "cal")).toMatchObject({ mode: "full", published: 0 })
  expect(f.publishEvent).toHaveBeenCalledTimes(1)
  expect(await cursor()).toMatchObject({ cursor: "rebuilt" })
})

it("recovers polling after consumer access cleanup without reusing its old cursor", async () => {
  const f = fixture()
  f.page([event()], "old")
  await f.sync.syncCalendar("a", "cal")
  expect(
    await purgeDerivedData({
      kind: "consumer",
      ref: "ref-a" as never,
      consumerPluginId: "feishu-calendar",
    })
  ).toMatchObject({ failed: [] })
  expect(await cursor()).toBeUndefined()
  f.page([event()], "fresh")
  expect(await f.sync.syncCalendar("a", "cal")).toMatchObject({ mode: "full", published: 0 })
  expect(f.publishEvent).toHaveBeenCalledTimes(1)
  expect(await cursor()).toMatchObject({ cursor: "fresh" })
})

it("reports why the Host cancelled a run when access is revoked mid-scan", async () => {
  const f = fixture()
  f.request.mockImplementationOnce(async () => {
    jest.mocked(f.host.integrations.checkAccountHealth).mockResolvedValue({
      health: "unhealthy",
      code: "consumer-grant-required",
      checkedAt: "2026-11-01T00:00:00Z",
    } as never)
    await purgeDerivedData({
      kind: "consumer",
      ref: "ref-a" as never,
      consumerPluginId: "feishu-calendar",
    })
    return {
      status: 200,
      headers: {},
      data: { code: 0, data: { items: [event()], has_more: false, sync_token: "late" } },
    }
  })
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toMatchObject({
    name: "ConsumerGrantRequired",
  })
  expect(f.publishEvent).not.toHaveBeenCalled()
  expect(await cursor()).toBeUndefined()
})

it("rejects an account switching connection references at the same revision in complete", async () => {
  const f = fixture()
  f.page([], "base")
  await f.sync.syncCalendar("a", "cal")
  f.page([event()], "must-not-commit")
  f.publishEvent.mockImplementationOnce(async () => {
    jest
      .mocked(f.host.integrations.listAccounts)
      .mockResolvedValue([{ id: "a", enabled: true, connectionId: "ref-b" }] as never)
    jest
      .mocked(f.host.auth.connections.get)
      .mockResolvedValue({ ref: "ref-b", revision: 1, status: "connected" } as never)
    return { inserted: true }
  })
  await expect(f.sync.syncCalendar("a", "cal")).rejects.toMatchObject({
    name: "ConnectionRevisionChanged",
  })
  expect(await cursor()).toMatchObject({ cursor: "base" })
})

it("accepts repeated A-to-B transition delivery collisions after A-to-B-to-A-to-B", async () => {
  const f = fixture()
  for (const title of ["A", "B", "A", "B"]) {
    f.page([event(title)])
    await f.sync.syncCalendar("a", "cal")
  }
  expect(f.publishEvent).toHaveBeenCalledTimes(4)
  expect(f.publishEvent.mock.calls[1][0].id).toBe(f.publishEvent.mock.calls[3][0].id)
  expect(f.published.size).toBe(3)
})
