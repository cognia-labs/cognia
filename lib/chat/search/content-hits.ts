/**
 * Where each conversation's message content matched a query — what a
 * conversation list shows on a row that surfaced only through its messages,
 * and where opening that row goes (sidebar audit item 6). The ⌘K palette's
 * message hits already carried both; the sidebar and the conversation manager
 * only said "matched inside messages" and opened at the bottom.
 *
 * Pure: it folds the engine's results (`ChatSearchResult`, best hit first per
 * conversation under `collapseBySession`) into one hit per conversation.
 */

import type { ChatSearchResult } from "./engine"
import type { Snippet } from "./snippet"

/** The message a conversation matched in, and the excerpt around the match. */
export interface ContentHit {
  messageId: string
  snippet: Snippet
}

export const NO_CONTENT_HITS: ReadonlyMap<string, ContentHit> = new Map()

/** The first (best-ranked) hit of every conversation in `results`. */
export function contentHitsBySession(
  results: readonly Pick<ChatSearchResult, "sessionId" | "messageId" | "snippet">[]
): ReadonlyMap<string, ContentHit> {
  if (results.length === 0) return NO_CONTENT_HITS
  const hits = new Map<string, ContentHit>()
  for (const result of results) {
    if (!hits.has(result.sessionId)) {
      hits.set(result.sessionId, { messageId: result.messageId, snippet: result.snippet })
    }
  }
  return hits
}
