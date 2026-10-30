import { publishChatLifecycleEvent, subscribeChatLifecycleEvents } from "./lifecycle-events"

it("isolates subscribers and stops delivery after unsubscribe", () => {
  const first = subscribeChatLifecycleEvents((event) => {
    if ("sessionId" in event) event.sessionId = "changed"
    throw new Error("observer failed")
  })
  const received = jest.fn()
  const stop = subscribeChatLifecycleEvents(received)
  const event = { type: "session-created" as const, sessionId: "session" }
  expect(() => publishChatLifecycleEvent(event)).not.toThrow()
  expect(received).toHaveBeenCalledWith(event)
  stop()
  publishChatLifecycleEvent(event)
  expect(received).toHaveBeenCalledTimes(1)
  first()
})
