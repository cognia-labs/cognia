// Chat lifecycle → pet events. Watches per-session status in `useChatStore`
// rather than the focused-session projection so switching focus from a
// streaming session to an idle one never fabricates a completed-turn `review`
// (F2), and background turns still emit their real transitions when they settle.

import { useChatStore } from "@/stores/chat/chat-store"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { PetEmit } from "../pet-event-bus"

const FALLBACK_SESSION_KEY = "__active__"

type ChatStatusStoreSlice = {
  activeSessionId?: string | null
  status: ChatStatus
  sessions?: Record<string, { status: ChatStatus }>
}

export function chatStatusToEmit(
  status: ChatStatus,
  prev: ChatStatus,
  emit: PetEmit,
  sessionId?: string
): void {
  if (status === prev) return
  const meta = sessionId ? { sessionId } : undefined
  switch (status) {
    case "streaming":
      emit({ source: "chat", kind: "thinking", ...(meta ? { meta } : {}) })
      break
    case "awaiting_approval":
      emit({ source: "chat", kind: "waiting", ...(meta ? { meta } : {}) })
      break
    case "error":
      emit({ source: "chat", kind: "error", ...(meta ? { meta } : {}) })
      break
    case "idle":
      if (prev === "streaming" || prev === "awaiting_approval") {
        emit({ source: "chat", kind: "review", xp: 2, ...(meta ? { meta } : {}) })
      } else {
        emit({ source: "chat", kind: "idle", ...(meta ? { meta } : {}) })
      }
      break
  }
}

function snapshotSessionStatuses(state: ChatStatusStoreSlice): Map<string, ChatStatus> {
  const map = new Map<string, ChatStatus>()
  const sessions = state.sessions
  if (sessions) {
    for (const [id, slice] of Object.entries(sessions)) {
      if (slice) map.set(id, slice.status)
    }
  }
  if (state.activeSessionId && !map.has(state.activeSessionId)) {
    map.set(state.activeSessionId, state.status)
  }
  if (map.size === 0) {
    map.set(FALLBACK_SESSION_KEY, state.status)
  }
  return map
}

export function wireChatSource(emit: PetEmit): () => void {
  let prevStatuses = snapshotSessionStatuses(useChatStore.getState())

  return useChatStore.subscribe((state) => {
    const nextStatuses = snapshotSessionStatuses(state)

    for (const [id, nextStatus] of nextStatuses) {
      const prevStatus = prevStatuses.get(id) ?? "idle"
      const sessionId = id === FALLBACK_SESSION_KEY ? undefined : id
      chatStatusToEmit(nextStatus, prevStatus, emit, sessionId)
    }

    // If an active session was closed/removed without first transitioning to
    // idle, release its persistent radar entry without awarding completion XP.
    for (const [id, prevStatus] of prevStatuses) {
      if (nextStatuses.has(id)) continue
      if (prevStatus === "streaming" || prevStatus === "awaiting_approval") {
        const sessionId = id === FALLBACK_SESSION_KEY ? undefined : id
        emit({ source: "chat", kind: "idle", ...(sessionId ? { meta: { sessionId } } : {}) })
      }
    }

    prevStatuses = nextStatuses
  })
}
