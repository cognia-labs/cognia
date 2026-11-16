import { bindToolCallRun } from "@/lib/execution/acting-authority"
import { onClaudeMessage } from "@/lib/ai/agent/execution/sidecar-client"
import { getPluginEventHooks } from "./hooks-system"
import { installStreamHookSource } from "./stream-hook-source"
import type { ClaudeEvent } from "@cognia/agent-config-types"
jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({ onClaudeMessage: jest.fn() }))
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
    receive({ type: "event", sessionId: "s", event: inner } as unknown as ClaudeEvent)
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
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(1, "s", "hi", "hi", expect.any(Object))
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(2, "s", "!", "hi!", expect.any(Object))
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "hi!", expect.any(Object))
  event({
    type: "assistant",
    message: { id: "second", content: [{ type: "text", text: "snapshot" }] },
  })
  event({ type: "assistant", message: { id: "third", content: [{ type: "text", text: "next" }] } })
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "snapshot", expect.any(Object))
  receive({ type: "sidecar_exited", code: 1 } as unknown as ClaudeEvent)
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "next", expect.any(Object))
  event({
    type: "assistant",
    message: { id: "error", content: [{ type: "text", text: "failed" }] },
  })
  receive({ type: "session_ended", sessionId: "s", error: "failed" } as unknown as ClaudeEvent)
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "failed", expect.any(Object))
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
    receive({ type: "event", sessionId: "s", event: inner } as unknown as ClaudeEvent)
  event({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
  })
  event({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi!" }] } })
  event({ type: "result" })
  const hooks = getPluginEventHooks()
  expect(hooks.dispatchStreamStart).toHaveBeenCalledTimes(1)
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(1, "s", "hi", "hi", expect.any(Object))
  expect(hooks.dispatchStreamChunk).toHaveBeenNthCalledWith(2, "s", "!", "hi!", expect.any(Object))
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledTimes(1)
  expect(hooks.dispatchStreamEnd).toHaveBeenCalledWith("s", "hi!", expect.any(Object))
  stop()
})

it("R2: stream content retains its exact Host run through a later turn", async () => {
  jest.clearAllMocks()
  let receive!: (event: ClaudeEvent) => void
  jest.mocked(onClaudeMessage).mockImplementation(async (handler) => {
    receive = handler
    return jest.fn()
  })
  bindToolCallRun("exact-stream", "old", "marked-source", "a1")
  bindToolCallRun("exact-stream", "next", "clear-next", "a2")
  const stop = installStreamHookSource()
  await Promise.resolve()
  receive({
    type: "event",
    sessionId: "exact-stream",
    turnId: "old",
    attemptId: "a1",
    event: {
      type: "assistant",
      message: { id: "m", content: [{ type: "text", text: "private" }] },
    },
  } as unknown as ClaudeEvent)
  receive({
    type: "session_ended",
    sessionId: "exact-stream",
    turnId: "next",
    attemptId: "a2",
  } as unknown as ClaudeEvent)
  expect(getPluginEventHooks().dispatchStreamEnd).not.toHaveBeenCalled()
  receive({
    type: "event",
    sessionId: "exact-stream",
    turnId: "next",
    attemptId: "a2",
    event: {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "clear" } },
    },
  } as unknown as ClaudeEvent)
  expect(getPluginEventHooks().dispatchStreamEnd).toHaveBeenCalledWith("exact-stream", "private", {
    sessionId: "exact-stream",
    executionRunId: "marked-source",
  })
  expect(getPluginEventHooks().dispatchStreamChunk).toHaveBeenLastCalledWith(
    "exact-stream",
    "clear",
    "clear",
    { sessionId: "exact-stream", executionRunId: "clear-next" }
  )
  receive({
    type: "event",
    sessionId: "exact-stream",
    turnId: "unknown",
    event: {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "unknown" } },
    },
  } as unknown as ClaudeEvent)
  expect(getPluginEventHooks().dispatchStreamChunk).toHaveBeenLastCalledWith(
    "exact-stream",
    "unknown",
    "unknown",
    { sessionId: "exact-stream", executionRunId: "unresolved-tool-producer" }
  )
  stop()
})
