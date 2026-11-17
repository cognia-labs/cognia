/** @jest-environment jsdom */
import type { ClaudeEvent } from "@cognia/agent-config-types"

import { enqueueAgentChatEvent, type AgentChatEventQueueContext } from "./agent-chat-event-queue"

const order: string[] = []
const handleEvent = jest.fn(async (evt: { type: string; sessionId?: string; tag?: string }) => {
  order.push(`start:${evt.tag}`)
  await Promise.resolve()
  order.push(`end:${evt.tag}`)
})
jest.mock("./agent-chat-events", () => ({
  handleEvent: (evt: { type: string; tag?: string }) => handleEvent(evt),
}))
let captured = false
jest.mock("@/lib/ai/agent/execution/hitl/approval-registry", () => ({
  hasCaptureResponder: () => captured,
}))

function context(): AgentChatEventQueueContext {
  return {
    activeRef: { current: null },
    messagesMirrorRef: { current: new Map() },
    allowListRef: { current: [] },
    asideContextDispatchRef: { current: new Map() },
    pendingBranchTagRef: { current: new Map() },
    pendingBranchOwnerRef: { current: new Map() },
    sendRef: { current: null },
    continueFromLeaseRef: { current: null },
    eventQueuesRef: { current: new Map() },
    getExecutionHandle: () => undefined,
    registry: {} as never,
    transcriptFenceRef: { current: null },
    silenceWatchdogRef: { current: { notice: jest.fn() } as never },
  }
}

const event = (tag: string, sessionId?: string) =>
  ({ type: "assistant", sessionId, tag }) as unknown as ClaudeEvent

beforeEach(() => {
  order.length = 0
  captured = false
  jest.clearAllMocks()
})

it("runs one session's events in order and drops the queue once drained", async () => {
  const ctx = context()
  void enqueueAgentChatEvent(ctx, event("a", "s1"))
  const last = enqueueAgentChatEvent(ctx, event("b", "s1"))
  expect(ctx.eventQueuesRef.current.has("s1")).toBe(true)

  await last
  await Promise.resolve()
  expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"])
  expect(ctx.eventQueuesRef.current.has("s1")).toBe(false)
  expect(ctx.silenceWatchdogRef.current?.notice).toHaveBeenCalledWith("s1")
})

it("keeps the chain going after a failing handler", async () => {
  const ctx = context()
  handleEvent.mockRejectedValueOnce(new Error("boom"))
  const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
  void enqueueAgentChatEvent(ctx, event("bad", "s1"))
  await enqueueAgentChatEvent(ctx, event("good", "s1"))
  expect(order).toContain("end:good")
  error.mockRestore()
})

it("leaves events a capture responder owns to it", async () => {
  captured = true
  const ctx = context()
  await enqueueAgentChatEvent(ctx, event("x", "s1"))
  expect(handleEvent).not.toHaveBeenCalled()
})

it("acknowledges the SDK session id to a pending aside dispatch", async () => {
  const ctx = context()
  const acknowledgeSdk = jest.fn(async () => undefined)
  ctx.asideContextDispatchRef.current.set("s1", { acknowledgeSdk } as never)
  await enqueueAgentChatEvent(ctx, {
    type: "sdk_session_id",
    sessionId: "s1",
    sdkSessionId: "sdk-1",
    turnId: "t1",
  } as unknown as ClaudeEvent)
  expect(acknowledgeSdk).toHaveBeenCalledWith("sdk-1", "t1")
})

it("queues session-less frames on one shared chain without feeding the watchdog", async () => {
  const ctx = context()
  await enqueueAgentChatEvent(ctx, event("ready"))
  expect(handleEvent).toHaveBeenCalled()
  expect(ctx.silenceWatchdogRef.current?.notice).not.toHaveBeenCalled()
})
