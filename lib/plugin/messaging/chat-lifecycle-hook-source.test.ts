import { publishChatLifecycleEvent } from "@/lib/chat/lifecycle-events"
import { useChatStore } from "@/stores/chat/chat-store"
import { getPluginLifecycleHooks } from "./hooks-system"
import { installChatLifecycleHookSource } from "./chat-lifecycle-hook-source"

jest.mock("./hooks-system", () => {
  const hooks = Object.fromEntries(
    [
      "SessionCreate",
      "SessionDelete",
      "SessionClear",
      "MessageDelete",
      "MessageEdit",
      "ChatRegenerate",
      "SessionRename",
      "ModelSwitch",
      "ChatModeSwitch",
      "SystemPromptChange",
      "SessionSwitch",
    ].map((name) => [`dispatchOn${name}`, jest.fn()])
  )
  return { getPluginLifecycleHooks: () => hooks }
})

it("projects committed facts and active-session changes, then cleans up", () => {
  const hooks = getPluginLifecycleHooks()
  const stop = installChatLifecycleHookSource()
  for (const type of ["session-created", "session-deleted", "session-cleared"] as const)
    publishChatLifecycleEvent({ type, sessionId: "s" })
  publishChatLifecycleEvent({ type: "message-deleted", sessionId: "s", messageId: "m" })
  publishChatLifecycleEvent({
    type: "message-edited",
    sessionId: "s",
    messageId: "m",
    content: "new",
    previousContent: "old",
  })
  publishChatLifecycleEvent({ type: "chat-regenerated", sessionId: "s", messageId: "m" })
  const previous = { id: "s", title: "old", model: "before", systemPrompt: "old" }
  publishChatLifecycleEvent({
    type: "session-updated",
    previous,
    current: {
      ...previous,
      title: "new",
      model: "after",
      systemPrompt: "new",
      permissionMode: "plan",
    },
  })
  useChatStore.setState({ activeSessionId: "hook-session" })
  useChatStore.setState({ activeSessionId: "hook-session" })
  expect(hooks.dispatchOnSessionCreate).toHaveBeenCalledWith("s")
  expect(hooks.dispatchOnSessionDelete).toHaveBeenCalledWith("s")
  expect(hooks.dispatchOnSessionClear).toHaveBeenCalledWith("s")
  expect(hooks.dispatchOnMessageDelete).toHaveBeenCalledWith("m", "s")
  expect(hooks.dispatchOnMessageEdit).toHaveBeenCalledWith("m", "old", "new", "s")
  expect(hooks.dispatchOnChatRegenerate).toHaveBeenCalledWith("m", "s")
  expect(hooks.dispatchOnSessionRename).toHaveBeenCalledWith("s", "old", "new")
  expect(hooks.dispatchOnModelSwitch).toHaveBeenCalledWith("", "after", undefined, "before")
  expect(hooks.dispatchOnSystemPromptChange).toHaveBeenCalledWith("s", "new", "old")
  expect(hooks.dispatchOnChatModeSwitch).toHaveBeenCalledWith("s", "plan", "default")
  expect(hooks.dispatchOnSessionSwitch).toHaveBeenCalledTimes(1)
  stop()
  publishChatLifecycleEvent({ type: "session-created", sessionId: "late" })
  useChatStore.setState({ activeSessionId: "late" })
  expect(hooks.dispatchOnSessionCreate).toHaveBeenCalledTimes(1)
  expect(hooks.dispatchOnSessionSwitch).toHaveBeenCalledTimes(1)
})
