import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import Dexie from "dexie"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createQQStreamManager, QQ_STREAM_WINDOW_MS } from "./stream"
import { __resetQQMsgSeqForTesting, qqPassiveReplyCount, registerQQPassiveReply } from "./serialize"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  __resetQQMsgSeqForTesting()
})
afterAll(fixture.dispose)
it("isolates interleaved recipients that reuse a logical stream key", async () => {
  const h = harness()
  h.request.mockImplementation(async (path) => ({
    status: 200,
    body: { id: path.includes("user-a") ? "server-a" : "server-b", remaining: 1000 },
  }))
  const refs = [
    { ...h.ref, sceneId: "user-a", msgId: "source-a" },
    { ...h.ref, sceneId: "user-b", msgId: "source-b" },
  ]
  await Promise.all(
    refs.map((conversationRef, index) =>
      h.manager.preview({ conversationRef, streamKey: "turn", text: `Reply ${index}` })
    )
  )
  const results = await Promise.all(
    refs.map((conversationRef, index) =>
      h.manager.finish(
        {
          ...h.final(`Reply ${index} complete`),
          conversationRef,
          metadata: { streamKey: "turn", idempotencyKey: `final-${index}` },
        },
        h.normal
      )
    )
  )
  expect(results).toMatchObject([
    { ok: true, platformMessageId: "c2c:user-a:server-a" },
    { ok: true, platformMessageId: "c2c:user-b:server-b" },
  ])
  refs.forEach((ref, index) => {
    const frames = h.request.mock.calls
      .filter(([path]) => path.includes(ref.sceneId))
      .map(([, payload]) => payload)
    expect(frames).toHaveLength(2)
    expect(frames.map((frame) => [frame.index, frame.input_state])).toEqual([
      [0, 1],
      [1, 10],
    ])
    expect(frames[1]).toMatchObject({
      stream_msg_id: index === 0 ? "server-a" : "server-b",
      content_raw: `Reply ${index} complete`,
    })
    expect(qqPassiveReplyCount(ref.msgId)).toBe(1)
  })
  expect(h.normal).not.toHaveBeenCalled()
})

