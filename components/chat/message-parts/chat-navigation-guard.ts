import { useChatStore } from "@/stores/chat"

/**
 * Snapshot the conversation navigation a link click came from. The returned
 * check is false once the focused conversation, the split pane, or whether
 * the clicked conversation is still open has changed — so an async reveal that
 * resolves after the user moved on is dropped instead of repopulating another
 * conversation's dock. A click from a secondary split pane stays current.
 */
export function captureChatNavigation(sessionId: string): () => boolean {
  const snapshot = (): string => {
    const state = useChatStore.getState()
    return [
      state.activeSessionId ?? "",
      state.splitSessionId ?? "",
      state.openSessionIds.includes(sessionId) ? "open" : "closed",
    ].join("\u0000")
  }
  const atClick = snapshot()
  return () => snapshot() === atClick
}
