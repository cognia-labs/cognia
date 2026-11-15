import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

import { getDb } from "@/lib/db/schema"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { Transport } from "@/lib/tauri/transport-types"
import { collectPages, isPage } from "@/lib/tauri/companion-paging"

const MAX_PAGE_SIZE = 500
const MAX_PAGES = 10_000

/**
 * A negotiation that is overtaken while it is still in flight is superseded,
 * not failed: nothing it read may be published, but the question it was asking
 * is still open and the answer is one round trip away.
 *
 * Minted with a `code` rather than recognized by message text so a Host that
 * happens to answer this string cannot be mistaken for our own supersession.
 */
const SUPERSEDED_CODE = "session_history_scope_changed"

/**
 * How many times one hydration may be overtaken before it reports failure.
 *
 * The bound exists for a Host whose connection flaps without settling; the
 * ordinary boot spends two of these (`offline → reconnecting → connected`,
 * each of which invalidates through `watchConnection`).
 */
const MAX_SUPERSEDED_ATTEMPTS = 6

function supersededError(): Error {
  return Object.assign(new Error(SUPERSEDED_CODE), { code: SUPERSEDED_CODE })
}

function isSuperseded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SUPERSEDED_CODE
  )
}

interface SessionHistoryPage {
  rows: StoredMessage[]
  total?: number
}

/**
 * Who holds this conversation's history, decided once per session.
 *
 * - `timeline`: the host projects it as bounded pages (ADR-0027).
 * - `local`: the host has never seen this session. A paired browser runs the
 *   full app and creates its own conversations, so this is the ordinary case
 *   for anything started in the browser rather than synced down from the host.
 */
export interface SessionHistoryHydration {
  applied: number
  total: number
  mode: "timeline" | "local"
}

function assertTransportBinding(transport: Transport): void {
  const bound = transport as Transport & { assertRuntimeTargetBinding?: () => void }
  bound.assertRuntimeTargetBinding?.()
}

function currentScope(): string {
  const scope = getActiveRuntimeTargetContext()
  let databaseName: string | undefined
  try {
    databaseName = getDb().name
  } catch {
    /* No active database during static rendering. */
  }
  return JSON.stringify([databaseName, scope?.accountId, scope?.targetId, scope?.routingGeneration])
}

function scopedSession(sessionId: string): string {
  return JSON.stringify([currentScope(), sessionId])
}

const hydrated = new Map<string, SessionHistoryHydration["mode"]>()
const owners = new Map<string, Transport>()
const generations = new Map<string, number>()
const connectionSubscriptions = new Map<Transport, () => void>()

/** Forget ownership after reconnect or a committed ownership transfer. */
export function invalidateSessionHistory(sessionId?: string): void {
  const keys = sessionId ? [scopedSession(sessionId)] : [...owners.keys()]
  for (const key of keys) {
    generations.set(key, (generations.get(key) ?? 0) + 1)
    hydrated.delete(key)
    inflight.delete(key)
    for (const listener of modeListeners.get(key) ?? []) listener()
  }
}

function watchConnection(transport: Transport): void {
  if (connectionSubscriptions.has(transport)) return
  const observable = transport as Transport & {
    onConnectionStateChange?: (listener: (state: string) => void) => () => void
  }
  if (!observable.onConnectionStateChange) return
  connectionSubscriptions.set(
    transport,
    observable.onConnectionStateChange(() => {
      for (const [key, owner] of owners) {
        if (owner !== transport) continue
        generations.set(key, (generations.get(key) ?? 0) + 1)
        hydrated.delete(key)
        inflight.delete(key)
        for (const listener of modeListeners.get(key) ?? []) listener()
      }
    })
  )
}
const inflight = new Map<string, Promise<SessionHistoryHydration>>()
const modeListeners = new Map<string, Set<() => void>>()

function publishMode(sessionId: string, mode: SessionHistoryHydration["mode"]): void {
  hydrated.set(sessionId, mode)
  for (const listener of modeListeners.get(sessionId) ?? []) listener()
}

export function getSessionHistoryMode(
  sessionId: string | null
): SessionHistoryHydration["mode"] | null {
  return sessionId ? (hydrated.get(scopedSession(sessionId)) ?? null) : null
}

export function subscribeSessionHistoryMode(sessionId: string, listener: () => void): () => void {
  sessionId = scopedSession(sessionId)
  const listeners = modeListeners.get(sessionId) ?? new Set<() => void>()
  listeners.add(listener)
  modeListeners.set(sessionId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) modeListeners.delete(sessionId)
  }
}