it("does not fork the first frame across two managers", async () => {
  const h = harness(),
    sendOptions = { mode: "reengagement" as const }
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => {
      enter = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  h.request.mockImplementationOnce(async () => {
    enter()
    await gate
    return { status: 200, body: { id: "server-stream", remaining: 1000 } }
  })
  const request = { conversationRef: h.ref, streamKey: "turn", sendOptions, text: "Hello" }
  const first = h.manager.preview(request)
  await entered
  await expect(createQQStreamManager(h.options).preview(request)).rejects.toThrow(/uncertain/)
  release()
  await first
  expect((await h.manager.finish({ ...h.final(), sendOptions }, h.normal)).ok).toBe(true)
  expect(h.request.mock.calls.map(([, body]) => body.index)).toEqual([0, 1])
})
it("does not overwrite cancellation between finalization and an ordinary fallback claim", async () => {
  const h = harness(),
    db = getDb(),
    sendOptions = { mode: "reengagement" as const }
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => {
      enter = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  const original = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>
  let count = 0
  const spy = jest.spyOn(db, "transaction").mockImplementation(((...args: unknown[]) => {
    const work = original(...args)
    return ++count === 2
      ? work.then(async (value) => {
          enter()
          await gate
          return value
        })
      : work
  }) as typeof db.transaction)
  try {
    const final: OutboundRequest = {
      ...h.final(),
      sendOptions,
      segments: [...h.final().segments, { type: "image", url: "https://example.org/photo.png" }],
    }
    const finishing = h.manager.finish(final, h.normal)
    await entered
    await createQQStreamManager(h.options).cancel({
      conversationRef: h.ref,
      streamKey: "turn",
      sendOptions,
    })
    release()
    expect(await finishing).toMatchObject({ ok: false, error: { code: "reconciliation_required" } })
    expect(h.normal).not.toHaveBeenCalled()
    expect(h.request).not.toHaveBeenCalled()
    expect(
      (await db.inboundLedger.where("namespace").equals("qq-stream").first())?.qqStream?.phase
    ).toBe("cancelled")
  } finally {
    release()
    spy.mockRestore()
  }
})

function harness() {
  const clock = { value: Date.now() }
  const ref = {
    platform: "qq-official" as const,
    adapterId: "qq",
    scene: "c2c",
    sceneId: "user",
    msgId: "source",
    receivedAt: clock.value,
  }
  const request = jest.fn(async (_path: string, _payload: Record<string, unknown>) => ({
    status: 200,
    body: { id: "server-stream", remaining: 1000 },
  }))
  const confirmed = jest.fn(async () => undefined)
  const options = {
    adapterId: "qq",
    request,
    confirmed,
    now: () => clock.value,
    wait: jest.fn(async (ms: number) => {
      clock.value += ms
    }),
  }
  const manager = createQQStreamManager(options)
  const final = (text = "Hello world"): OutboundRequest => ({
    conversationRef: ref,
    segments: [{ type: "markdown", md: text }],
    metadata: { idempotencyKey: "final", streamKey: "turn" },
  })
  const normal = jest.fn(async (_req: OutboundRequest) => ({
    ok: true,
    platformMessageId: "c2c:user:ordinary",
  }))
  return { manager, options, clock, ref, request, confirmed, final, normal }
}

it("streams an explicitly aged C2C recall with one ID, native final and no passive slots", async () => {
  const h = harness()
  h.ref.receivedAt -= 2 * 86400_000
  const sendOptions = { mode: "reengagement" as const }
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello", sendOptions })
  h.manager.stop()
  expect(
    await createQQStreamManager(h.options).finish({ ...h.final(), sendOptions }, h.normal)
  ).toMatchObject({ ok: true, platformMessageId: "c2c:user:server-stream" })
  const frames = h.request.mock.calls.map(([, body]) => body)
  expect(frames.map((f) => [f.index, f.input_state, f.is_wakeup])).toEqual([
    [0, 1, true],
    [1, 10, true],
  ])
  expect(frames[1].stream_msg_id).toBe("server-stream")
  expect(qqPassiveReplyCount("source")).toBe(0)
  expect(h.normal).not.toHaveBeenCalled()
})

it("uses native recall finalization without a preview and pins its mode across replay", async () => {
  const h = harness()
  h.ref.receivedAt -= 2 * 86400_000
  const final = { ...h.final(), sendOptions: { mode: "reengagement" as const } }
  expect((await h.manager.finish(final, h.normal)).ok).toBe(true)
  expect(h.request.mock.calls[0]?.[1]).toMatchObject({ input_state: 10, index: 0, is_wakeup: true })
  expect(await createQQStreamManager(h.options).finish(h.final(), h.normal)).toMatchObject({
    ok: false,
  })
  expect(h.request).toHaveBeenCalledTimes(1)
  expect(h.normal).not.toHaveBeenCalled()
})

it("does not send a second recall when a final rewrites the accepted prefix", async () => {
  const h = harness(),
    sendOptions = { mode: "reengagement" as const }
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello", sendOptions })
  expect(await h.manager.finish({ ...h.final("Different"), sendOptions }, h.normal)).toMatchObject({
    ok: false,
    error: { code: "reconciliation_required", retryable: false },
  })
  expect(h.normal).not.toHaveBeenCalled()
  expect(h.request.mock.calls.filter(([, body]) => body.index === 0)).toHaveLength(1)
})

it("keeps one server ID, increasing indexes and one passive slot through durable completion", async () => {
  const h = harness()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello w" })
  expect(await h.manager.finish(h.final(), h.normal)).toMatchObject({
    ok: true,
    platformMessageId: "c2c:user:server-stream",
  })
  const frames = h.request.mock.calls.map(([, body]) => body)
  expect(frames.map((frame) => [frame.index, frame.input_state])).toEqual([
    [0, 1],
    [1, 1],
    [2, 10],
  ])
  expect(new Set(frames.map((frame) => frame.msg_seq)).size).toBe(1)
  expect(frames[0]).not.toHaveProperty("stream_msg_id")
  expect(frames[2]).toMatchObject({
    stream_msg_id: "server-stream",
    input_mode: "replace",
    content_raw: "Hello world",
  })
  expect(frames.every((frame) => !Object.hasOwn(frame, "is_wakeup"))).toBe(true)
  expect(qqPassiveReplyCount("source")).toBe(1)
  expect(h.normal).not.toHaveBeenCalled()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello world late" })
  expect(h.request).toHaveBeenCalledTimes(3)
})

it("coalesces concurrent partial snapshots and never emits stale pending content after DONE", async () => {
  const h = harness()
  await Promise.all(
    ["H", "He", "Hello"].map((text) =>
      h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text })
    )
  )
  expect(h.request).toHaveBeenCalledTimes(1)
  expect(h.request.mock.calls[0]![1].content_raw).toBe("Hello")
  await h.manager.finish(h.final(), h.normal)
  expect(h.request.mock.calls.at(-1)![1].input_state).toBe(10)
})

