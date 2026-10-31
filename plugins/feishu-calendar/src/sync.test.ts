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
    storage: {
      get: jest.fn(async (key: string) => structuredClone(values.get(key))),
      set: jest.fn(async (key: string, value: unknown) => {
        values.set(key, structuredClone(value))
      }),
    },
    integrations: {
      authenticatedRequest: request,
      publishEvent,
      listAccounts: jest.fn(async () => [{ id: "a", enabled: true }]),
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
  return { host, values, request, page, publishEvent, published }
}

const event = (summary = "Meeting") => ({ event_id: "ev", summary, status: "confirmed" })

describe("Feishu calendar incremental sync", () => {
  it("paginates a full scan and persists the terminal sync token for the next scan", async () => {
    const f = fixture()
    f.page([event()], "", "p2")
    f.page([{ event_id: "ev2", summary: "Second" }], "s1")
    const first = await createCalendarSync(f.host).syncCalendar("a", "cal")
    expect(first).toMatchObject({ pages: 2, published: 2, mode: "full" })
    expect(new URL(f.request.mock.calls[0][1]).searchParams.get("anchor_time")).toBe("0")
    expect(new URL(f.request.mock.calls[1][1]).searchParams.get("page_token")).toBe("p2")
    f.page([event("Updated")], "s2")
    await createCalendarSync(f.host).syncCalendar("a", "cal")
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
    await expect(createCalendarSync(f.host).syncCalendar("a", "cal")).rejects.toThrow(
      "database unavailable"
    )
    const original = f.publishEvent.mock.calls[0][0].id
    f.page([event(), { event_id: "ev2", summary: "Second" }])
    await createCalendarSync(f.host).syncCalendar("a", "cal")
    expect(f.publishEvent.mock.calls[2][0].id).toBe(original)
    expect(f.published.size).toBe(2)
    expect(new URL(f.request.mock.calls[1][1]).searchParams.has("sync_token")).toBe(false)
  })

  it("resets expired tokens and reconciles removals only after a complete full scan", async () => {
    const f = fixture()
    f.page([event()])
    await createCalendarSync(f.host).syncCalendar("a", "cal")
    f.request.mockResolvedValueOnce({
      status: 400,
      headers: {},
      data: { code: 190008, msg: "expired" },
    })
    f.page([], "s2")
    await createCalendarSync(f.host).syncCalendar("a", "cal")
    expect(new URL(f.request.mock.calls.at(-1)?.[1]).searchParams.has("sync_token")).toBe(false)
    expect(f.publishEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      eventType: "calendar.event.deleted",
      payload: { event: { event_id: "ev" } },
    })
  })

  it("does not emit unchanged data, but does emit a later return to an earlier value", async () => {
    const f = fixture()
    const sync = createCalendarSync(f.host)
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
    const sync = createCalendarSync(f.host)
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
    await expect(createCalendarSync(f.host).syncCalendar("a", "cal")).rejects.toThrow(/sync.token/i)
    f.page([], "", "p")
    f.page([], "", "p")
    await expect(createCalendarSync(f.host).syncCalendar("a", "cal")).rejects.toThrow(/page.token/i)
  })

  it("does not publish the same cancellation twice during a full reset or a repeated delta", async () => {
    const f = fixture()
    const sync = createCalendarSync(f.host)
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
    await expect(
      createCalendarSync(f.host).syncCalendar("a", "cal", controller.signal)
    ).rejects.toThrow()
    expect(f.request).not.toHaveBeenCalled()
    expect(f.values.size).toBe(0)
  })

  it("coalesces overlapping scans and discovers only enabled calendar subscriptions", async () => {
    const f = fixture()
    f.page([event()])
    const sync = createCalendarSync(f.host)
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
    const result = await createCalendarSync(f.host).syncSubscriptions()
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
    expect([...f.values.values()][0]).toMatchObject({ syncToken: "s1" })
    expect(f.publishEvent).toHaveBeenCalledTimes(1)
  })

  it("keeps identical event ids in different calendars in separate Inbox threads", async () => {
    const f = fixture()
    const sync = createCalendarSync(f.host)
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
