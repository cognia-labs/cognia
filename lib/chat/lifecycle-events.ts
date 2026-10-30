import type { ChatSession } from "@cognia/agent-config-types"

type SessionMetadata = Pick<
  ChatSession,
  "id" | "title" | "model" | "providerOverride" | "systemPrompt" | "permissionMode"
>

/** Committed local mutations, independent of any UI or plugin runtime. */
export type ChatLifecycleEvent =
  | { type: "session-created" | "session-deleted" | "session-cleared"; sessionId: string }
  | { type: "session-updated"; previous: SessionMetadata; current: SessionMetadata }
  | { type: "message-deleted" | "chat-regenerated"; sessionId: string; messageId: string }
  | {
      type: "message-edited"
      sessionId: string
      messageId: string
      previousContent: string
      content: string
    }

const listeners = new Set<(event: ChatLifecycleEvent) => void>()

export function publishChatLifecycleEvent(
  event: ChatLifecycleEvent,
  transaction?: { on(event: "complete", listener: () => void): unknown } | null
): void {
  if (transaction) {
    transaction.on("complete", () => publishChatLifecycleEvent(event))
    return
  }
  if (event.type === "session-updated") {
    const metadata = ({
      id,
      title,
      model,
      providerOverride,
      systemPrompt,
      permissionMode,
    }: SessionMetadata): SessionMetadata => ({
      id,
      title,
      model,
      providerOverride,
      systemPrompt,
      permissionMode,
    })
    event = { ...event, previous: metadata(event.previous), current: metadata(event.current) }
  }
  for (const listener of [...listeners]) {
    try {
      listener(structuredClone(event))
    } catch {
      /* Observers cannot undo a committed mutation. */
    }
  }
}

export function subscribeChatLifecycleEvents(
  listener: (event: ChatLifecycleEvent) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
