import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"
import type {
  IntegrationActionHandler,
  IntegrationAccountStatusProvider,
  IntegrationResourceProvider,
  PluginIntegrationDef,
} from "@cognia/plugin-sdk/api/integration"
import manifestJson from "../plugin.json"
import {
  ATTENDEE_SCHEMA,
  CALENDAR_LIST_OPTIONS_SCHEMA,
  EVENT_CREATE_SCHEMA,
  EVENT_LIST_OPTIONS_SCHEMA,
  EVENT_PATCH_SCHEMA,
  FREEBUSY_SCHEMA,
  FeishuApiError,
  FeishuCalendarClient,
  type CalendarListOptions,
  type EventListOptions,
  type FeishuAttendeeInput,
} from "./api"
import { createCalendarSync } from "./sync"

const id = { type: "string", minLength: 1, maxLength: 1024 }
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const calendarEvent = { calendarId: id, eventId: id }
const action = (
  actionId: string,
  label: string,
  inputSchema: Record<string, unknown>,
  risk: "read" | "write" | "destructive" = "read",
  idempotency: "required" | "supported" | "none" = "supported"
) => ({
  id: actionId,
  label,
  handler: actionId,
  inputSchema,
  risk,
  idempotency,
  timeoutMs: actionId === "syncCalendar" ? 240_000 : 30_000,
  ...(Object.hasOwn(inputSchema.properties as object, "calendarId")
    ? { scopeSelectors: [{ kind: "calendar", jsonPointer: "/calendarId" }] }
    : {}),
})

export const feishuCalendarIntegration: PluginIntegrationDef = {
  id: "feishu-calendar",
  label: "Feishu Calendar",
  category: "calendar",
  description:
    "Read and manage Feishu calendar events; synchronize subscribed calendars incrementally.",
  authStrategies: [
    {
      id: "user-oauth",
      type: "oauth2",
      label: "Feishu user OAuth",
      providerId: "feishu-user-oauth",
      scopes: ["offline_access", "calendar:calendar:readonly", "calendar:calendar"],
      requestAuth: { type: "bearer" },
      configSchema: schema(
        {
          clientId: { type: "string", title: "Feishu App ID", minLength: 1 },
          clientSecret: {
            type: "string",
            title: "Feishu App Secret",
            format: "secret",
            minLength: 1,
          },
          redirectUri: {
            type: "string",
            title: "Registered OAuth redirect URI",
            format: "uri",
            description:
              "HTTP(S) URL of your deployed Cognia /plugin-auth/callback page, registered in Feishu.",
          },
        },
        ["clientId", "clientSecret", "redirectUri"]
      ),
    },
  ],
  allowedOrigins: ["https://open.feishu.cn"],
  resourceKinds: ["calendar"],
  resourceProvider: { handler: "listCalendarResources", kinds: ["calendar"] },
  healthProvider: { handler: "checkCalendarHealth" },
  eventTypes: ["created", "updated", "deleted"].map((kind) => ({
    id: `calendar.event.${kind}`,
    label: `Calendar event ${kind}`,
    resourceKinds: ["calendar"],
  })),
  inboxProjections: [
    {
      id: "calendar-event",
      label: "Calendar event",
      eventTypes: ["created", "updated", "deleted"].map((kind) => `calendar.event.${kind}`),
      threadKeyPointer: "/threadKey",
      titlePointer: "/title",
      bodyPointer: "/change",
      urlPointer: "/event/app_link",
    },
  ],
  actions: [
    action("listCalendars", "List calendars", schema({ options: CALENDAR_LIST_OPTIONS_SCHEMA })),
    action(
      "listEvents",
      "List calendar events",
      schema({ calendarId: id, options: EVENT_LIST_OPTIONS_SCHEMA }, ["calendarId"])
    ),
    action("getEvent", "Read a calendar event", schema(calendarEvent, ["calendarId", "eventId"])),
    action(
      "createEvent",
      "Create a calendar event",
      schema({ calendarId: id, event: EVENT_CREATE_SCHEMA }, ["calendarId", "event"]),
      "write",
      "required"
    ),
    action(
      "updateEvent",
      "Update a calendar event",
      schema({ ...calendarEvent, patch: EVENT_PATCH_SCHEMA }, ["calendarId", "eventId", "patch"]),
      "write",
      "none"
    ),
    action(
      "deleteEvent",
      "Delete a calendar event",
      schema(calendarEvent, ["calendarId", "eventId"]),
      "destructive",
      "none"
    ),
    action("getFreebusy", "Read calendar free/busy", schema({ query: FREEBUSY_SCHEMA }, ["query"])),
    action(
      "replyEvent",
      "Reply to an event invitation",
      schema(
        {
          ...calendarEvent,
          rsvpStatus: { type: "string", enum: ["accept", "decline", "tentative"] },
        },
        ["calendarId", "eventId", "rsvpStatus"]
      ),
      "write",
      "none"
    ),
    action(
      "addAttendees",
      "Invite people or book rooms",
      schema(
        {
          ...calendarEvent,
          attendees: { type: "array", items: ATTENDEE_SCHEMA, minItems: 1, maxItems: 1000 },
        },
        ["calendarId", "eventId", "attendees"]
      ),
      "write",
      "none"
    ),
    action(
      "removeAttendees",
      "Remove event attendees",
      schema(
        { ...calendarEvent, attendeeIds: { type: "array", items: id, minItems: 1, maxItems: 500 } },
        ["calendarId", "eventId", "attendeeIds"]
      ),
      "write",
      "none"
    ),
    action(
      "syncCalendar",
      "Synchronize a calendar now",
      schema({ calendarId: id }, ["calendarId"])
    ),
  ],
}

