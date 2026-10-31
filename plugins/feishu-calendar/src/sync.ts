import type { PluginContext } from "@cognia/plugin-sdk"

import { FeishuApiError, FeishuCalendarClient } from "./api"

export type CalendarSyncHost = {
  storage: Pick<PluginContext["storage"], "get" | "set">
  integrations: Pick<
    PluginContext["integrations"],
    "authenticatedRequest" | "publishEvent" | "listAccounts" | "listSubscriptions"
  >
}

interface SyncState {
  version: 1
  syncToken?: string
  fingerprints: Record<string, string>
  pending?: { id: string; mode: "full" | "incremental"; startedAt: string }
}

export interface CalendarSyncResult {
  accountId: string
  calendarId: string
  mode: "full" | "incremental"
  pages: number
  published: number
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Feishu calendar synchronization cancelled")
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Only a completed scan advances the durable cursor. A pending generation is
 * persisted before fetching, making event ids stable after a crash or failed
 * publish. The host event broker supplies durable deduplication and projection
 * recovery; this plugin stores only ids and fingerprints, never event content.
 */
export function createCalendarSync(host: CalendarSyncHost, lifecycleSignal?: AbortSignal) {
  const running = new Map<string, Promise<CalendarSyncResult>>()
  const withLifecycle = (signal?: AbortSignal) =>
    lifecycleSignal
      ? signal
        ? AbortSignal.any([lifecycleSignal, signal])
        : lifecycleSignal
      : signal

  async function scan(
    accountId: string,
    calendarId: string,
    signal?: AbortSignal
  ): Promise<CalendarSyncResult> {
    checkAbort(signal)
    if (!accountId || !calendarId) throw new Error("An account and calendar are required")
    const key = `calendar-sync:${JSON.stringify([accountId, calendarId])}`
    let state = await host.storage.get<SyncState>(key)
    if (
      state &&
      (state.version !== 1 || !state.fingerprints || typeof state.fingerprints !== "object")
    ) {
      throw new Error("Unsupported Feishu calendar sync checkpoint")
    }
    state ??= { version: 1, fingerprints: {} }
    state.pending ??= {
      id: crypto.randomUUID(),
      mode: state.syncToken ? "incremental" : "full",
      startedAt: new Date().toISOString(),
    }
    await host.storage.set(key, state)
    const client = new FeishuCalendarClient(
      (url, init) => host.integrations.authenticatedRequest(accountId, url, init),
      signal
    )
    let resets = 0

    while (true) {
      const pending: NonNullable<SyncState["pending"]> = state.pending!
      const next = new Map(pending.mode === "incremental" ? Object.entries(state.fingerprints) : [])
      const seenPages = new Set<string>()
      let pageToken: string | undefined
      let terminalToken: string | undefined
      let pages = 0
      let published = 0

      const publish = async (
        eventId: string,
        event: Record<string, unknown>,
        kind: "created" | "updated" | "deleted",
        fingerprint: string
      ) => {
        checkAbort(signal)
        const id = `feishu-calendar:${await digest([accountId, calendarId, pending.id, eventId, kind, fingerprint])}`
        await host.integrations.publishEvent({
          schemaVersion: 1,
          id,
          pluginId: "feishu-calendar",
          integrationId: "feishu-calendar",
          accountId,
          deliveryId: id,
          eventType: `calendar.event.${kind}`,
          resource: { kind: "calendar", id: calendarId },
          occurredAt: pending.startedAt,
          receivedAt: pending.startedAt,
          payload: {
            calendarId,
            threadKey: JSON.stringify([calendarId, eventId]),
            event,
            title: typeof event.summary === "string" ? event.summary : eventId,
            change: kind,
          },
        })
        published += 1
      }

      try {
        do {
          checkAbort(signal)
          if (++pages > 1000)
            throw new Error("Feishu calendar sync exceeded the page limit; checkpoint retained")
          const page = await client.listEvents(calendarId, {
            anchorTime: "0",
            ...(pending.mode === "incremental" ? { syncToken: state.syncToken } : {}),
            ...(pageToken ? { pageToken } : {}),
            pageSize: 500,
          })
          checkAbort(signal)
          for (const item of page.items) {
            const event = item as Record<string, unknown>
            const eventId = event.event_id
            if (typeof eventId !== "string" || !eventId)
              throw new Error("Feishu sync event is missing event_id")
            const fingerprint = await digest(event)
            const previous = Object.hasOwn(state.fingerprints, eventId)
              ? state.fingerprints[eventId]
              : undefined
            if (event.status === "cancelled") {
              const tombstone = `deleted:${fingerprint}`
              next.set(eventId, tombstone)
              if (previous !== tombstone && (previous || pending.mode === "incremental"))
                await publish(eventId, event, "deleted", fingerprint)
            } else {
              if (previous !== fingerprint)
                await publish(
                  eventId,
                  event,
                  previous && !previous.startsWith("deleted:") ? "updated" : "created",
                  fingerprint
                )
              next.set(eventId, fingerprint)
            }
          }
          if (page.has_more) {
            if (!page.page_token || seenPages.has(page.page_token))
              throw new Error("Missing or repeated Feishu page token")
            seenPages.add(page.page_token)
            pageToken = page.page_token
          } else {
            pageToken = undefined
            terminalToken = page.sync_token
          }
        } while (pageToken)
        if (!terminalToken)
          throw new Error("Feishu calendar response is missing a terminal sync token")
        if (pending.mode === "full") {
          for (const [eventId, previous] of Object.entries(state.fingerprints)) {
            if (!next.has(eventId)) {
              next.set(eventId, previous.startsWith("deleted:") ? previous : `deleted:${previous}`)
              if (!previous.startsWith("deleted:"))
                await publish(
                  eventId,
                  { event_id: eventId, status: "cancelled" },
                  "deleted",
                  previous
                )
            }
          }
        }
        checkAbort(signal)
        await host.storage.set<SyncState>(key, {
          version: 1,
          syncToken: terminalToken,
          fingerprints: Object.fromEntries(next),
        })
        return { accountId, calendarId, mode: pending.mode, pages, published }
      } catch (error) {
        if (error instanceof FeishuApiError && error.code === 190008 && resets++ === 0) {
          state = { ...state, syncToken: undefined, pending: { ...pending, mode: "full" } }
          await host.storage.set(key, state)
          continue
        }
        throw error
      }
    }
  }

  function syncCalendar(
    accountId: string,
    calendarId: string,
    signal?: AbortSignal
  ): Promise<CalendarSyncResult> {
    const key = JSON.stringify([accountId, calendarId])
    const existing = running.get(key)
    if (existing) return existing
    const combinedSignal = withLifecycle(signal)
    const promise = scan(accountId, calendarId, combinedSignal).finally(() => {
      running.delete(key)
    })
    running.set(key, promise)
    return promise
  }

  async function syncSubscriptions(signal?: AbortSignal) {
    signal = withLifecycle(signal)
    checkAbort(signal)
    const accounts = await host.integrations.listAccounts("feishu-calendar")
    const results: CalendarSyncResult[] = []
    const errors: string[] = []
    for (const account of accounts.filter((a) => a.enabled)) {
      checkAbort(signal)
      const subscriptions = await host.integrations.listSubscriptions(account.id)
      const calendars = new Set(
        subscriptions
          .filter((s) => s.enabled && s.resourceKind === "calendar" && s.resourceId)
          .map((s) => s.resourceId!)
      )
      if (
        subscriptions.some(
          (s) => s.enabled && !s.resourceId && (!s.resourceKind || s.resourceKind === "calendar")
        )
      ) {
        const client = new FeishuCalendarClient(
          (url, init) => host.integrations.authenticatedRequest(account.id, url, init),
          signal
        )
        const seen = new Set<string>()
        let cursor: string | undefined
        try {
          do {
            checkAbort(signal)
            if (seen.size > 1000) throw new Error("Calendar discovery page limit exceeded")
            const page = await client.listCalendars({ cursor, limit: 500 })
            page.calendar_list.forEach((calendar) => calendars.add(calendar.calendar_id))
            cursor = page.has_more ? page.page_token : undefined
            if (cursor && seen.has(cursor))
              throw new Error("Repeated calendar discovery page token")
            if (cursor) seen.add(cursor)
          } while (cursor)
        } catch {
          checkAbort(signal)
          errors.push(`Calendar discovery failed for account ${account.id}`)
        }
      }
      for (const calendarId of calendars) {
        try {
          results.push(await syncCalendar(account.id, calendarId, signal))
        } catch {
          checkAbort(signal)
          // Account/calendar ids are operational metadata; payloads and provider
          // error bodies stay out of scheduled-task logs.
          errors.push(
            `Calendar synchronization failed for account ${account.id}, calendar ${calendarId}`
          )
        }
      }
    }
    return { results, errors }
  }

  return { syncCalendar, syncSubscriptions }
}