/**
 * Decide who renders one selected session's history: the host's timeline
 * projection, or local Dexie for a conversation the host has never stored.
 */
export function hydrateSessionHistory(
  transport: Transport,
  sessionId: string
): Promise<SessionHistoryHydration> {
  try {
    assertTransportBinding(transport)
  } catch (error) {
    return Promise.reject(error)
  }
  watchConnection(transport)
  const scope = currentScope()
  const key = scopedSession(sessionId)
  if (owners.has(key) && owners.get(key) !== transport) invalidateSessionHistory(sessionId)
  owners.set(key, transport)
  const completedMode = hydrated.get(key)
  if (completedMode) return Promise.resolve({ applied: 0, total: 0, mode: completedMode })
  const existing = inflight.get(key)
  if (existing) return existing

  /**
   * Re-take the coalescing slot after a supersession.
   *
   * `invalidateSessionHistory` drops the in-flight entry so a stale answer
   * cannot be handed out. Without re-taking it, the very next caller — the chat pane and the
   * session hook negotiate the same conversation — opens a second, parallel
   * hydration of a session this one is already re-asking about.
   */
  const reclaim = () => {
    owners.set(key, transport)
    if (!inflight.has(key)) inflight.set(key, task)
  }

  /**
   * Being overtaken mid-negotiation is the ordinary case, not a failure.
   *
   * `watchConnection` invalidates on every connection state change, and a
   * companion transport walks `offline → reconnecting → connected` while the
   * first pane is already asking who owns the transcript. Reporting that as an
   * error reached the chat pane as "listMessages failed" and latched an error
   * card over a conversation whose transcript was one round trip away — the
   * pane had nothing left to re-trigger it, because the mode it subscribes to
   * never left `null`. So ask again against the settled scope instead, and
   * only surface a failure once the ground refuses to stop moving.
   */
  const task: Promise<SessionHistoryHydration> = (async () => {
    for (let attempt = 1; ; attempt += 1) {
      const generation = generations.get(key) ?? 0
      const assertCurrent = () => {
        if (
          scope !== currentScope() ||
          owners.get(key) !== transport ||
          generation !== (generations.get(key) ?? 0)
        ) {
          throw supersededError()
        }
        assertTransportBinding(transport)
      }
      try {
        const result = await negotiate(transport, sessionId, assertCurrent)
        assertCurrent()
        publishMode(key, result.mode)
        return result
      } catch (error) {
        // Reconnects within this scope may retry. A different Host/account or
        // transport must start its own request; this transport still owns the
        // old Host and must never hydrate the newly selected database.
        if (
          !isSuperseded(error) ||
          scope !== currentScope() ||
          owners.get(key) !== transport ||
          attempt >= MAX_SUPERSEDED_ATTEMPTS
        )
          throw error
        reclaim()
      }
    }
  })()
  inflight.set(key, task)
  const finished = () => {
    if (inflight.get(key) === task) inflight.delete(key)
  }
  void task.then(finished, finished)
  return task
}

function isSessionNotFound(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
  return record?.code === "SESSION_NOT_FOUND"
}

async function negotiate(
  transport: Transport,
  sessionId: string,
  assertCurrent: () => void
): Promise<SessionHistoryHydration> {
  assertCurrent()
  const capability = await transport.call<{ version?: unknown }>("transcript_capabilities", {})
  assertCurrent()
  if (capability?.version !== 1) throw new Error("invalid transcript capability response")
  return negotiateTimelineOwnership(transport, sessionId, assertCurrent)
}

/**
 * Speaking the protocol and holding this conversation are two different facts,
 * and only the second one decides which surface may render it.
 *
 * The capability handshake answers the first. Reading it as the second handed
 * every conversation to the host's projection, including the ones this browser
 * created and the host has never stored: the pane then rendered whatever the
 * host said about a session it did not have, which was a refusal, while the
 * complete transcript sat unread in local Dexie.
 *
 * One newest turn is enough to settle it, and asking before the surface mounts
 * keeps a locally owned conversation from painting an error card first.
 */
async function negotiateTimelineOwnership(
  transport: Transport,
  sessionId: string,
  assertCurrent: () => void
): Promise<SessionHistoryHydration> {
  try {
    assertCurrent()
    await transport.call("session_timeline", {
      session_id: sessionId,
      direction: "backward",
      limit: 1,
    })
  } catch (error) {
    assertCurrent()
    if (!isSessionNotFound(error)) throw error
    return { applied: 0, total: 0, mode: "local" }
  }
  assertCurrent()
  return { applied: 0, total: 0, mode: "timeline" }
}

