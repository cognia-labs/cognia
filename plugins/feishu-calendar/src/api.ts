/** Feishu Calendar v4 calls use the host's credential and origin-governed broker. */
import { z } from "zod"
import type { IntegrationProviderContext } from "@cognia/plugin-sdk/api/integration"

export const FEISHU_API_ORIGIN = "https://open.feishu.cn"
const API_ROOT = `${FEISHU_API_ORIGIN}/open-apis/calendar/v4`

const identifier = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value !== "." &&
      value !== "..",
    "Invalid resource identifier"
  )
const cursor = z.string().min(1).max(16384)
const seconds = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})$/)
  .refine((value) => Number(value) <= 253402300799, "Expected Unix seconds, not milliseconds")
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }, "Invalid calendar date")
const timezone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value })
      return true
    } catch {
      return false
    }
  }, "Expected an IANA timezone")

export const eventTimeSchema = z
  .strictObject({
    date: date.optional(),
    timestamp: seconds.optional(),
    timezone: timezone.optional(),
  })
  .refine((time) => (time.date !== undefined) !== (time.timestamp !== undefined), {
    message: "Specify exactly one of date or timestamp",
  })
  .refine(
    (time) => time.date === undefined || time.timezone === undefined || time.timezone === "UTC",
    {
      message: "All-day events use UTC",
    }
  )

const locationSchema = z.strictObject({
  name: z.string().max(512).optional(),
  address: z.string().max(512).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
})
const reminderSchema = z.strictObject({ minutes: z.number().int().min(0).max(40320) })
const eventFields = {
  summary: z.string().max(1000).optional(),
  description: z.string().max(40960).optional(),
  need_notification: z.boolean().optional(),
  start_time: eventTimeSchema.optional(),
  end_time: eventTimeSchema.optional(),
  visibility: z.enum(["default", "public", "private"]).optional(),
  attendee_ability: z
    .enum(["none", "can_see_others", "can_invite_others", "can_modify_event"])
    .optional(),
  free_busy_status: z.enum(["busy", "free"]).optional(),
  location: locationSchema.optional(),
  color: z.number().int().min(-1).max(0xffffff).optional(),
  reminders: z.array(reminderSchema).max(10).optional(),
  recurrence: z
    .string()
    .max(2000)
    .refine(
      (value) =>
        value === "" ||
        /^(RRULE:)?FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+\-:]+)*$/.test(
          value
        ),
      "Expected an RFC 5545 recurrence rule"
    )
    .optional(),
}

function validEventRange(event: { start_time?: EventTime; end_time?: EventTime }): boolean {
  if (!event.start_time || !event.end_time) return true
  if ((event.start_time.date !== undefined) !== (event.end_time.date !== undefined)) return false
  const value = (time: EventTime) =>
    time.date === undefined
      ? Number(time.timestamp)
      : new Date(`${time.date}T00:00:00.000Z`).getTime() / 1000
  return value(event.start_time) < value(event.end_time)
}

export const eventCreateSchema = z
  .strictObject({
    ...eventFields,
    start_time: eventTimeSchema,
    end_time: eventTimeSchema,
  })
  .refine(validEventRange, "Event end must follow its start and use the same time representation")

export const eventPatchSchema = z
  .strictObject(eventFields)
  .refine((patch) => Object.keys(patch).length > 0, "Event patch must contain a field")
  .refine(validEventRange, "Event end must follow its start and use the same time representation")

export const eventListOptionsSchema = z
  .strictObject({
    pageToken: cursor.optional(),
    syncToken: cursor.optional(),
    anchorTime: seconds.optional(),
    startTime: seconds.optional(),
    endTime: seconds.optional(),
    pageSize: z.number().int().min(50).max(1000).optional(),
  })
  .refine((input) => {
    const hasWindow = input.startTime !== undefined || input.endTime !== undefined
    if (!hasWindow) return true
    return (
      input.startTime !== undefined &&
      input.endTime !== undefined &&
      Number(input.startTime) < Number(input.endTime) &&
      input.pageToken === undefined &&
      input.syncToken === undefined &&
      input.anchorTime === undefined
    )
  }, "Time windows require both endpoints and cannot be combined with pagination, sync or anchor tokens")

export const calendarListOptionsSchema = z.strictObject({
  cursor: cursor.optional(),
  limit: z.number().int().min(50).max(1000).optional(),
})

const rfc3339 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  .refine((value) => Number.isFinite(Date.parse(value)), "Expected an RFC 3339 instant")

export const freebusySchema = z
  .strictObject({
    time_min: rfc3339,
    time_max: rfc3339,
    user_id: identifier.optional(),
    room_id: identifier.optional(),
    include_external_calendar: z.boolean().optional(),
    only_busy: z.boolean().optional(),
    need_rsvp_status: z.boolean().optional(),
  })
  .refine((input) => (input.user_id !== undefined) !== (input.room_id !== undefined), {
    message: "Specify exactly one of user_id or room_id",
  })
  .refine((input) => {
    const duration = Date.parse(input.time_max) - Date.parse(input.time_min)
    return duration > 0 && duration <= 90 * 24 * 60 * 60 * 1000
  }, "Freebusy range must be positive and at most 90 days")

