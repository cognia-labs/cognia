/**
 * The last full session rows the chat panes were shown, per data scope.
 *
 * `useSessions({ listOnly: true })` reads the panes' rows by id through a live
 * query keyed on the active (and split) session id, so every switch starts a
 * fresh read that is pending for a render or two. With nothing to show in that
 * gap the pane resolved to "no session" and painted the HOME surface, then
 * animated straight back into the conversation once the row landed — a
 * conversation → home → conversation flicker on every switch.
 *
 * A conversation the user has already opened has a row in hand: it is the one
 * the previous read returned. Serving it for the gap makes a revisit resolve in
 * the same render as the click. The live read still runs and replaces it a
 * moment later, so a stale field (a rename on another device) is corrected
 * within the same frame budget it always was. A first visit has no cached row
 * and stays pending; the pane holds the previous conversation through that
 * gap (`hooks/chat/use-held-pane-session.ts`).
 *
 * Scoped by the caller's key (runtime target + database + workspace) so a row
 * never crosses into a Host or workspace it does not belong to, and bounded
 * per scope.
 */

import type { ChatSession } from "@cognia/agent-config-types"

/** Rows kept per scope; the oldest are dropped first. */
export const PANE_ROW_CACHE_LIMIT = 64

const scopes = new Map<string, Map<string, ChatSession>>()

/**
 * Record a completed pane read. `requestedIds` are the ids the read asked for:
 * any of them missing from `rows` is gone (deleted, moved to another
 * workspace) and is forgotten rather than served again.
 */
export function rememberPaneRows(
  scope: string,
  requestedIds: readonly string[],
  rows: readonly ChatSession[]
): void {
  let cache = scopes.get(scope)
  if (!cache) {
    cache = new Map()
    scopes.set(scope, cache)
  }
  const found = new Set(rows.map((row) => row.id))
  for (const id of requestedIds) if (!found.has(id)) cache.delete(id)
  for (const row of rows) {
    cache.delete(row.id)
    cache.set(row.id, row)
  }
  while (cache.size > PANE_ROW_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * The cached rows for `ids`, in order, or undefined unless every one of them
 * is cached — a partial answer would resolve a split pane as "absent".
 */
export function readCachedPaneRows(
  scope: string,
  ids: readonly string[]
): readonly ChatSession[] | undefined {
  const cache = scopes.get(scope)
  if (!cache || ids.length === 0) return undefined
  const rows: ChatSession[] = []
  for (const id of ids) {
    const row = cache.get(id)
    if (!row) return undefined
    rows.push(row)
  }
  return rows
}

/** Forget everything. For tests and a full data-scope reset. */
export function clearPaneRowCache(): void {
  scopes.clear()
}