/** An explicit export: complete host rows, without mutating the local timeline mirror. */
export interface CompleteSessionHistory {
  session: ChatSession
  messages: StoredMessage[]
  /** Recheck before publishing a child into the currently active database. */
  assertCurrent: () => void
}

export async function readCompleteSessionHistory(
  transport: Transport,
  sessionId: string,
  options: { maxPages?: number } = {}
): Promise<CompleteSessionHistory | null> {
  const scope = currentScope()
  const assertCurrent = () => {
    if (scope !== currentScope()) throw supersededError()
    assertTransportBinding(transport)
  }
  assertCurrent()
  const limits = { maxPages: options.maxPages ?? MAX_PAGES, requireComplete: true }
  const readSession = async () => {
    const sessions = await collectPages<ChatSession>(async (pageToken) => {
      assertCurrent()
      const page = await transport.call("session_list", { pageSize: MAX_PAGE_SIZE, pageToken })
      assertCurrent()
      if (!isPage(page)) throw new Error("invalid session history metadata page")
      if (
        page.items.some(
          (row) => !row || typeof row !== "object" || typeof (row as ChatSession).id !== "string"
        )
      ) {
        throw new Error("invalid session history metadata row")
      }
      const matches = (page.items as ChatSession[]).filter((row) => row.id === sessionId)
      // This is a keyed lookup, so later session pages cannot add history for
      // an already located source. The absent case still drains to completion.
      return {
        items: matches,
        ...(matches.length === 0 && page.nextPageToken !== undefined
          ? { nextPageToken: page.nextPageToken }
          : {}),
      }
    }, limits)
    return sessions.find((session) => session.id === sessionId)
  }
  const session = await readSession()
  if (!session) return null
  const ids = new Set<string>()
  let expectedTotal: number | undefined
  const messages = await collectPages<StoredMessage>(async (pageToken) => {
    assertCurrent()
    const page = await transport.call("message_get_by_session", {
      session_id: sessionId,
      pageSize: MAX_PAGE_SIZE,
      pageToken,
    })
    assertCurrent()
    if (!isPage(page)) throw new Error("invalid session history page")
    const total = (page as { total?: number }).total
    assertPage({ rows: page.items as StoredMessage[], total }, sessionId)
    if (total !== undefined) {
      if (expectedTotal !== undefined && total !== expectedTotal)
        throw new Error("session history changed during export")
      expectedTotal = total
    }
    for (const row of page.items as StoredMessage[]) {
      if (typeof row.id !== "string" || ids.has(row.id))
        throw new Error("invalid or repeated session history message")
      ids.add(row.id)
    }
    return page as { items: StoredMessage[]; nextPageToken?: string }
  }, limits)
  if (expectedTotal !== undefined && messages.length !== expectedTotal) {
    throw new Error("incomplete session history export")
  }
  const after = await readSession()
  // The protocol does not offer an atomic export. Revision-bearing hosts let
  // us reject concurrent transcript changes; updatedAt also covers domain state.
  if (
    !after ||
    after.transcriptRevision !== session.transcriptRevision ||
    after.updatedAt !== session.updatedAt ||
    after.workingSet?.revision !== session.workingSet?.revision
  ) {
    throw new Error("session history changed during export")
  }
  assertCurrent()
  return { session, messages, assertCurrent }
}

function assertPage(page: SessionHistoryPage, sessionId: string): void {
  if (
    !page ||
    !Array.isArray(page.rows) ||
    (page.total !== undefined && (!Number.isFinite(page.total) || page.total < 0))
  ) {
    throw new Error("invalid session history page")
  }
  for (const row of page.rows) {
    if (!row || typeof row !== "object" || typeof row.sessionId !== "string") {
      throw new Error("invalid session history row")
    }
    if (row.sessionId !== sessionId) {
      throw new Error(`session history page session mismatch: expected ${sessionId}`)
    }
  }
}

/** Test-only reset for the module-level completion/in-flight cache. */
export function __resetHydratedSessionHistoryForTests(): void {
  for (const unsubscribe of connectionSubscriptions.values()) unsubscribe()
  connectionSubscriptions.clear()
  owners.clear()
  generations.clear()
  hydrated.clear()
  inflight.clear()
  modeListeners.clear()
}