it("restores acknowledged streams and deduplicates a completed final after manager restart", async () => {
  const h = harness()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  h.manager.stop()
  const restored = createQQStreamManager(h.options)
  expect((await restored.finish(h.final(), h.normal)).ok).toBe(true)
  const again = createQQStreamManager(h.options)
  expect((await again.finish(h.final(), h.normal)).ok).toBe(true)
  expect(h.request).toHaveBeenCalledTimes(2)
  expect(h.normal).not.toHaveBeenCalled()
})

it("fails ambiguous first-frame recovery closed without starting another message", async () => {
  const h = harness()
  h.request.mockRejectedValueOnce(new Error("lost response"))
  await expect(
    h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  ).rejects.toThrow(/uncertain/)
  const restored = createQQStreamManager(h.options)
  expect(await restored.finish(h.final(), h.normal)).toMatchObject({
    ok: false,
    error: { code: "reconciliation_required", retryable: false },
  })
  expect(h.request).toHaveBeenCalledTimes(1)
  expect(h.normal).not.toHaveBeenCalled()
})

it("refuses missing acknowledgements and retains an intent if checkpoint commit fails after HTTP success", async () => {
  const h = harness()
  const actual = getDb().inboundLedger.put.bind(getDb().inboundLedger)
  const put = jest.spyOn(getDb().inboundLedger, "put")
  let writes = 0
  put.mockImplementation((...args) => {
    if (++writes === 3) return Dexie.Promise.reject(new Error("checkpoint commit failed"))
    return actual(...args)
  })
  try {
    await expect(
      h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
    ).rejects.toThrow(/uncertain/)
  } finally {
    put.mockRestore()
  }
  expect(await createQQStreamManager(h.options).finish(h.final(), h.normal)).toMatchObject({
    ok: false,
    error: { code: "reconciliation_required" },
  })
  expect(h.normal).not.toHaveBeenCalled()
})

it("closes known safe content on cancellation and ignores later snapshots", async () => {
  const h = harness()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  await h.manager.cancel({ conversationRef: h.ref, streamKey: "turn" })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello late" })
  expect(h.request.mock.calls.map(([, body]) => [body.input_state, body.content_raw])).toEqual([
    [1, "Hello"],
    [10, "Hello"],
  ])
  expect(await h.manager.finish(h.final(), h.normal)).toMatchObject({
    ok: false,
    error: { code: "validation" },
  })
})

it("keeps cancellation terminal even if the platform rejects the closing frame", async () => {
  const h = harness()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  h.request.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
  await expect(h.manager.cancel({ conversationRef: h.ref, streamKey: "turn" })).rejects.toThrow(
    "rate limited"
  )
  const restored = createQQStreamManager(h.options)
  await restored.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello late" })
  expect(await restored.finish(h.final(), h.normal)).toMatchObject({
    ok: false,
    error: { code: "validation" },
  })
  expect(h.normal).not.toHaveBeenCalled()
  expect(h.request).toHaveBeenCalledTimes(2)
})

it("keeps rewrites and mixed final content complete through a reported final-only alternative", async () => {
  const h = harness()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Different" })
  const final = h.final("Different final")
  final.segments.push({ type: "image", url: "https://cdn.example.org/a.png" })
  expect(await h.manager.finish(final, h.normal)).toMatchObject({
    ok: true,
    downgrades: [expect.objectContaining({ reason: "qq_stream_final_only_alternative" })],
  })
  expect(h.normal).toHaveBeenCalledWith(final)
  expect(h.request.mock.calls.at(-1)![1]).toMatchObject({ input_state: 10, content_raw: "Hello" })
})

