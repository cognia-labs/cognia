import { createDbTestFixture } from "@/lib/db/test-fixture"
import { deliverWithReceipt } from "./delivery-receipts"
import { getDb } from "@/lib/db/schema"
import type { OutboundRequest } from "@/types/connectors/outbound"
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
afterEach(() => jest.restoreAllMocks())
it.each(["missing-first", "missing-next", "changed-next"])(
  "fails an invalid successful stream ACK closed: %s",
  async (kind) => {
    const { request, quotas } = context(),
      stream = { key: "turn", index: 0, retainUntil: Date.now() + 30 * 86400_000 }
    const continuation = kind !== "missing-first"
    if (continuation)
      await deliverWithReceipt(
        "a",
        request,
        quotas,
        async () => ({ ok: true, platformMessageId: "original" }),
        { stream }
      )
    const next = continuation ? { ...stream, index: 1, previousMessageId: "original" } : stream
    const send = jest.fn(async () => ({
      ok: true,
      ...(kind === "changed-next" ? { platformMessageId: "foreign" } : {}),
    }))
    expect(await deliverWithReceipt("a", request, quotas, send, { stream: next })).toMatchObject({
      ok: false,
      error: { code: "reconciliation_required" },
    })
    const receipt = (await getDb().inboundLedger.get("a:connector-delivery:one"))!.deliveryReceipt!
    expect(receipt).toMatchObject({
      phase: "uncertain",
      quotas,
      stream: { nextIndex: continuation ? 1 : 0 },
    })
    expect(receipt.platformMessageId).toBe(continuation ? "original" : undefined)
    await deliverWithReceipt("a", request, quotas, send, { stream: next })
    expect(send).toHaveBeenCalledTimes(1)
  }
)
it("claims a stream cursor atomically across concurrent owners", async () => {
  const { request, quotas } = context(),
    stream = { key: "turn", index: 0, retainUntil: Date.now() + 30 * 86400_000 }
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => {
      enter = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  const send = jest.fn(async () => {
    enter()
    await gate
    return { ok: true, platformMessageId: "message" }
  })
  const first = deliverWithReceipt("a", request, quotas, send, { stream })
  await entered
  expect(await deliverWithReceipt("a", request, quotas, send, { stream })).toMatchObject({
    ok: false,
    error: { code: "reconciliation_required" },
  })
  release()
  expect((await first).ok).toBe(true)
  expect(send).toHaveBeenCalledTimes(1)
})
it("retains the charged message when a continuation is definitively rejected", async () => {
  const { request, quotas } = context(),
    stream = { key: "turn", index: 0, retainUntil: Date.now() + 30 * 86400_000 }
  await deliverWithReceipt(
    "a",
    request,
    quotas,
    async () => ({ ok: true, platformMessageId: "message" }),
    { stream }
  )
  await deliverWithReceipt(
    "a",
    request,
    quotas,
    async () => ({
      ok: false,
      error: { code: "platform_4xx", message: "rejected", retryable: false },
    }),
    { stream: { ...stream, index: 1, previousMessageId: "message" } }
  )
  expect(
    (await getDb().inboundLedger.get("a:connector-delivery:one"))?.deliveryReceipt
  ).toMatchObject({ phase: "sent", platformMessageId: "message", stream: { nextIndex: 1 } })
  const another = jest.fn(async () => ({ ok: true, platformMessageId: "other" }))
  expect(
    (
      await deliverWithReceipt(
        "a",
        { ...request, metadata: { idempotencyKey: "other" } },
        quotas,
        another
      )
    ).ok
  ).toBe(false)
  expect(another).not.toHaveBeenCalled()
})
it("preserves a provider-confirmed quota outcome when the accepted send returns late", async () => {
  const { request } = context()
  const send = jest.fn(async () => {
    const table = getDb().inboundLedger,
      key = "a:connector-delivery:one"
    const row = (await table.get(key))!
    await table.put({
      ...row,
      deliveryReceipt: {
        ...row.deliveryReceipt!,
        phase: "sent",
        platformMessageId: "confirmed",
        reconciled: true,
      },
    })
    return {
      ok: false,
      pendingReceipt: { id: "audit" },
      error: { code: "delivery_pending", message: "Accepted", retryable: false },
    }
  })
  await deliverWithReceipt("a", request, [], send)
  expect(
    (await getDb().inboundLedger.get("a:connector-delivery:one"))?.deliveryReceipt
  ).toMatchObject({ phase: "sent", platformMessageId: "confirmed" })
  expect(await deliverWithReceipt("a", request, [], send)).toMatchObject({
    ok: true,
    platformMessageId: "confirmed",
  })
  expect(send).toHaveBeenCalledTimes(1)
})
it("never prunes an unresolved send intent when a later send triggers retention", async () => {
  const { request } = context()
  const send = jest.fn(async () => {
    throw new Error("ambiguous")
  })
  await deliverWithReceipt("a", request, [], send)
  const realNow = Date.now()
  jest.spyOn(Date, "now").mockReturnValue(realNow + 2 * 86400_000)
  await deliverWithReceipt(
    "a",
    { ...request, metadata: { idempotencyKey: "later" } },
    [],
    async () => ({ ok: true, platformMessageId: "later" })
  )
  await deliverWithReceipt("a", request, [], send)
  expect(send).toHaveBeenCalledTimes(1)
})
it("never sends when reserving intent fails", async () => {
  const { request, quotas } = context(),
    send = jest.fn()
  jest.spyOn(getDb().inboundLedger, "put").mockRejectedValueOnce(new Error("disk unavailable"))
  expect(await deliverWithReceipt("a", request, quotas, send)).toMatchObject({
    error: { code: "temporary_unavailable" },
  })
  expect(send).not.toHaveBeenCalled()
})
it("keeps an uncertain durable intent when acknowledgement persistence fails", async () => {
  const { request, quotas } = context(),
    send = jest.fn(async () => ({ ok: true, platformMessageId: "accepted" }))
  const table = getDb().inboundLedger
  const put = table.put.bind(table)
  let calls = 0
  jest.spyOn(table, "put").mockImplementation((...args: Parameters<typeof put>) => {
    if (++calls === 2)
      return Promise.reject(new Error("disk unavailable")) as ReturnType<typeof put>
    return put(...args)
  })
  expect(await deliverWithReceipt("a", request, quotas, send)).toMatchObject({
    platformMessageId: "accepted",
    error: { code: "reconciliation_required", retryable: false },
  })
  expect(await deliverWithReceipt("a", request, quotas, send)).toMatchObject({
    error: { code: "reconciliation_required" },
  })
  expect(send).toHaveBeenCalledTimes(1)
})
function context() {
  const start = Date.now() - 1000
  const request: OutboundRequest = {
    conversationRef: { platform: "matrix", adapterId: "a", channelId: "chat" },
    segments: [{ type: "text", text: "Hello" }],
    sendOptions: { mode: "proactive" },
    metadata: { idempotencyKey: "one" },
  }
  const quotas = [{ key: "daily:chat", start, end: start + 86400_000, maximum: 1, cost: 1 }]
  return { request, quotas }
}
it("reserves one logical stream across growing frames and quota-window changes", async () => {
  const { request, quotas } = context()
  const send = jest.fn(async () => ({ ok: true, platformMessageId: "same-message" }))
  const retainUntil = Date.now() + 30 * 86400_000
  const stream = { key: "turn", index: 0, retainUntil }
  expect((await deliverWithReceipt("a", request, quotas, send, { stream })).ok).toBe(true)
  expect(
    (
      await deliverWithReceipt(
        "a",
        {
          ...request,
          segments: [{ type: "text", text: "Hello world" }],
        },
        quotas.map((q) => ({ ...q, maximum: 0 })),
        send,
        {
          stream: { ...stream, index: 1, previousMessageId: "same-message" },
        }
      )
    ).ok
  ).toBe(true)
  const receipt = (await getDb().inboundLedger.get("a:connector-delivery:one"))!.deliveryReceipt!
  expect(receipt.quotas).toEqual(quotas)
  expect(receipt.expiresAt).toBeGreaterThanOrEqual(retainUntil)
  expect(receipt.stream).toMatchObject({ key: "turn", nextIndex: 2 })
  expect(
    await deliverWithReceipt(
      "a",
      { ...request, metadata: { idempotencyKey: "another" } },
      quotas,
      send,
      { stream: { ...stream, key: "other" } }
    )
  ).toMatchObject({ ok: false, error: { code: "validation" } })
  expect(send).toHaveBeenCalledTimes(2)
})
it("rejects duplicate/stale stream indexes, changed identity and ambiguous continuation without resending", async () => {
  const { request, quotas } = context()
  const stream = { key: "turn", index: 0, retainUntil: Date.now() + 30 * 86400_000 }
  const send = jest.fn(async () => ({ ok: true, platformMessageId: "message" }))
  await deliverWithReceipt("a", request, quotas, send, { stream })
  for (const changed of [
    stream,
    { ...stream, index: 1, previousMessageId: "foreign" },
    { ...stream, key: "other", index: 1, previousMessageId: "message" },
  ])
    expect((await deliverWithReceipt("a", request, quotas, send, { stream: changed })).ok).toBe(
      false
    )
  const uncertain = jest.fn(async () => {
    throw new Error("response lost")
  })
  await deliverWithReceipt("a", request, quotas, uncertain, {
    stream: { ...stream, index: 1, previousMessageId: "message" },
  })
  await deliverWithReceipt("a", request, quotas, send, {
    stream: { ...stream, index: 1, previousMessageId: "message" },
  })
  expect(send).toHaveBeenCalledTimes(1)
  expect(uncertain).toHaveBeenCalledTimes(1)
})
it("reserves before send, deduplicates success and retains quota across calls", async () => {
  const { request, quotas } = context(),
    send = jest.fn(async () => ({ ok: true, platformMessageId: "message" }))
  expect(await deliverWithReceipt("a", request, quotas, send)).toMatchObject({ ok: true })
  expect(await deliverWithReceipt("a", request, quotas, send)).toMatchObject({
    ok: true,
    platformMessageId: "message",
  })
  expect(
    await deliverWithReceipt("a", { ...request, metadata: { idempotencyKey: "two" } }, quotas, send)
  ).toMatchObject({ ok: false, error: { code: "validation" } })
  expect(send).toHaveBeenCalledTimes(1)
})
it("checks the original quota window again at the actual provider boundary", async () => {
  const { request, quotas } = context()
  const at = Date.now(),
    now = jest.spyOn(Date, "now").mockReturnValue(at)
  let effects = 0
  try {
    const result = await deliverWithReceipt("a", request, quotas, async (assertActive) => {
      now.mockReturnValue(at + 2 * 86400_000)
      await assertActive()
      effects++
      return { ok: true, platformMessageId: "never" }
    })
    expect(result).toMatchObject({ ok: false, error: { code: "validation", retryable: false } })
    expect(effects).toBe(0)
    expect(
      (await getDb().inboundLedger.get("a:connector-delivery:one"))?.deliveryReceipt?.phase
    ).toBe("rejected")
  } finally {
    now.mockRestore()
  }
})
it("fails an unknown acknowledgement closed, including after a subsequent invocation", async () => {
  const { request, quotas } = context(),
    send = jest.fn(async () => {
      throw new Error("lost response")
    })
  expect(await deliverWithReceipt("a", request, quotas, send)).toMatchObject({
    error: { code: "reconciliation_required", retryable: false },
  })
  await deliverWithReceipt("a", request, quotas, send)
  expect(send).toHaveBeenCalledTimes(1)
})
it("allows a known no-delivery retry but refuses changing the reserved body", async () => {
  const { request, quotas } = context(),
    send = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: "rate_limited", retryable: true } })
      .mockResolvedValue({ ok: true, platformMessageId: "message" })
  await deliverWithReceipt("a", request, quotas, send)
  expect((await deliverWithReceipt("a", request, quotas, send)).ok).toBe(true)
  expect(
    await deliverWithReceipt(
      "a",
      { ...request, segments: [{ type: "text", text: "Changed" }] },
      quotas,
      send
    )
  ).toMatchObject({ ok: false, error: { code: "validation" } })
  expect(send).toHaveBeenCalledTimes(2)
})
