import { useChatStore } from "@/stores/chat/chat-store"
import { runChatSend, type AgentChatSendContext } from "./agent-chat-send"

function context(overrides: Partial<AgentChatSendContext> = {}) {
  return {
    tInlineErr: ((key: string) => `inline:${key}`) as unknown as AgentChatSendContext["tInlineErr"],
    refuseCapturedTurn: jest.fn(() => false),
    ...overrides,
  } as unknown as AgentChatSendContext
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null } as never)
})

it("refuses without a session and says so in the chat", async () => {
  const setError = jest.spyOn(useChatStore.getState(), "setError")
  await expect(runChatSend(context(), "hello")).resolves.toBe(false)
  expect(setError).toHaveBeenCalledWith("inline:noSession")

  await expect(runChatSend(context(), "hello", undefined, { throwOnError: true })).rejects.toThrow(
    "inline:noSession"
  )
})

it("refuses an empty turn before anything reaches the transcript", async () => {
  const ctx = context()
  await expect(runChatSend(ctx, "   ", undefined, { sessionId: "chat" })).resolves.toBe(false)
  await expect(runChatSend(ctx, [], undefined, { sessionId: "chat" })).resolves.toBe(false)
  await expect(
    runChatSend(ctx, "", undefined, { sessionId: "chat", throwOnError: true })
  ).rejects.toThrow("empty_chat_turn")
  expect(ctx.refuseCapturedTurn).not.toHaveBeenCalled()
})

it("rejects a turn while another surface holds the session's turn", async () => {
  const ctx = context({ refuseCapturedTurn: jest.fn(() => true) })
  await expect(runChatSend(ctx, "hello", undefined, { sessionId: "chat" })).rejects.toThrow(
    "session_turn_busy"
  )
  expect(ctx.refuseCapturedTurn).toHaveBeenCalledWith("chat")
})
