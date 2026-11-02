import {
  defineSyncDriver,
  syncCursorInvalid,
  syncRateLimited,
  type PluginContext,
} from "@cognia/plugin-sdk"

import { FeishuApiError } from "./api"
import { calendarAccessCode, calendarConnection, connectedCalendarClient } from "./connection"

export type CalendarSyncHost = {
  auth: PluginContext["auth"]
  sync: PluginContext["sync"]
  storage: Pick<PluginContext["storage"], "get" | "set">
  integrations: Pick<
    PluginContext["integrations"],
    | "authenticatedRequest"
    | "publishEvent"
    | "listAccounts"
    | "listSubscriptions"
    | "checkAccountHealth"
  >
}

interface SyncState {
  version: 1 | 2
  syncToken?: string
  fingerprints: Record<string, string>
  pending?: Record<string, { previous?: string }>
  /**
   * A v1 scan (this id) was interrupted at upgrade: it published before it
   * saved fingerprints, so an accepted change may be newer than the stored
   * fingerprint. The first completed Host run restates every live event once.
   */
  restate?: string
}

type StoredSyncState = Omit<SyncState, "pending"> & {
  pending?: SyncState["pending"] | { id: string; mode: "full" | "incremental"; startedAt: string }
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

async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function digest(value: unknown): Promise<string> {
  return hash(canonical(value))
}

/** Fingerprints remain plugin-owned; Host cursors and generations survive retries. */
export function createCalendarSync(host: CalendarSyncHost, lifecycleSignal?: AbortSignal) {
  const running = new Map<string, Promise<CalendarSyncResult>>()
  const registrations = new Map<string, { dispose(): void }>()
  const withLifecycle = (signal?: AbortSignal) =>
    lifecycleSignal
      ? signal
        ? AbortSignal.any([lifecycleSignal, signal])
        : lifecycleSignal
      : signal
  lifecycleSignal?.addEventListener(
    "abort",
    () => {
      for (const registration of registrations.values()) registration.dispose()
      registrations.clear()
    },
    { once: true }
  )

  async function scan(
    accountId: string,
    calendarId: string,
    signal?: AbortSignal
  ): Promise<CalendarSyncResult> {
    checkAbort(signal)
    if (!accountId || !calendarId) throw new Error("An account and calendar are required")
    const storageKey = `calendar-sync:${JSON.stringify([accountId, calendarId])}`
    const targetKey = `calendar:${await hash(JSON.stringify([accountId, calendarId]))}`
    const connection = await calendarConnection(host, accountId)
    checkAbort(signal)
    let published = 0
    let failure: unknown
    const state = async (): Promise<SyncState> => {
      const stored = await host.storage.get<StoredSyncState>(storageKey)
      if (
        stored &&
        (![1, 2].includes(stored.version) ||
          !stored.fingerprints ||
          typeof stored.fingerprints !== "object")
      )
        throw new Error("Unsupported Feishu calendar sync checkpoint")
      if (!stored) return { version: 2, fingerprints: {} }
      // v1's pending generation was a cursor checkpoint, not a publication intent.
      const legacyId =
        stored.version === 1 && typeof stored.pending?.id === "string"
          ? (stored.pending.id as string)
          : undefined
      return {
        ...stored,
        pending: legacyId ? undefined : (stored.pending as SyncState["pending"]),
        ...(legacyId ? { restate: legacyId } : {}),
      }
    }
    // ctx.storage logs and swallows some browser write failures (quota), so a
    // write-ahead entry or fingerprint counts only once it reads back.
    const save = async (value: SyncState, abort: AbortSignal) => {
      abort.throwIfAborted()
      await host.storage.set(storageKey, value)
      const stored = await host.storage.get<SyncState>(storageKey)
      // Compare the JSON form: storage drops undefined fields.
      if (canonical(stored) !== canonical(JSON.parse(JSON.stringify(value)))) {
        throw Object.assign(new Error("Feishu calendar checkpoint could not be saved"), {
          name: "CalendarCheckpointUnavailable",
        })
      }
      abort.throwIfAborted()
    }
    const publish = async (
      current: SyncState,
      eventId: string,
      event: Record<string, unknown>,
      kind: "created" | "updated" | "deleted",
      previousFingerprint: string | undefined,
      fingerprint: string,
      abort: AbortSignal
    ) => {
      abort.throwIfAborted()
      const identity =
        previousFingerprint === fingerprint && current.restate
          ? [accountId, calendarId, eventId, "restated", current.restate, fingerprint]
          : [accountId, calendarId, eventId, kind, previousFingerprint ?? ""]
      if (kind !== "deleted" && identity[3] !== "restated") identity.push(fingerprint)
      const id = `feishu-calendar:${await digest(identity)}`
      const pending = { ...current.pending, [eventId]: { previous: previousFingerprint } }
      // Write ahead without event content. Fingerprints stay at the last settled
      // value until publication and its fingerprint can be settled in one write.
      await save({ ...current, pending }, abort)
      current.pending = pending
      const timestamp = new Date().toISOString()
      await host.integrations.publishEvent({
        schemaVersion: 1,
        id,
        pluginId: "feishu-calendar",
        integrationId: "feishu-calendar",
        accountId,
        deliveryId: id,
        eventType: `calendar.event.${kind}`,
        resource: { kind: "calendar", id: calendarId },
        occurredAt: timestamp,
        receivedAt: timestamp,
        payload: {
          calendarId,
          threadKey: JSON.stringify([calendarId, eventId]),
          event,
          title: typeof event.summary === "string" ? event.summary : eventId,
          change: kind,
        },
      })
      abort.throwIfAborted()
      published += 1
    }
    const persistFingerprint = async (
      current: SyncState,
      eventId: string,
      fingerprint: string,
      abort: AbortSignal
    ) => {
      const next = { ...current.fingerprints }
      Object.defineProperty(next, eventId, {
        value: fingerprint,
        enumerable: true,
        writable: true,
        configurable: true,
      })
      const pending = { ...current.pending }
      delete pending[eventId]
      await save({ ...current, fingerprints: next, pending }, abort)
      current.fingerprints = next
      current.pending = pending
    }
    const previousFingerprint = (current: SyncState, eventId: string) =>
      Object.hasOwn(current.pending ?? {}, eventId)
        ? current.pending![eventId].previous
        : Object.hasOwn(current.fingerprints, eventId)
          ? current.fingerprints[eventId]
          : undefined
    const settleDeletion = async (
      current: SyncState,
      eventId: string,
      event: Record<string, unknown>,
      abort: AbortSignal,
      incremental = false
    ) => {
      const previous = previousFingerprint(current, eventId)
      const pending = Object.hasOwn(current.pending ?? {}, eventId)
      if (previous?.startsWith("deleted:") && !pending) return
      const next = previous?.startsWith("deleted:")
        ? previous
        : `deleted:${previous ?? (await digest(event))}`
      if (previous || incremental || pending)
        await publish(current, eventId, event, "deleted", previous, next, abort)
      await persistFingerprint(current, eventId, next, abort)
    }
    const driver = defineSyncDriver<Record<string, unknown>>({
      itemId: (item) => {
        if (typeof item.event_id !== "string" || !item.event_id)
          throw new Error("Feishu sync event is missing event_id")
        return item.event_id
      },
      async fetchPage({ mode, cursor, page, signal: abort }) {
        // An accepted publication may have outlived its fingerprint write.
        // Incremental pages cannot repair a transition that reverted or vanished.
        const recovering = await state()
        if (
          mode === "incremental" &&
          (Object.keys(recovering.pending ?? {}).length || recovering.restate)
        )
          syncCursorInvalid()
        try {
          const client = await connectedCalendarClient(host, accountId, abort)
          const result = await client.listEvents(calendarId, {
            anchorTime: "0",
            syncToken: mode === "incremental" ? cursor : undefined,
            pageToken: page,
            pageSize: 500,
          })
          if (result.has_more && !result.page_token) throw new Error("Missing Feishu page token")
          return {
            items: result.items,
            ...(result.has_more ? { nextPage: result.page_token } : { cursor: result.sync_token }),
          }
        } catch (error) {
          failure = error
          if (error instanceof FeishuApiError) {
            if (error.code === 190008) syncCursorInvalid()
            if (error.status === 429 || error.code === 99991400) {
              const seconds = Number(error.retryAfter)
              const date = Date.parse(error.retryAfter ?? "")
              syncRateLimited(
                Number.isFinite(seconds) && error.retryAfter
                  ? seconds * 1000
                  : Number.isFinite(date)
                    ? Math.max(0, date - Date.now())
                    : 30_000
              )
            }
          }
          throw error
        }
      },
      async applyPage({ items, deleted }, { mode, signal: abort }) {
        const current = await state()
        for (const event of items) {
          const eventId = event.event_id as string
          if (event.status === "cancelled") {
            await settleDeletion(current, eventId, event, abort, mode === "incremental")
            continue
          }
          const fingerprint = await digest(event)
          const previous = previousFingerprint(current, eventId)
          if (
            previous === fingerprint &&
            !Object.hasOwn(current.pending ?? {}, eventId) &&
            !current.restate
          )
            continue
          // Pending entries must republish even if the remote returned to the
          // previous fingerprint: a different value may already have been accepted.
          await publish(
            current,
            eventId,
            event,
            previous && !previous.startsWith("deleted:") ? "updated" : "created",
            previous,
            fingerprint,
            abort
          )
          await persistFingerprint(current, eventId, fingerprint, abort)
        }
        for (const eventId of deleted) {
          if (
            Object.hasOwn(current.fingerprints, eventId) ||
            Object.hasOwn(current.pending ?? {}, eventId)
          )
            await settleDeletion(
              current,
              eventId,
              { event_id: eventId, status: "cancelled" },
              abort
            )
        }
      },
      async listKnownIds() {
        const current = await state()
        const live = Object.entries(current.fingerprints)
          .filter(([, fingerprint]) => !fingerprint.startsWith("deleted:"))
          .map(([id]) => id)
        return [...new Set([...live, ...Object.keys(current.pending ?? {})])]
      },
      async tombstone(ids, { signal: abort }) {
        const current = await state()
        for (const eventId of ids) {
          await settleDeletion(current, eventId, { event_id: eventId, status: "cancelled" }, abort)
        }
      },
      async complete({ signal: abort }) {
        try {
          const health = await host.integrations.checkAccountHealth(accountId)
          if (health.health !== "healthy")
            throw Object.assign(new Error("Calendar read access is unavailable"), {
              name:
                health.code === "consumer-grant-required"
                  ? "ConsumerGrantRequired"
                  : "CalendarConnectionUnavailable",
            })
          const latest = await calendarConnection(host, accountId)
          if (latest.ref !== connection.ref || latest.revision !== connection.revision)
            throw Object.assign(new Error("Calendar connection revision changed"), {
              name: "ConnectionRevisionChanged",
            })
          abort.throwIfAborted()
        } catch (error) {
          failure = error
          throw error
        }
      },
    })
    // One live registration per account/calendar. Re-registering retains the Host
    // checkpoint, and permits polling to recover after a grant purge/reapproval.
    registrations.get(targetKey)?.dispose()
    registrations.set(
      targetKey,
      host.sync.register(targetKey, driver, { connectionRef: connection.ref })
    )
    const outcome = await host.sync.run(targetKey, { signal })
    if (outcome.status !== "completed" || outcome.truncated) {
      checkAbort(signal)
      if (outcome.status === "cancelled" && !failure) {
        // Not our caller: the Host ended the run (a revoked grant, a
        // disconnect or a purge). Report why, so the account shows it.
        const health = await host.integrations.checkAccountHealth(accountId)
        if (health.health !== "healthy")
          failure = Object.assign(new Error("Calendar read access is unavailable"), {
            name:
              health.code === "consumer-grant-required"
                ? "ConsumerGrantRequired"
                : "CalendarConnectionUnavailable",
          })
      }
      const code = calendarAccessCode(failure)
      if (code)
        throw Object.assign(new Error(code), {
          name: failure instanceof Error ? failure.name : "CalendarConnectionUnavailable",
        })
      if (outcome.errorCode === "terminal-cursor-missing")
        throw new Error("Feishu calendar response is missing a terminal sync token")
      if (outcome.errorCode === "page-cursor-repeated")
        throw new Error("Missing or repeated Feishu page token")
      throw new Error(
        outcome.status === "cancelled"
          ? "Feishu calendar synchronization cancelled"
          : `Feishu calendar synchronization failed: ${outcome.errorCode ?? outcome.status}`
      )
    }
    const latest = await state()
    await host.storage.set<SyncState>(storageKey, { version: 2, fingerprints: latest.fingerprints })
    return { accountId, calendarId, mode: outcome.mode, pages: outcome.pages, published }
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
        const seen = new Set<string>()
        let cursor: string | undefined
        try {
          const client = await connectedCalendarClient(host, account.id, signal)
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
        } catch (error) {
          checkAbort(signal)
          if (calendarAccessCode(error)) await host.integrations.checkAccountHealth(account.id)
          errors.push(
            `Calendar discovery failed for account ${account.id}: ${calendarAccessCode(error) ?? "calendar-unavailable"}`
          )
          continue
        }
      }
      for (const calendarId of calendars) {
        try {
          results.push(await syncCalendar(account.id, calendarId, signal))
        } catch (error) {
          checkAbort(signal)
          // Account/calendar ids are operational metadata; payloads and provider
          // error bodies stay out of scheduled-task logs.
          if (calendarAccessCode(error)) await host.integrations.checkAccountHealth(account.id)
          errors.push(
            `Calendar synchronization failed for account ${account.id}, calendar ${calendarId}: ${calendarAccessCode(error) ?? "calendar-unavailable"}`
          )
          if (calendarAccessCode(error)) break
        }
      }
    }
    return { results, errors }
  }

  return { syncCalendar, syncSubscriptions }
}
