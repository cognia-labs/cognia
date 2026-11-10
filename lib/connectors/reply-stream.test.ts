import * as personalSinkHost from "@/lib/execution/personal-sink"
import {
  createReplyStream,
  discloseReplyStreamText,
  discloseReplyStreamSegments,
} from "./reply-stream"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import { personalDeliveryNotice } from "./personal-delivery"
jest.mock("./personal-delivery", () => ({
  ...jest.requireActual("./personal-delivery"),
  personalDeliveryNotice: jest.fn(async () => "Private content withheld"),
}))

function setup(enabled = true) {
  const checkPersonal = jest.fn(async () => ({ outcome: "allow" as const }))
  const streamReply = jest.fn(async (_req: { text: string }) => undefined)
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
    personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    adapter,
    conversationRef,
    streamKey: "turn",
    enabled,
    signal: abort.signal,
    checkPersonal,
  })
  return { streamReply, cancelStreamReply, adapter, conversationRef, abort, stream, checkPersonal }
}

it("shares capture identity, gates PII and rejects callbacks after capture settles", async () => {
  const h = setup()
  await h.stream!.onPartial("Hello")
  await h.stream!.onPartial("private@example.com")
  await h.stream!.captured()
  await h.stream!.onPartial("Hello late")
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
    personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
    adapter: h.adapter,
    conversationRef: h.conversationRef,
    conversationKey: "qq-official:qq:user",
    streamKey: "recall",
    enabled: true,
    sendOptions,
    checkPersonal: h.checkPersonal,
  })!
  sendOptions.mode = "reply"
  await stream.onPartial("Hello")
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
  await h.stream!.onPartial("Hello")
  h.abort.abort()
  await h.stream!.cancel()
  expect(h.cancelStreamReply).toHaveBeenCalledTimes(1)
  const next = setup()
  await next.stream!.onPartial("Hello")
  next.stream!.handoff()
  next.abort.abort()
  await next.stream!.cancel()
  expect(next.cancelStreamReply).not.toHaveBeenCalled()
})

it("rechecks every patch and finalizes with a fixed notice when the run becomes tainted", async () => {
  const h = setup()
  await h.stream!.onPartial("already delivered")
  h.checkPersonal.mockResolvedValueOnce({
    outcome: "withhold",
    persons: [],
    reason: "private",
  } as never)
  await h.stream!.onPartial("already delivered plus newly private content")
  await h.stream!.onPartial("later private text")
  expect(h.checkPersonal).toHaveBeenCalledTimes(2)
  expect(h.streamReply.mock.calls.map(([frame]) => frame.text)).toEqual([
    "already delivered",
    "already delivered\n\nPrivate content withheld",
  ])
  expect(personalDeliveryNotice).toHaveBeenCalledWith(false)
  expect(h.cancelStreamReply).toHaveBeenCalledTimes(1)
  expect(h.cancelStreamReply).toHaveBeenCalledWith(expect.objectContaining({ streamKey: "turn" }))
  expect(JSON.stringify(h.streamReply.mock.calls)).not.toContain("newly private")
  expect(JSON.stringify(h.streamReply.mock.calls)).not.toContain("later private")
})

it("does not create previews for held products or unsupported scenes", () => {
  const h = setup(false)
  expect(h.stream).toBeUndefined()
  expect(
    createReplyStream({
      personalContext: personalSinkHost.explicitHostPersonalSinkContext("fixed-notice"),
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

it("coalesces pending frames and freshly checks the final frame", async () => {
  const h = setup()
  let release!: () => void
  h.streamReply.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined)
      })
  )
  const first = h.stream!.onPartial("A")
  await Promise.resolve()
  await Promise.resolve()
  void h.stream!.onPartial("B")
  void h.stream!.onPartial("C")
  void h.stream!.onPartial("D")
  const final = h.stream!.captured()
  release()
  await Promise.all([first, final])
  expect(h.streamReply.mock.calls.map(([request]) => request.text)).toEqual(["A", "D"])
  expect(h.checkPersonal).toHaveBeenCalledTimes(2)
})

it("does not lose the final taint check while a completed drain is settling", async () => {
  const h = setup()
  let final: Promise<void> | undefined
  h.streamReply.mockImplementationOnce(async () => {
    queueMicrotask(() =>
      queueMicrotask(() => {
        final = h.stream!.captured()
      })
    )
    return undefined
  })
  await h.stream!.onPartial("last preview")
  await final
  expect(h.checkPersonal).toHaveBeenCalledTimes(2)
  expect(h.streamReply).toHaveBeenCalledTimes(1)
})