it("checks cumulative PII at the sink, scope, expiry and aggregate budget before sending", async () => {
  const h = harness()
  await expect(
    h.manager.preview({
      conversationRef: h.ref,
      streamKey: "turn",
      text: "Contact private@example.com",
    })
  ).rejects.toThrow(/PII/)
  await expect(
    h.manager.preview({
      conversationRef: { ...h.ref, adapterId: "other" },
      streamKey: "turn",
      text: "Hello",
    })
  ).rejects.toThrow(/context/)
  h.clock.value += QQ_STREAM_WINDOW_MS + 1
  await expect(
    h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  ).rejects.toThrow(/expired/)
  expect(h.request).not.toHaveBeenCalled()
  h.clock.value = h.ref.receivedAt
  for (let i = 0; i < 4; i++) registerQQPassiveReply("source", `used:${i}`)
  await expect(
    h.manager.preview({ conversationRef: h.ref, streamKey: "another", text: "Hello" })
  ).rejects.toThrow(/limit/)
  expect(h.request).not.toHaveBeenCalled()
})

it("never retries an ordinary fallback whose delivery acknowledgement was lost", async () => {
  const h = harness()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  const final = h.final("Rewritten final")
  const normal = jest.fn(async () => ({
    ok: false,
    error: { code: "platform_5xx" as const, retryable: true, message: "lost acknowledgement" },
  }))
  expect(await h.manager.finish(final, normal)).toMatchObject({
    ok: false,
    error: { code: "reconciliation_required", retryable: false },
  })
  expect(await createQQStreamManager(h.options).finish(final, normal)).toMatchObject({
    ok: false,
    error: { code: "reconciliation_required" },
  })
  expect(normal).toHaveBeenCalledTimes(1)
})

it("does not consume a passive slot when durable intent storage fails before HTTP", async () => {
  const h = harness()
  const put = jest
    .spyOn(getDb().inboundLedger, "put")
    .mockRejectedValueOnce(new Error("disk unavailable"))
  try {
    await expect(
      h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
    ).rejects.toThrow("disk unavailable")
  } finally {
    put.mockRestore()
  }
  expect(h.request).not.toHaveBeenCalled()
  expect(qqPassiveReplyCount("source")).toBe(0)
})

it("blocks late partials after a final-only turn and releases completed in-memory entries", async () => {
  const h = harness()
  for (let i = 0; i < 130; i++) {
    const req = h.final()
    req.conversationRef = { ...h.ref, msgId: `source-${i}` }
    req.metadata = { streamKey: `turn-${i}`, idempotencyKey: `final-${i}` }
    expect((await h.manager.finish(req, h.normal)).ok).toBe(true)
  }
  await h.manager.preview({
    conversationRef: { ...h.ref, msgId: "source-0" },
    streamKey: "turn-0",
    text: "Late",
  })
  expect(h.request).not.toHaveBeenCalled()
  expect(h.normal).toHaveBeenCalledTimes(130)
})

it.each([202, 200])(
  "treats missing/async stream acknowledgement (%s) as uncertain",
  async (status) => {
    const h = harness()
    h.request.mockResolvedValueOnce({
      status,
      body: { id: status === 202 ? "async" : "", remaining: 0 },
    })
    await expect(
      h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
    ).rejects.toThrow(/uncertain/)
    expect(await h.manager.finish(h.final(), h.normal)).toMatchObject({
      error: { code: "reconciliation_required" },
    })
    expect(h.normal).not.toHaveBeenCalled()
  }
)

it("repairs final delivery evidence on retry without repeating the provider POST", async () => {
  const h = harness()
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  h.confirmed.mockRejectedValueOnce(new Error("receipt storage failed"))
  expect(await h.manager.finish(h.final(), h.normal)).toMatchObject({
    ok: false,
    platformMessageId: "c2c:user:server-stream",
    error: { retryable: true },
  })
  expect(await createQQStreamManager(h.options).finish(h.final(), h.normal)).toMatchObject({
    ok: true,
    platformMessageId: "c2c:user:server-stream",
  })
  expect(h.request).toHaveBeenCalledTimes(2)
  expect(h.confirmed).toHaveBeenCalledTimes(3)
})

it("rejects a changed attachment or quote when replaying a completed final", async () => {
  const h = harness()
  const req = h.final()
  req.segments.push({ type: "image", url: "https://cdn.example.org/one.png" })
  expect((await h.manager.finish(req, h.normal)).ok).toBe(true)
  const changed = {
    ...req,
    segments: [
      ...req.segments.slice(0, -1),
      { type: "image" as const, url: "https://cdn.example.org/two.png" },
    ],
  }
  expect(await createQQStreamManager(h.options).finish(changed, h.normal)).toMatchObject({
    ok: false,
    error: { code: "validation" },
  })
  expect(
    await createQQStreamManager(h.options).finish(
      { ...req, replyTo: { messageId: "other" } },
      h.normal
    )
  ).toMatchObject({ ok: false, error: { code: "validation" } })
  expect(h.normal).toHaveBeenCalledTimes(1)
})

