"use client"

/**
 * Jump to a message in a conversation that may not be open yet.
 *
 * Within one conversation the viewport store's `jumpToMessage` is enough: the
 * list is already mounted and either has the row or does not. Crossing a
 * conversation boundary adds a wait nobody can skip — focusing a session only
 * *starts* its history load, and the pane that owns the jump has not mounted
 * yet. Firing straight after `setActiveSession` (or one animation frame later)
 * reports "message not found" for a message that exists and is about to render.
 *
 * ADR-0094 states the rule as: consumption waits for the target session's
 * history to hydrate. This is that wait, in one place, so every caller gets the
 * same ceiling instead of its own guess.
 */

import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

/**
 * How long to keep waiting for the target session's history.
 *
 * A ceiling is required: the id may be stale (the conversation was deleted, the
 * link came from another device), and without one a caller would wait for the
 * rest of the session and eventually fire at whatever appeared.
 */
export const CROSS_SESSION_JUMP_TIMEOUT_MS = 10_000

export interface CrossSessionJumpOptions {
  /** Where the row should land. Mirrors `jumpToMessage`'s own option. */
  align?: "center" | "start"
  /** Override the hydration ceiling. Tests use this; product code should not. */
  timeoutMs?: number
  /** Keep this parent active while targeting a mounted side-chat list. */
  activeSessionId?: string
  signal?: AbortSignal
}

/** Whether `sessionId`'s history is loaded and actually contains `messageId`. */
function rowIsRenderable(sessionId: string, messageId: string, activeSessionId: string): boolean {
  const state = useChatStore.getState()
  if (state.activeSessionId !== activeSessionId) return false
  if (sessionId !== activeSessionId) {
    const slice = state.sessions[sessionId]
    return !!slice && !slice.messagesLoading && slice.messages.some((m) => m.id === messageId)
  }
  if (state.messagesLoading) return false
  // The ROW, not merely "loading finished": the list owns the jump and can only
  // reach a message it renders.
  return state.messages.some((message) => message.id === messageId)
}

/**
 * Focus `sessionId`, wait for it to be able to render `messageId`, then jump.
 *
 * Resolves `true` only when the jump landed. `false` covers every way it can
 * fail — the history never arrived, the user navigated elsewhere while waiting,
 * or the list refused the row — so callers can say why instead of appearing to
 * ignore the click.
 */
export function jumpToSessionMessage(
  sessionId: string,
  messageId: string,
  options: CrossSessionJumpOptions = {}
): Promise<boolean> {
  const {
    align,
    timeoutMs = CROSS_SESSION_JUMP_TIMEOUT_MS,
    activeSessionId = sessionId,
    signal,
  } = options
  if (signal?.aborted) return Promise.resolve(false)

  if (useChatStore.getState().activeSessionId !== activeSessionId) {
    useChatStore.getState().setActiveSession(activeSessionId)
  }

  const attempt = (): boolean | null => {
    if (!rowIsRenderable(sessionId, messageId, activeSessionId)) return null
    const viewport = useChatViewportStore.getState()
    const jump =
      sessionId === activeSessionId ? viewport.jumpToMessage : viewport.sessionJumps[sessionId]
    // History is here but the pane has not registered its list yet — keep
    // waiting rather than reporting a failure the next tick would disprove.
    if (!jump) return null
    const landed = jump(messageId, undefined, align ? { align } : undefined)
    // A side-chat slice can hydrate before React commits its new list callback.
    return !landed && sessionId !== activeSessionId ? null : landed
  }

  const immediate = attempt()
  if (immediate !== null) return Promise.resolve(immediate)

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (landed: boolean) => {
      if (settled) return
      settled = true
      unsubscribeStore()
      unsubscribeViewport()
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve(landed)
    }

    const check = () => {
      // The user moved on. Dragging them back would be worse than not landing.
      const active = useChatStore.getState().activeSessionId
      if (active !== null && active !== activeSessionId) {
        finish(false)
        return
      }
      const result = attempt()
      if (result !== null) finish(result)
    }

    const unsubscribeStore = useChatStore.subscribe(check)
    // The list registers its jump through the viewport store, which is a
    // separate store — without this the wait can outlast the row's arrival.
    const unsubscribeViewport = useChatViewportStore.subscribe(check)
    const timer = setTimeout(() => finish(false), timeoutMs)
    const abort = () => finish(false)
    signal?.addEventListener("abort", abort, { once: true })
  })
}