export const attendeeSchema = z
  .strictObject({
    type: z.enum(["user", "chat", "resource"]),
    user_id: identifier.optional(),
    chat_id: identifier.optional(),
    room_id: identifier.optional(),
    is_optional: z.boolean().optional(),
    operate_id: identifier.optional(),
    approval_reason: z.string().max(1000).optional(),
  })
  .refine((input) => {
    const identity = { user: "user_id", chat: "chat_id", resource: "room_id" }[input.type]
    return ["user_id", "chat_id", "room_id"].every(
      (key) =>
        (input[key as "user_id" | "chat_id" | "room_id"] !== undefined) === (key === identity)
    )
  }, "Invitee type must match exactly one remote identifier")

export const EVENT_CREATE_SCHEMA = z.toJSONSchema(eventCreateSchema)
export const EVENT_PATCH_SCHEMA = z.toJSONSchema(eventPatchSchema)
export const EVENT_LIST_OPTIONS_SCHEMA = z.toJSONSchema(eventListOptionsSchema)
export const CALENDAR_LIST_OPTIONS_SCHEMA = z.toJSONSchema(calendarListOptionsSchema)
export const FREEBUSY_SCHEMA = z.toJSONSchema(freebusySchema)
export const ATTENDEE_SCHEMA = z.toJSONSchema(attendeeSchema)

export type EventTime = z.infer<typeof eventTimeSchema>
export type FeishuEventInput = z.infer<typeof eventCreateSchema>
export type FeishuEventPatch = z.infer<typeof eventPatchSchema>
export type EventListOptions = z.infer<typeof eventListOptionsSchema>
export type CalendarListOptions = z.infer<typeof calendarListOptionsSchema>
export type FreebusyInput = z.infer<typeof freebusySchema>
export type FeishuAttendeeInput = z.infer<typeof attendeeSchema>

/** Response objects preserve provider fields, including cancellation tombstones. */
export interface EventRecord extends Record<string, unknown> {
  event_id: string
  summary?: string
  description?: string
  status?: string
  start_time?: EventTime
  end_time?: EventTime
  create_time?: string
  updated_time?: string
  recurrence?: string
  app_link?: string
}

export interface CalendarRecord extends Record<string, unknown> {
  calendar_id: string
  summary?: string
  description?: string
}

export interface EventPage {
  items: EventRecord[]
  has_more: boolean
  page_token?: string
  sync_token?: string
}

export interface CalendarPage {
  calendar_list: CalendarRecord[]
  has_more: boolean
  page_token?: string
  sync_token?: string
}

