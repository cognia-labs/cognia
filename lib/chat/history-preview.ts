/**
 * The newest slice of a long conversation, shown while its full history loads.
 *
 * Opening a conversation reads every row it has — tool outputs and all — before
 * anything renders, so a long agent session sat on the loader for as long as
 * IndexedDB took to clone megabytes of history. Most of that history is far
 * above the fold. A tail read (`listRecentMessages`) walks the index backwards
 * and stops after a screenful, so it lands long before the full read: the pane
 * draws the tail at once, and the full history slides in above it when it
 * arrives (the list keeps the reader's place; `MessageList` anchors prepends).
 *
 * The preview is NOT the conversation. It lives outside the chat store on
 * purpose: `messages` there is what persistence diffs against, and a write
 * built on a 30-message tail would delete every older row. So a preview is
 * read-only by construction, and anything that would write the transcript —
 * a send, a regenerate, an edit, a compact — waits for the full history first
 * ({@link waitForFullHistory}). That wait is normally shorter than the time it
 * takes to type a reply.
 */

import type { UIMessage } from "ai"

/** Messages in a preview: comfortably more than one screen. */
export const HISTORY_PREVIEW_TAIL = 30

/**
 * Conversations at or below this many messages skip the preview: the full read
 * is about as fast as the tail read, and a two-step load would only add a
 * second render. Matches the list's virtualization threshold, so a previewed
 * conversation is always one the list virtualizes.
 */
export const HISTORY_PREVIEW_MIN_TOTAL = 40

export interface HistoryPreview {
  /** The newest messages, oldest first. */
  messages: UIMessage[]
  /** How many messages the full history has. */
  total: number
  /** The conversation's branch selection, to project the tail like the full history. */
  activeBranchByGroup: Record<string, string>
}

const previews = new Map<string, HistoryPreview>()
const listeners = new Map<string, Set<() => void>>()
const waiters = new Map<string, Array<() => void>>()

export function getHistoryPreview(sessionId: string | null | undefined): HistoryPreview | null {
  return sessionId ? (previews.get(sessionId) ?? null) : null
}

/** Show `preview` for `sessionId` until its full history is published. */
export function setHistoryPreview(sessionId: string, preview: HistoryPreview): void {
  previews.set(sessionId, preview)
  notify(sessionId)
}

/**
 * The full history was published (or failed, or was superseded): drop the
 * preview and release everything waiting on it.
 */
export function clearHistoryPreview(sessionId: string): void {
  const had = previews.delete(sessionId)
  const pending = waiters.get(sessionId)
  waiters.delete(sessionId)
  pending?.forEach((resolve) => resolve())
  if (had) notify(sessionId)
}

/** Drop every preview — a Host / database switch invalidates all of them. */
export function clearAllHistoryPreviews(): void {
  for (const sessionId of [...previews.keys(), ...waiters.keys()]) clearHistoryPreview(sessionId)
}

export function subscribeHistoryPreview(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(sessionId)
  }
}

/**
 * Resolves once `sessionId` shows its full history — at once when it is not
 * showing a preview. Every transcript write from the pane goes through this.
 */
export function waitForFullHistory(sessionId: string | null | undefined): Promise<void> {
  if (!sessionId || !previews.has(sessionId)) return Promise.resolve()
  return new Promise((resolve) => {
    const pending = waiters.get(sessionId) ?? []
    pending.push(resolve)
    waiters.set(sessionId, pending)
  })
}

/**
 * Run `action` once `sessionId` shows its full history: right now, in the
 * same call, when no preview is up (the normal case, and what callers that
 * test or sequence their own effects rely on), otherwise when it is replaced.
 */
export function whenFullHistory<T>(
  sessionId: string | null | undefined,
  action: () => T
): T | Promise<Awaited<T>> {
  if (!sessionId || !previews.has(sessionId)) return action()
  return waitForFullHistory(sessionId).then(() => action() as Awaited<T>)
}

function notify(sessionId: string): void {
  listeners.get(sessionId)?.forEach((listener) => listener())
}
