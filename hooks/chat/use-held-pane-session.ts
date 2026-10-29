"use client"

/**
 * Keep a chat pane on the conversation it was showing while the next one's row
 * is still being read.
 *
 * Switching conversations is a store write (`activeSessionId`) followed by an
 * async Dexie read of the new session's row. In between, the pane has an id but
 * no row, and a pane with no row is the home surface: every first visit to a
 * conversation flashed the welcome screen and then animated back into a
 * conversation. Revisits are served from the pane-row cache
 * (`lib/chat/pane-row-cache.ts`); this covers the rest by doing what a native
 * list-detail view does — leave the current detail on screen until the next one
 * is ready, then swap once, under the normal session-switch settle.
 *
 * Only while the caller says the row is PENDING. A session that resolved to
 * nothing (deleted, another workspace) or a deliberate return home shows home
 * at once, and drops what was held so a later pending gap cannot resurrect a
 * conversation from before it.
 */

import { useState } from "react"
import type { ChatSession } from "@cognia/agent-config-types"

export interface HeldPaneSession {
  session: ChatSession | null
  sessionId: string | undefined
  /** True while the previous conversation stands in for a pending one. */
  held: boolean
}

export function useHeldPaneSession(
  session: ChatSession | null,
  sessionId: string | undefined,
  pending: boolean
): HeldPaneSession {
  const [last, setLast] = useState<{ session: ChatSession; sessionId: string | undefined } | null>(
    null
  )
  // Adjusting state from props during render (React's documented pattern),
  // guarded so it settles in one extra pass.
  if (session && (last?.session !== session || last.sessionId !== sessionId)) {
    setLast({ session, sessionId })
  } else if (!session && !pending && last) {
    setLast(null)
  }
  if (!session && pending && last) {
    return { session: last.session, sessionId: last.sessionId, held: true }
  }
  return { session, sessionId, held: false }
}
