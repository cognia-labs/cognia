import { FeishuApiError, FeishuCalendarClient } from "./api"
import type { IntegrationProviderContext } from "@cognia/plugin-sdk/api/integration"

function fixture() {
  const request = jest.fn<
    Promise<{ status: number; headers: Record<string, string>; data: unknown }>,
    [string, { method?: string; headers?: Record<string, string>; body?: string }?]
  >(async () => ({ status: 200, headers: {}, data: { code: 0, data: {} } }))
  const client = new FeishuCalendarClient(
    request as IntegrationProviderContext["authenticatedRequest"]
  )
  const reply = (data: unknown, status = 200) =>
    request.mockResolvedValueOnce({ status, headers: {}, data })
  return { request, client, reply }
}

const EVENT = {
  summary: "Planning",
  start_time: { timestamp: "1793408400", timezone: "Asia/Shanghai" },
  end_time: { timestamp: "1793412000", timezone: "Asia/Shanghai" },
}

describe("FeishuCalendarClient", () => {
  it("fails on an HTTP-200 provider error and preserves the sync-expiry code", async () => {
    const { client, reply } = fixture()
    reply({ code: 190008, msg: "page_token or sync_token expired" })
    await expect(client.listEvents("primary", { syncToken: "expired" })).rejects.toMatchObject({
      name: "FeishuApiError",
      code: 190008,
      status: 200,
    })
  })

  it("encodes calendar and event identifiers as path segments", async () => {
    const { client, request, reply } = fixture()
    reply({ code: 0, data: { event: { event_id: "event/1", summary: "Planning" } } })
    await expect(client.getEvent("calendar/a@example.com", "event/1")).resolves.toMatchObject({
      event_id: "event/1",
    })
    expect(request).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/calendar/v4/calendars/calendar%2Fa%40example.com/events/event%2F1?user_id_type=open_id",
      { method: "GET" }
    )
  })

  it("keeps initial-sync anchors, pagination and sync tokens separate from window filters", async () => {
    const { client, request, reply } = fixture()
    reply({ code: 0, data: { items: [], has_more: true, page_token: "next" } })
    await client.listEvents("primary", {
      anchorTime: "0",
      pageToken: "p",
      syncToken: "s",
      pageSize: 100,
    })
    const url = new URL(request.mock.calls[0][0] as string)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      user_id_type: "open_id",
      page_size: "100",
      anchor_time: "0",
      page_token: "p",
      sync_token: "s",
    })
    await expect(
      client.listEvents("primary", { startTime: "1", endTime: "2", syncToken: "s" })
    ).rejects.toThrow()
    await expect(client.listEvents("primary", { startTime: "2", endTime: "1" })).rejects.toThrow()
    await expect(client.listEvents("primary", { startTime: "1" })).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("requires a continuation cursor when the provider reports more pages", async () => {
    const { client, reply } = fixture()
    reply({ code: 0, data: { items: [], has_more: true } })
    await expect(client.listEvents("primary")).rejects.toThrow("page_token")
  })

  it("sends creation idempotency in the query and returns the created event", async () => {
    const { client, request, reply } = fixture()
    reply({ code: 0, data: { event: { event_id: "e1", ...EVENT } } })
    await expect(client.createEvent("primary", EVENT, "job-1")).resolves.toMatchObject({
      event_id: "e1",
    })
    const [url, init] = request.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ]
    expect(new URL(url).searchParams.get("idempotency_key")).toBe("job-1")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual(EVENT)
  })

  it("preserves explicit patch clears and false values", async () => {
    const { client, request, reply } = fixture()
    const patch = { description: "", recurrence: "", reminders: [], need_notification: false }
    reply({ code: 0, data: { event: { event_id: "e1" } } })
    await client.updateEvent("primary", "e1", patch)
    expect(
      JSON.parse((request.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    ).toEqual(patch)
  })

  it("checks a one-sided time change against the unchanged remote endpoint", async () => {
    const { client, request, reply } = fixture()
    reply({ code: 0, data: { event: { event_id: "e1", ...EVENT } } })
    await expect(
      client.updateEvent("primary", "e1", {
        start_time: { timestamp: "1793415600" },
      })
    ).rejects.toThrow("Event end must follow")
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][1]?.method).toBe("GET")
  })

  it.each([
    { ...EVENT, start_time: { date: "2026-02-30" }, end_time: { date: "2026-03-01" } },
    { ...EVENT, start_time: { date: "2026-10-31", timestamp: "1793408400" } },
    { ...EVENT, start_time: { timestamp: "1793412000" }, end_time: { timestamp: "1793408400" } },
    { ...EVENT, start_time: { timestamp: "1793408400000" } },
    { ...EVENT, start_time: { timestamp: "1793408400", timezone: "Bad/Zone" } },
    { ...EVENT, end_time: { date: "2026-11-01" } },
    { ...EVENT, authorization: "unexpected" },
    { ...EVENT, summary: "x".repeat(1001) },
  ])("rejects invalid event boundaries before sending: %j", async (event) => {
    const { client, request } = fixture()
    await expect(client.createEvent("primary", event, "job-1")).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it("supports all-day events and recurrence", async () => {
    const { client, reply, request } = fixture()
    const event = {
      start_time: { date: "2026-10-31" },
      end_time: { date: "2026-11-01" },
      recurrence: "FREQ=WEEKLY;BYDAY=SA",
    }
    reply({ code: 0, data: { event: { event_id: "recurring", ...event } } })
    await client.createEvent("primary", event, "job-recurring")
    expect(
      JSON.parse((request.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    ).toEqual(event)
  })

  it("validates calendar pagination and returns resource fields", async () => {
    const { client, reply, request } = fixture()
    reply({
      code: 0,
      data: { calendar_list: [{ calendar_id: "c1", summary: "Work" }], has_more: false },
    })
    await expect(client.listCalendars({ cursor: "next", limit: 100 })).resolves.toMatchObject({
      calendar_list: [{ calendar_id: "c1" }],
      has_more: false,
    })
    expect(new URL(request.mock.calls[0][0] as string).searchParams.get("page_token")).toBe("next")
    await expect(client.listCalendars({ limit: 0 })).rejects.toThrow()
  })

  it("sends delete and RSVP to their native endpoints", async () => {
    const { client, request } = fixture()
    await client.deleteEvent("primary", "e1")
    await client.replyEvent("primary", "e1", "accept")
    expect(
      (request.mock.calls as unknown as Array<[string, { method: string; body?: string }]>)[0][1]
        .method
    ).toBe("DELETE")
    expect(
      (request.mock.calls as unknown as Array<[string, { method: string; body?: string }]>)[1]
    ).toEqual([
      "https://open.feishu.cn/open-apis/calendar/v4/calendars/primary/events/e1/reply?user_id_type=open_id",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"rsvp_status":"accept"}',
      },
    ])
    await expect(client.replyEvent("primary", "e1", "maybe" as never)).rejects.toThrow()
  })

  it("uses the freebusy endpoint with exactly one user or room and at most 90 days", async () => {
    const { client, request } = fixture()
    const input = {
      time_min: "2026-10-31T09:00:00+08:00",
      time_max: "2026-10-31T10:00:00+08:00",
      user_id: "ou_user",
    }
    await client.freebusy(input)
    expect(request.mock.calls[0][0]).toBe(
      "https://open.feishu.cn/open-apis/calendar/v4/freebusy/list?user_id_type=open_id"
    )
    await expect(client.freebusy({ ...input, room_id: "room" })).rejects.toThrow()
    await expect(
      client.freebusy({ ...input, time_max: "2027-10-31T10:00:00+08:00" })
    ).rejects.toThrow()
  })

  it("adds typed invitees and removes by attendee IDs", async () => {
    const { client, request } = fixture()
    await client.addAttendees("primary", "e1", [
      { type: "user", user_id: "ou_user" },
      { type: "resource", room_id: "room" },
    ])
    await client.removeAttendees("primary", "e1", ["attendee1"])
    const calls = request.mock.calls as unknown as Array<[string, { body: string }]>
    expect(JSON.parse(calls[0][1].body)).toEqual({
      attendees: [
        { type: "user", user_id: "ou_user" },
        { type: "resource", room_id: "room" },
      ],
    })
    expect(calls[1][0]).toContain("/attendees/batch_delete?")
    expect(JSON.parse(calls[1][1].body)).toEqual({ attendee_ids: ["attendee1"] })
    await expect(
      client.addAttendees("primary", "e1", [{ type: "user", room_id: "room" }] as never)
    ).rejects.toThrow()
  })

  it("rejects malformed provider envelopes and resource identities", async () => {
    const { client, reply } = fixture()
    reply({ data: { items: [], has_more: false } })
    await expect(client.listEvents("primary")).rejects.toThrow("envelope")
    reply({ code: 0, data: { event: { summary: "Missing ID" } } })
    await expect(client.getEvent("primary", "e1")).rejects.toThrow("event_id")
    reply({ code: 0, data: { items: [{ status: "cancelled" }], has_more: false } })
    await expect(client.listEvents("primary")).rejects.toThrow("event_id")
    reply({ code: 0, data: { event: { event_id: "e1", status: 7 } } })
    await expect(client.getEvent("primary", "e1")).rejects.toThrow("status")
  })

  it("preserves cancellation tombstones without requiring event content", async () => {
    const { client, reply } = fixture()
    reply({
      code: 0,
      data: {
        items: [{ event_id: "e1", status: "cancelled" }],
        has_more: false,
        sync_token: "new",
      },
    })
    await expect(client.listEvents("primary", { syncToken: "old" })).resolves.toEqual({
      items: [{ event_id: "e1", status: "cancelled" }],
      has_more: false,
      sync_token: "new",
    })
  })

  it("preserves rate-limit status and Retry-After for non-JSON failures", async () => {
    const { client, request } = fixture()
    request.mockResolvedValueOnce({
      status: 429,
      headers: { "retry-after": "60" },
      data: "temporary upstream page",
    })
    await expect(client.getEvent("primary", "e1")).rejects.toMatchObject({
      status: 429,
      retryAfter: "60",
    })
  })

  it("does not expose provider response messages or response bodies in errors", async () => {
    const { client, reply } = fixture()
    reply({ code: 99991663, msg: "sensitive token secret-value" }, 403)
    const error = await client.getEvent("primary", "e1").catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(FeishuApiError)
    expect(String(error)).not.toContain("secret-value")
  })

  it("does not begin requests after cancellation or return cancelled results", async () => {
    const controller = new AbortController()
    const request = jest.fn(async () => ({
      status: 200,
      headers: {},
      data: { code: 0, data: { event: { event_id: "e1" } } },
    }))
    const client = new FeishuCalendarClient(
      request as IntegrationProviderContext["authenticatedRequest"],
      controller.signal
    )
    controller.abort()
    await expect(client.getEvent("primary", "e1")).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it("discards an in-flight result after cancellation", async () => {
    const controller = new AbortController()
    const request: IntegrationProviderContext["authenticatedRequest"] = async <T>() => {
      controller.abort()
      return {
        status: 200,
        headers: {},
        data: { code: 0, data: { event: { event_id: "e1" } } } as T,
      }
    }
    const client = new FeishuCalendarClient(request, controller.signal)
    await expect(client.getEvent("primary", "e1")).rejects.toThrow()
  })
})