/** Deliberately excludes provider messages and bodies, which may echo secrets or event text. */
export class FeishuApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
    readonly retryAfter?: string
  ) {
    super(
      `Feishu Calendar request failed (HTTP ${status}${code === undefined ? "" : `, code ${code}`})`
    )
    this.name = "FeishuApiError"
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Invalid Feishu ${label}`)
  return value as Record<string, unknown>
}

function eventRecord(value: unknown): EventRecord {
  const event = record(value, "event")
  if (!identifier.safeParse(event.event_id).success) throw new TypeError("Invalid Feishu event_id")
  for (const key of [
    "summary",
    "description",
    "status",
    "create_time",
    "updated_time",
    "recurrence",
    "app_link",
  ]) {
    if (event[key] !== undefined && typeof event[key] !== "string")
      throw new TypeError(`Invalid Feishu event ${key}`)
  }
  for (const key of ["start_time", "end_time"]) {
    if (event[key] === undefined) continue
    const time = record(event[key], `event ${key}`)
    for (const field of ["date", "timestamp", "timezone"]) {
      if (time[field] !== undefined && typeof time[field] !== "string")
        throw new TypeError(`Invalid Feishu event ${key}.${field}`)
    }
  }
  return event as EventRecord
}

function calendarRecord(value: unknown): CalendarRecord {
  const calendar = record(value, "calendar")
  if (!identifier.safeParse(calendar.calendar_id).success)
    throw new TypeError("Invalid Feishu calendar_id")
  for (const key of ["summary", "description"]) {
    if (calendar[key] !== undefined && typeof calendar[key] !== "string")
      throw new TypeError(`Invalid Feishu calendar ${key}`)
  }
  return calendar as CalendarRecord
}

function pagination(value: Record<string, unknown>) {
  if (typeof value.has_more !== "boolean") throw new TypeError("Invalid Feishu has_more")
  const token = (key: string) => {
    const item = value[key]
    if (item === undefined || item === "") return undefined
    if (typeof item !== "string") throw new TypeError(`Invalid Feishu ${key}`)
    return item
  }
  const page_token = token("page_token")
  const sync_token = token("sync_token")
  if (value.has_more && !page_token)
    throw new TypeError("Missing Feishu page_token for remaining pages")
  return {
    has_more: value.has_more,
    ...(page_token ? { page_token } : {}),
    ...(sync_token ? { sync_token } : {}),
  }
}

export class FeishuCalendarClient {
  constructor(
    private readonly authenticatedRequest: IntegrationProviderContext["authenticatedRequest"],
    private readonly signal?: AbortSignal
  ) {}

  private async request(
    path: string,
    method: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>
  ) {
    this.signal?.throwIfAborted()
    const params = new URLSearchParams({ user_id_type: "open_id" })
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, String(value))
    }
    const response = await this.authenticatedRequest(`${API_ROOT}${path}?${params}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    })
    this.signal?.throwIfAborted()
    const isHttpError = response.status < 200 || response.status >= 300
    if (
      isHttpError &&
      (!response.data || typeof response.data !== "object" || Array.isArray(response.data))
    )
      throw new FeishuApiError(response.status, undefined, response.headers["retry-after"])
    const envelope = record(response.data, "response envelope")
    if (isHttpError)
      throw new FeishuApiError(
        response.status,
        typeof envelope.code === "number" ? envelope.code : undefined,
        response.headers["retry-after"]
      )
    if (typeof envelope.code !== "number" || !Number.isInteger(envelope.code))
      throw new TypeError("Invalid Feishu response envelope code")
    if (envelope.code !== 0) throw new FeishuApiError(response.status, envelope.code)
    return envelope.data === undefined ? {} : record(envelope.data, "response data")
  }

  private eventsPath(calendarId: string, eventId?: string) {
    return `/calendars/${encodeURIComponent(identifier.parse(calendarId))}/events${eventId === undefined ? "" : `/${encodeURIComponent(identifier.parse(eventId))}`}`
  }

  async listCalendars(options: CalendarListOptions = {}): Promise<CalendarPage> {
    const input = calendarListOptionsSchema.parse(options)
    const data = await this.request("/calendars", "GET", undefined, {
      page_token: input.cursor,
      page_size: input.limit ?? 100,
    })
    if (!Array.isArray(data.calendar_list)) throw new TypeError("Invalid Feishu calendar_list")
    return { calendar_list: data.calendar_list.map(calendarRecord), ...pagination(data) }
  }

  async listEvents(calendarId: string, options: EventListOptions = {}): Promise<EventPage> {
    const input = eventListOptionsSchema.parse(options)
    const data = await this.request(this.eventsPath(calendarId), "GET", undefined, {
      page_size: input.pageSize ?? 500,
      anchor_time: input.anchorTime,
      page_token: input.pageToken,
      sync_token: input.syncToken,
      start_time: input.startTime,
      end_time: input.endTime,
    })
    if (!Array.isArray(data.items)) throw new TypeError("Invalid Feishu event items")
    return { items: data.items.map(eventRecord), ...pagination(data) }
  }

  async getEvent(calendarId: string, eventId: string): Promise<EventRecord> {
    return eventRecord((await this.request(this.eventsPath(calendarId, eventId), "GET")).event)
  }

  async createEvent(
    calendarId: string,
    eventData: unknown,
    idempotencyKey: string
  ): Promise<EventRecord> {
    const event = eventCreateSchema.parse(eventData)
    const data = await this.request(this.eventsPath(calendarId), "POST", event, {
      idempotency_key: identifier.parse(idempotencyKey),
    })
    return eventRecord(data.event)
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    eventPatch: unknown
  ): Promise<EventRecord> {
    const patch = eventPatchSchema.parse(eventPatch)
    if ((patch.start_time === undefined) !== (patch.end_time === undefined)) {
      // Verify a one-endpoint patch against the persisted remote endpoint.
      const current = await this.getEvent(calendarId, eventId)
      eventCreateSchema.parse({
        start_time: patch.start_time ?? current.start_time,
        end_time: patch.end_time ?? current.end_time,
      })
    }
    return eventRecord(
      (await this.request(this.eventsPath(calendarId, eventId), "PATCH", patch)).event
    )
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.request(this.eventsPath(calendarId, eventId), "DELETE")
  }

  async freebusy(input: unknown): Promise<Record<string, unknown>> {
    return this.request("/freebusy/list", "POST", freebusySchema.parse(input))
  }

  async replyEvent(
    calendarId: string,
    eventId: string,
    rsvpStatus: "accept" | "decline" | "tentative"
  ): Promise<void> {
    const rsvp_status = z.enum(["accept", "decline", "tentative"]).parse(rsvpStatus)
    await this.request(`${this.eventsPath(calendarId, eventId)}/reply`, "POST", { rsvp_status })
  }

  async addAttendees(
    calendarId: string,
    eventId: string,
    attendees: FeishuAttendeeInput[]
  ): Promise<Record<string, unknown>> {
    const values = z.array(attendeeSchema).min(1).max(1000).parse(attendees)
    if (values.filter((attendee) => attendee.type === "resource").length > 100)
      throw new TypeError("At most 100 rooms can be added at once")
    return this.request(`${this.eventsPath(calendarId, eventId)}/attendees`, "POST", {
      attendees: values,
    })
  }

  async removeAttendees(calendarId: string, eventId: string, attendeeIds: string[]): Promise<void> {
    const attendee_ids = z.array(identifier).min(1).max(500).parse(attendeeIds)
    await this.request(`${this.eventsPath(calendarId, eventId)}/attendees/batch_delete`, "POST", {
      attendee_ids,
    })
  }
}
