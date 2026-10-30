import {
  createReplyStream,
  discloseReplyStreamText,
  discloseReplyStreamSegments,
} from "./reply-stream"
import type { PlatformAdapter } from "@/types/connectors/adapter"

function setup(enabled = true) {
  const streamReply = jest.fn(async () => undefined)
  const cancelStreamReply = jest.fn(async () => undefined)
  const adapter = {
    meta: { type: "qq-official" },
    streamReply,
    cancelStreamReply,
  } as unknown as PlatformAdapter
  const conversationRef = {
    platform: "qq-official" as const,
    adapterId: "qq",
    scene: "c2c",
    sceneId: "user",
    msgId: "source",
    receivedAt: 1,
  }
  const abort = new AbortController()
  const stream = createReplyStream({
    adapter,
    conversationRef,
    streamKey: "turn",
    enabled,
    signal: abort.signal,
  })
  return { streamReply, cancelStreamReply, adapter, conversationRef, abort, stream }
}

it("shares capture identity, gates PII and rejects callbacks after capture settles", () => {
  const h = setup()
  h.stream!.onPartial("Hello")
  h.stream!.onPartial("private@example.com")
  h.stream!.captured()
  h.stream!.onPartial("Hello late")
  expect(h.streamReply).toHaveBeenCalledTimes(1)
  expect(h.streamReply).toHaveBeenCalledWith({
    conversationRef: h.conversationRef,
    streamKey: "turn",
    text: "Hello",
  })
})
it("snapshots common delivery intent for partials and cancellation", async () => {
  const h = setup()
  const sendOptions = { mode: "reengagement" as "reengagement" | "reply" }
  const stream = createReplyStream({
    adapter: h.adapter,
    conversationRef: h.conversationRef,
    conversationKey: "qq-official:qq:user",
    streamKey: "recall",
    enabled: true,
    sendOptions,
  })!
  sendOptions.mode = "reply"
  stream.onPartial("Hello")
  await stream.cancel()
  expect(h.streamReply).toHaveBeenCalledWith(
    expect.objectContaining({
      sendOptions: { mode: "reengagement" },
      conversationKey: "qq-official:qq:user",
    })
  )
  expect(h.cancelStreamReply).toHaveBeenCalledWith(
    expect.objectContaining({ sendOptions: { mode: "reengagement" } })
  )
})

it("cancels once on abort and preserves a handed-off final", async () => {
  const h = setup()
  h.stream!.onPartial("Hello")
  h.abort.abort()
  await h.stream!.cancel()
  expect(h.cancelStreamReply).toHaveBeenCalledTimes(1)
  const next = setup()
  next.stream!.onPartial("Hello")
  next.stream!.handoff()
  next.abort.abort()
  await next.stream!.cancel()
  expect(next.cancelStreamReply).not.toHaveBeenCalled()
})

it("does not create previews for held products or unsupported scenes", () => {
  const h = setup(false)
  expect(h.stream).toBeUndefined()
  expect(
    createReplyStream({
      adapter: h.adapter,
      conversationRef: { ...h.conversationRef, scene: "group" },
      streamKey: "turn",
      enabled: true,
    })
  ).toBeUndefined()
  expect(h.streamReply).not.toHaveBeenCalled()
})

it("keeps twin disclosure visible without changing the delivered prefix as text grows", () => {
  const partial = discloseReplyStreamText("Hello", "twin")
  const next = discloseReplyStreamText("Hello world", "twin")
  expect(next.startsWith(partial)).toBe(true)
  expect(discloseReplyStreamSegments([{ type: "markdown", md: "Hello world" }], "twin")).toEqual({
    segments: [{ type: "markdown", md: next }],
    provenance: [expect.objectContaining({ source: "digital-twin", sourceId: "twin" })],
  })
  expect(discloseReplyStreamText("Hello")).toBe("Hello")
})
