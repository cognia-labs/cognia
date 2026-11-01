import type { AuthConnectionMetadata, PluginContext } from "@cognia/plugin-sdk"
import { FeishuCalendarClient } from "./api"

export const CALENDAR_SERVICE = "auth.feishu"
export const READ_SCOPES = ["calendar:calendar:readonly"]
export const WRITE_SCOPES = ["calendar:calendar"]
export const READ_OPERATIONS = [
  "listCalendars",
  "listEvents",
  "getEvent",
  "getFreebusy",
  "syncCalendar",
  "request.GET",
].map((id) => `feishu-calendar.${id}`)
export const WRITE_OPERATIONS = [
  "createEvent",
  "updateEvent",
  "deleteEvent",
  "replyEvent",
  "addAttendees",
  "removeAttendees",
].map((id) => `feishu-calendar.${id}`)

export type CalendarConnectionHost = Pick<PluginContext, "auth"> & {
  integrations: Pick<PluginContext["integrations"], "listAccounts" | "authenticatedRequest">
}

export class CalendarConnectionUnavailable extends Error {
  constructor() {
    super("Calendar connection unavailable; reconnect in Integrations")
    this.name = "CalendarConnectionUnavailable"
  }
}

/** Explicit foreground consent only. Scheduled sync must never re-grant revoked access. */
export async function requestCalendarAccess(host: Pick<PluginContext, "auth">, write = false) {
  const connection = await host.auth.connections.get({
    service: CALENDAR_SERVICE,
    scopes: READ_SCOPES,
    interactive: true,
  })
  if (!connection) return false
  const read = await host.auth.connections.requestGrant(connection.ref, {
    operations: READ_OPERATIONS,
    scopes: READ_SCOPES,
  })
  if (!read.granted) return false
  return (
    !write ||
    (
      await host.auth.connections.requestGrant(connection.ref, {
        operations: WRITE_OPERATIONS,
        scopes: WRITE_SCOPES,
      })
    ).granted
  )
}

export async function calendarConnection(
  host: CalendarConnectionHost,
  accountId: string
): Promise<AuthConnectionMetadata> {
  const account = (await host.integrations.listAccounts("feishu-calendar")).find(
    (row) => row.id === accountId
  )
  const selected = await host.auth.connections.get({
    service: CALENDAR_SERVICE,
    scopes: READ_SCOPES,
  })
  // The saved account owns its reference even when another account is selected for new work.
  const connection =
    selected?.ref === account?.connectionId
      ? selected
      : (await host.auth.connections.list({ service: CALENDAR_SERVICE })).find(
          (row) => row.ref === account?.connectionId
        )
  if (
    !account?.connectionId ||
    !connection ||
    connection.status !== "connected" ||
    connection.ref !== account.connectionId
  )
    throw new CalendarConnectionUnavailable()
  return connection
}

export async function connectedCalendarClient(
  host: CalendarConnectionHost,
  accountId: string,
  signal?: AbortSignal
) {
  const connection = await calendarConnection(host, accountId)
  return new FeishuCalendarClient(
    (url, init) =>
      host.integrations.authenticatedRequest(accountId, url, {
        ...init,
        connectionRef: connection.ref,
      }),
    signal,
    connection.issuer
  )
}

/** Error names are part of the Host boundary; never surface provider response bodies. */
export function calendarAccessCode(error: unknown): string | undefined {
  const name = error instanceof Error ? error.name : undefined
  return (
    {
      ConsumerGrantRequired: "consumer-grant-required",
      ConnectionRevisionChanged: "connection-revision-changed",
      ConnectionUnavailableError: "connection-unavailable",
      CalendarConnectionUnavailable: "connection-unavailable",
    } as Record<string, string>
  )[name ?? ""]
}