it("paces snapshots at 500ms per stream and at least 25ms across streams", async () => {
  const h = harness()
  const times: number[] = []
  h.request.mockImplementation(async () => {
    times.push(h.clock.value)
    return { status: 200, body: { id: "server-stream", remaining: 1000 } }
  })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello world" })
  await h.manager.preview({
    conversationRef: { ...h.ref, sceneId: "other" },
    streamKey: "other",
    text: "Another",
  })
  expect(times[1] - times[0]).toBe(500)
  expect(times[2] - times[1]).toBe(25)
})

it("serializes pending HTTP calls and uses the acknowledged ID when cancellation follows an in-flight frame", async () => {
  const h = harness()
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  h.request.mockImplementationOnce(async () => {
    started()
    await pending
    return { status: 200, body: { id: "server-stream", remaining: 1000 } }
  })
  const preview = h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  await began
  const cancel = h.manager.cancel({ conversationRef: h.ref, streamKey: "turn" })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello late" })
  expect(h.request).toHaveBeenCalledTimes(1)
  release()
  await Promise.all([preview, cancel])
  expect(h.request).toHaveBeenCalledTimes(2)
  expect(h.request.mock.calls[1][1]).toMatchObject({
    input_state: 10,
    index: 1,
    stream_msg_id: "server-stream",
    content_raw: "Hello",
  })
})

it.each([0, 1])(
  "keeps a Markdown stream on one message after reported length %s",
  async (remaining) => {
    const h = harness()
    h.request.mockResolvedValue({ status: 200, body: { id: "server-stream", remaining } })
    const prefix = "## 出行清单\n\n**一、证件与财务"
    await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: prefix })
    await h.manager.preview({
      conversationRef: h.ref,
      streamKey: "turn",
      text: `${prefix}**\n\n准备证件。`,
    })
    const body = `${prefix}**\n\n准备证件。\n\n1. 护照\n2. 手机\n\nM1-END`
    expect(await h.manager.finish(h.final(body), h.normal)).toMatchObject({
      ok: true,
      platformMessageId: "c2c:user:server-stream",
    })
    expect(h.normal).not.toHaveBeenCalled()
    expect(h.request.mock.calls.map(([, frame]) => frame.index)).toEqual([0, 1, 2])
    expect(h.request.mock.calls.map(([, frame]) => frame.input_state)).toEqual([1, 1, 10])
    expect(h.request.mock.calls[2][1]).toMatchObject({
      stream_msg_id: "server-stream",
      content_raw: body,
    })
    expect(qqPassiveReplyCount("source")).toBe(1)
  }
)

it("keeps Unicode snapshots and finalization native when reported lengths reach zero", async () => {
  const h = harness()
  h.request
    .mockResolvedValueOnce({ status: 200, body: { id: "server-stream", remaining: 1 } })
    .mockResolvedValueOnce({ status: 200, body: { id: "server-stream", remaining: 0 } })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello" })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello😀" })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "Hello😀x" })
  expect(h.request).toHaveBeenCalledTimes(3)
  const req = h.final("Hello😀x")
  expect(await h.manager.finish(req, h.normal)).toMatchObject({
    ok: true,
    platformMessageId: "c2c:user:server-stream",
  })
  expect(h.normal).not.toHaveBeenCalled()
  expect(h.request.mock.calls[3][1]).toMatchObject({
    input_state: 10,
    stream_msg_id: "server-stream",
    content_raw: "Hello😀x",
  })
})

it("enforces the local UTF-8 snapshot bound independently of reported lengths", async () => {
  const h = harness()
  h.request.mockResolvedValue({ status: 200, body: { id: "server-stream", remaining: 0 } })
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: "X" })
  const accepted = `X${"😀".repeat(12_287)}`
  await h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: accepted })
  await expect(
    h.manager.preview({ conversationRef: h.ref, streamKey: "turn", text: `${accepted}😀` })
  ).rejects.toThrow(/bounded text limit/)
  expect(h.request).toHaveBeenCalledTimes(2)
  expect(await h.manager.finish(h.final(accepted), h.normal)).toMatchObject({
    ok: true,
    platformMessageId: "c2c:user:server-stream",
  })
  expect(h.normal).not.toHaveBeenCalled()
})