const client = (context: Parameters<IntegrationActionHandler>[1]) =>
  new FeishuCalendarClient(context.authenticatedRequest, context.signal)
export const listCalendars: IntegrationActionHandler = (input, context) =>
  client(context).listCalendars(input.options as CalendarListOptions | undefined)
export const listEvents: IntegrationActionHandler = (input, context) =>
  client(context).listEvents(
    input.calendarId as string,
    input.options as EventListOptions | undefined
  )
export const getEvent: IntegrationActionHandler = (input, context) =>
  client(context).getEvent(input.calendarId as string, input.eventId as string)
export const createEvent: IntegrationActionHandler = (input, context) =>
  client(context).createEvent(input.calendarId as string, input.event, context.jobId)
export const updateEvent: IntegrationActionHandler = (input, context) =>
  client(context).updateEvent(input.calendarId as string, input.eventId as string, input.patch)
export const deleteEvent: IntegrationActionHandler = (input, context) =>
  client(context).deleteEvent(input.calendarId as string, input.eventId as string)
export const getFreebusy: IntegrationActionHandler = (input, context) =>
  client(context).freebusy(input.query)
export const replyEvent: IntegrationActionHandler = (input, context) =>
  client(context).replyEvent(
    input.calendarId as string,
    input.eventId as string,
    input.rsvpStatus as "accept" | "decline" | "tentative"
  )
export const addAttendees: IntegrationActionHandler = (input, context) =>
  client(context).addAttendees(
    input.calendarId as string,
    input.eventId as string,
    input.attendees as FeishuAttendeeInput[]
  )
export const removeAttendees: IntegrationActionHandler = (input, context) =>
  client(context).removeAttendees(
    input.calendarId as string,
    input.eventId as string,
    input.attendeeIds as string[]
  )

let sync: ReturnType<typeof createCalendarSync> | undefined
export const syncCalendar: IntegrationActionHandler = (input, context) => {
  if (!sync) throw new Error("Feishu Calendar is not active")
  return sync.syncCalendar(context.accountId, input.calendarId as string, context.signal)
}

export const listCalendarResources: IntegrationResourceProvider = async (query, context) => {
  if (query.kind !== "calendar") throw new Error("Unsupported Feishu Calendar resource kind")
  const page = await new FeishuCalendarClient(context.authenticatedRequest).listCalendars({
    cursor: query.cursor,
    limit: query.limit,
  })
  return {
    items: page.calendar_list.map((calendar) => ({
      kind: "calendar",
      id: calendar.calendar_id,
      name: calendar.summary ?? calendar.calendar_id,
    })),
    nextCursor: page.page_token,
    syncedAt: new Date().toISOString(),
  }
}

export const checkCalendarHealth: IntegrationAccountStatusProvider = async (context) => {
  const checkedAt = new Date().toISOString()
  try {
    await new FeishuCalendarClient(context.authenticatedRequest).listCalendars({ limit: 50 })
    return { health: "healthy", checkedAt, lastHealthyAt: checkedAt }
  } catch (error) {
    return {
      health: "degraded",
      checkedAt,
      code:
        error instanceof FeishuApiError
          ? `feishu-${error.code ?? error.status}`
          : "calendar-unavailable",
      recoveryAction:
        error instanceof FeishuApiError && (error.status === 401 || error.status === 403)
          ? "reauthorize"
          : "retry",
    }
  }
}

export const manifest = definePluginManifest({
  ...manifestJson,
  integrations: [feishuCalendarIntegration],
})
export default definePlugin({
  manifest,
  activate: async (context: PluginContext) => {
    sync = createCalendarSync(context, context.lifecycle.signal)
    const current = sync
    context.lifecycle.onDispose(
      context.scheduler.registerHandler("syncSubscribedCalendars", async (_args, task) => {
        const result = await current.syncSubscriptions(task.signal)
        return {
          success: result.errors.length === 0,
          output: { calendars: result.results.length },
          ...(result.errors.length ? { error: result.errors.join("; ") } : {}),
        }
      }),
      "feishu-calendar:sync-handler"
    )
    context.lifecycle.onDispose(() => {
      if (sync === current) sync = undefined
    }, "feishu-calendar:context")
  },
})
