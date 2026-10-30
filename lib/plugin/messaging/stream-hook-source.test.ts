import { onClaudeMessage } from "@/lib/claude/ipc"
import { getPluginEventHooks } from "./hooks-system"
import { installStreamHookSource } from "./stream-hook-source"
import type { ClaudeEvent } from "@cognia/agent-config-types"
jest.mock("@/lib/claude/ipc", () => ({ onClaudeMessage: jest.fn() }))
jest.mock("./hooks-system", () => {
  const hooks = {
    dispatchStreamStart: jest.fn(),
    dispatchStreamChunk: jest.fn(),
    dispatchStreamEnd: jest.fn(),
  }
  return { getPluginEventHooks: () => hooks }
})

it("observes real transport frames once, including snapshots, errors and teardown races", async () => {
  let receive!: (event: ClaudeEvent) => void
  const unsubscribe = jest.fn()
  jest.mocked(onClaudeMessage).mockImplementation(async (handler) => {
    receive = handler
    return unsubscribe
  })
  const hooks = getPluginEventHooks()
  const stop = installStreamHookSource()
  await Promise.resolve()
  const event = (inner: unknown) =>
    receive({ type: "event", sessionId: "s", event: inner } as ClaudeEvent)
  event({ type: "stream_event", event: { type: "message_start", message: { id: "m" } } })
  event({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
  })
  event({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi!" }] } })
  event({ type: "stream_event", event: { type: "message_stop" } })
  event({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi!" }] } })
  event({ type: "result" })
  expect(hooks.dispatchStreamStart).toHaveBeenCalledTimes(1)
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(1, "s", "hi", "hi")
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(2, "s", "!", "hi!")
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "hi!")
  event({
    type: "assistant",
    message: { id: "second", content: [{ type: "text", text: "snapshot" }] },
  })
  event({ type: "assistant", message: { id: "third", content: [{ type: "text", text: "next" }] } })
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "snapshot")
  receive({ type: "sidecar_exited", code: 1 } as ClaudeEvent)
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "next")
  event({
    type: "assistant",
    message: { id: "error", content: [{ type: "text", text: "failed" }] },
  })
  receive({ type: "session_ended", sessionId: "s", error: "failed" } as ClaudeEvent)
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "failed")
  stop()
  event({ type: "assistant", message: { id: "late" } })
  expect(hooks.dispatchStreamStart).toHaveBeenCalledTimes(4)
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  const stopEarly = installStreamHookSource()
  stopEarly()
  await Promise.resolve()
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})

it("adopts a late message identity without replaying streamed text", async () => {
  jest.clearAllMocks()
  let receive!: (event: ClaudeEvent) => void
  jest.mocked(onClaudeMessage).mockImplementation(async (handler) => {
    receive = handler
    return jest.fn()
  })
  const stop = installStreamHookSource()
  await Promise.resolve()
  const event = (inner: unknown) =>
    receive({ type: "event", sessionId: "s", event: inner } as ClaudeEvent)
  event({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
  })
  event({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi!" }] } })
  event({ type: "result" })
  const hooks = getPluginEventHooks()
  expect(hooks.dispatchStreamStart).toHaveBeenCalledTimes(1)
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(1, "s", "hi", "hi")
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(2, "s", "!", "hi!")
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledTimes(1)
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "hi!")
  stop()
})
