import { subscribeChatLifecycleEvents } from "@/lib/chat/lifecycle-events"
import { useChatStore } from "@/stores/chat/chat-store"
import { getPluginLifecycleHooks } from "./hooks-system"

export function installChatLifecycleHookSource(): () => void {
  const stopEvents = subscribeChatLifecycleEvents((event) => {
    const hooks = getPluginLifecycleHooks()
    switch (event.type) {
      case "session-created":
        hooks.dispatchOnSessionCreate(event.sessionId)
        break
      case "session-deleted":
        hooks.dispatchOnSessionDelete(event.sessionId)
        break
      case "session-cleared":
        hooks.dispatchOnSessionClear(event.sessionId)
        break
      case "message-deleted":
        hooks.dispatchOnMessageDelete(event.messageId, event.sessionId)
        break
      case "message-edited":
        hooks.dispatchOnMessageEdit(
          event.messageId,
          event.previousContent,
          event.content,
          event.sessionId
        )
        break
      case "chat-regenerated":
        hooks.dispatchOnChatRegenerate(event.messageId, event.sessionId)
        break
      case "session-updated": {
        const { previous, current } = event
        if (previous.title !== current.title)
          hooks.dispatchOnSessionRename(current.id, previous.title, current.title)
        if (previous.systemPrompt !== current.systemPrompt)
          hooks.dispatchOnSystemPromptChange(
            current.id,
            current.systemPrompt ?? "",
            previous.systemPrompt
          )
        if (
          previous.model !== current.model ||
          previous.providerOverride !== current.providerOverride
        ) {
          hooks.dispatchOnModelSwitch(
            current.providerOverride ?? "",
            current.model ?? "",
            previous.providerOverride,
            previous.model
          )
        }
        if (previous.permissionMode !== current.permissionMode) {
          hooks.dispatchOnChatModeSwitch(
            current.id,
            current.permissionMode ?? "default",
            previous.permissionMode ?? "default"
          )
        }
        break
      }
    }
  })
  const stopActive = useChatStore.subscribe((state, previous) => {
    if (state.activeSessionId && state.activeSessionId !== previous.activeSessionId) {
      getPluginLifecycleHooks().dispatchOnSessionSwitch(state.activeSessionId)
    }
  })
  return () => {
    stopActive()
    stopEvents()
  }
}
