jest.mock("@/lib/audio/transcode", () => ({
  ...jest.requireActual("@/lib/audio/transcode"),
  transcodeAudio: jest.fn(),
}))
import { invoke } from "@tauri-apps/api/core"
import Dexie from "dexie"
import { listen } from "@tauri-apps/api/event"
import type { AdapterContext } from "@/types/connectors/adapter"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { createQQOfficialAdapter } from "./index"
import { __resetQQMsgSeqForTesting, qqPassiveMsgSeq, qqPassiveReplyCount } from "./serialize"
import { startQQGateway } from "./gateway-client"
import { gateInboundEvent } from "@/lib/connectors/at-gate"
import { findQQReference, recordQQReference } from "./references"
import { wasDeliveredByUs } from "@/lib/connectors/delivered-messages"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { ensureConnectorInboundJob } from "@/lib/db/connector-inbound-jobs"
import { getBus, __resetBusForTesting } from "@/lib/connectors/bus"
import { getDb } from "@/lib/db/schema"
import { recordCallbackBinding } from "../_shared/a2ui-mapper"
import { parseQQDispatch } from "./parse"
import {
  inboundEventFromStoredMessage,
  inboundEventToStoredParts,
} from "@/lib/connectors/inbound-stored-parts"
import { inboundReplyLookupIds, resolveInboundReplyTo } from "@/lib/connectors/inbound-reply-to"
import { evaluatePolicy } from "@/lib/connectors/policy-eval"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { captureSystemDeliveryContext } from "@/lib/connectors/event-context"
import { rememberConnectorAssets } from "@/lib/connectors/assets"
import { resolveQQInteraction } from "./interactions"
import { buildHelpSurface } from "@/lib/connectors/help/build-help-surface"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"

const quoteDbFixture = createDbTestFixture()
beforeAll(quoteDbFixture.initialize)
beforeEach(quoteDbFixture.restore)
afterAll(quoteDbFixture.dispose)

jest.mock("./gateway-client", () => ({
  ...jest.requireActual("./gateway-client"),
  startQQGateway: jest.fn(),
}))

// The at-gate reads adapter rows from Dexie; the adapter tests only care that
// the dispatch pipeline runs, so let every event through.
jest.mock("@/lib/connectors/at-gate", () => ({
  ...jest.requireActual("@/lib/connectors/at-gate"),
  gateInboundEvent: jest.fn(async () => true),
}))

const mockInvoke = invoke as jest.Mock
const mockStartGateway = startQQGateway as jest.Mock

function httpResp(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function adapter(extra: Partial<Parameters<typeof createQQOfficialAdapter>[0]> = {}) {
  return createQQOfficialAdapter({
    id: "qq-1",
    displayName: "QQ Bot",
    accessToken: async () => "tok",
    ...extra,
  })
}

/** All `connectors_http_request` invocations as `{ method, url, body }`. */
function httpCalls(): Array<{ method: string; url: string; body?: string }> {
  return mockInvoke.mock.calls
    .filter(([cmd]: [string]) => cmd === "connectors_http_request")
    .map((c) => (c[1] as { req: { method: string; url: string; body?: string } }).req)
}

/**
 * Start the adapter on a fake gateway that yields ONE dispatch and then hangs,
 * so `handleDispatch` populates the per-conversation last-inbound cache.
 */
async function startWithDispatch(a: ReturnType<typeof adapter>, dispatch: unknown) {
  let delivered = false
  mockStartGateway.mockReturnValue({
    selfId: "bot",
    dispatches: fakeDispatches(() => {
      if (!delivered) {
        delivered = true
        return Promise.resolve({ done: false, value: dispatch })
      }
      return new Promise(() => {})
    }),
  })
  await a.start(fakeCtx())
  await new Promise((r) => setTimeout(r, 0))
}

const C2C_DISPATCH = {
  op: 0,
  t: "C2C_MESSAGE_CREATE",
  d: { id: "in-1", content: "hi", author: { user_openid: "UO" } },
}

function sendReq(extra: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    conversationRef: {
      platform: "qq-official",
      adapterId: "qq-1",
      scene: "group",
      sceneId: "GO",
      msgId: "m1",
    },
    segments: [{ type: "text", text: "hello" }],
    metadata: { idempotencyKey: "k" },
    ...extra,
  }
}

function fakeCtx(): AdapterContext {
  return { emit: jest.fn() } as unknown as AdapterContext
}

/** Hand-rolled async iterable so tests control exactly how the stream ends. */
function fakeDispatches(next: () => Promise<IteratorResult<unknown>>) {
  const it = {
    [Symbol.asyncIterator]: () => it,
    next,
  }
  return it
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockStartGateway.mockReset()
  jest.mocked(gateInboundEvent).mockReset().mockResolvedValue(true)
  __resetQQMsgSeqForTesting()
  __resetBusForTesting()
})

describe("createQQOfficialAdapter", () => {
  it("reports gateway starting until authenticated and stops reporting running on disconnect", async () => {
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => new Promise(() => {})),
    })
    const a = adapter()
    await a.start(fakeCtx())
    try {
      expect(a.health().state).toBe("starting")
      const options = mockStartGateway.mock.calls[0][0]
      options.onHealth?.({ state: "running" })
      expect(a.health().state).toBe("running")
      options.onHealth?.({ state: "degraded", reason: "QQ gateway closed (code 4009)" })
      expect(a.health()).toMatchObject({
        state: "degraded",
        reason: "QQ gateway closed (code 4009)",
      })
      await a.stop()
      options.onHealth?.({ state: "running" })
      expect(a.health().state).toBe("down")
    } finally {
      await a.stop()
    }
  })

  describe("native C2C recall delivery", () => {
    it.each(["receipt", "checkpoint"])(
      "does not resend after a successful frame whose %s ACK cannot be stored",
      async (fault) => {
        const a = adapter(),
          request = recall()
        await startWithDispatch(a, C2C_DISPATCH)
        mockInvoke.mockResolvedValue(httpResp(200, { id: "known-recall" }))
        const table = getDb().inboundLedger,
          original = table.put.bind(table)
        let failed = false
        const spy = jest.spyOn(table, "put").mockImplementation((...args) => {
          const row = args[0]
          if (
            !failed &&
            (fault === "receipt"
              ? row.deliveryReceipt?.phase === "sent"
              : row.qqStream?.phase === "closed")
          ) {
            failed = true
            return Dexie.Promise.reject(new Error("ACK write unavailable"))
          }
          return original(...args)
        })
        try {
          expect(await a.send(request)).toMatchObject({
            ok: false,
            error: { code: "reconciliation_required" },
          })
        } finally {
          spy.mockRestore()
          await a.stop()
        }
        expect(failed).toBe(true)
        expect(await adapter().send(request)).toMatchObject({
          ok: false,
          error: { code: "reconciliation_required" },
        })
        expect(httpCalls()).toHaveLength(1)
      }
    )
    it.each(["cancelled", "uncertain"])(
      "retains %s recall checkpoints during cleanup and refuses replay",
      async (phase) => {
        const a = adapter(),
          request = recall()
        await startWithDispatch(a, C2C_DISPATCH)
        mockInvoke.mockResolvedValue(httpResp(200, { id: "recall" }))
        const partial = {
          conversationRef: request.conversationRef,
          streamKey: request.metadata.streamKey,
          sendOptions: request.sendOptions,
          text: "Hello",
        }
        if (phase === "uncertain") mockInvoke.mockRejectedValueOnce(new Error("ACK lost"))
        if (phase === "uncertain") await expect(a.streamReply!(partial)).rejects.toThrow()
        else {
          await a.streamReply!(partial)
          await a.cancelStreamReply!({ ...partial, streamKey: request.metadata.streamKey! })
        }
        await a.stop()
        const row = (await getDb().inboundLedger.where("namespace").equals("qq-stream").first())!
        await getDb().inboundLedger.update(row.id, { receivedAt: Date.now() - 2 * 86400_000 })
        const restored = adapter()
        await startWithDispatch(restored, C2C_DISPATCH)
        await restored.send({
          ...request,
          conversationRef: { ...request.conversationRef, sceneId: "other-user" },
          metadata: { idempotencyKey: "other", streamKey: "other" },
        })
        const count = httpCalls().length
        expect(await restored.send(request)).toMatchObject({
          ok: false,
          error: { code: phase === "uncertain" ? "reconciliation_required" : "validation" },
        })
        expect(httpCalls()).toHaveLength(count)
        expect((await getDb().inboundLedger.get(row.id))?.qqStream?.phase).toBe(phase)
        await restored.stop()
      }
    )
    it("isolates the same capture key across recipients", async () => {
      const a = adapter(),
        request = recall()
      await startWithDispatch(a, C2C_DISPATCH)
      mockInvoke.mockResolvedValue(httpResp(200, { id: "recall" }))
      expect((await a.send(request)).ok).toBe(true)
      expect(
        (
          await a.send({
            ...request,
            conversationRef: { ...request.conversationRef, sceneId: "other-user" },
            metadata: { ...request.metadata, idempotencyKey: "other" },
          })
        ).ok
      ).toBe(true)
      expect(httpCalls()).toHaveLength(2)
      expect(
        await getDb().inboundLedger.where("namespace").equals("connector-delivery").count()
      ).toBe(2)
      await a.stop()
    })
    it.each([
      [400, 40054005],
      [200, 40054005],
      [400, 304024],
      [200, 304024],
      [401, 304024],
      [202, 0],
    ])(
      "keeps HTTP%s business %s ambiguous and preserves the recall allowance",
      async (status, code) => {
        const a = adapter()
        await startWithDispatch(a, C2C_DISPATCH)
        mockInvoke.mockResolvedValue(
          httpResp(status, { err_code: code, data: { message_audit: { audit_id: "pending" } } })
        )
        const request = recall()
        expect(await a.send(request)).toMatchObject({
          ok: false,
          error: { code: "reconciliation_required" },
        })
        expect(
          await a.send({ ...request, metadata: { idempotencyKey: "second", streamKey: "second" } })
        ).toMatchObject({ ok: false, error: { code: "validation" } })
        expect(httpCalls()).toHaveLength(1)
        await a.stop()
      }
    )
    it("refuses a first frame whose recall and minute windows expired during token acquisition", async () => {
      let clock = Date.UTC(2026, 9, 28, 12, 0, 59, 500)
      const time = jest.spyOn(Date, "now").mockImplementation(() => clock)
      let delay = true
      const a = adapter({
        accessToken: async () => {
          if (delay) {
            clock += 1000
            delay = false
          }
          return "tok"
        },
      })
      try {
        await startWithDispatch(a, C2C_DISPATCH)
        const request = recall()
        request.conversationRef.receivedAt = clock - 86400_000 + 500
        mockInvoke.mockResolvedValue(httpResp(200, { id: "recall" }))
        expect(await a.send(request)).toMatchObject({ ok: false, error: { code: "validation" } })
        expect(httpCalls()).toHaveLength(0)
      } finally {
        time.mockRestore()
        await a.stop()
      }
    })
    function recall() {
      return sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "c2c",
          sceneId: "recall-user",
          msgId: "source",
          receivedAt: Date.now() - 2 * 86400_000,
        },
        segments: [{ type: "markdown", md: "Hello world" }],
        sendOptions: { mode: "reengagement" },
        metadata: { idempotencyKey: "recall-final", streamKey: "recall-turn" },
      })
    }
    it("hands a growing recall to the governed queue and finalizes one native message with one quota", async () => {
      const a = adapter(),
        request = recall()
      await startWithDispatch(a, C2C_DISPATCH)
      mockInvoke.mockResolvedValue(httpResp(200, { id: "native-recall" }))
      await a.streamReply!({
        conversationRef: request.conversationRef,
        streamKey: request.metadata.streamKey,
        sendOptions: request.sendOptions,
        text: "Hello",
      })
      await a.streamReply!({
        conversationRef: request.conversationRef,
        streamKey: request.metadata.streamKey,
        sendOptions: request.sendOptions,
        text: "Hello w",
      })
      const { getConnectorDeliveryGateway } = await import("@/lib/connectors/delivery-gateway")
      const { startOutboundRunner } = await import("@/lib/connectors/outbound-runner")
      const row = await getConnectorDeliveryGateway().enqueue({
        adapterId: a.id,
        conversationKey: "qq-official:qq-1:recall-user",
        request,
        source: "manual",
      })
      const controller = new AbortController()
      const running = startOutboundRunner({
        adapters: new Map([[a.id, a]]),
        signal: controller.signal,
        pollIntervalMs: 10,
      })
      try {
        for (
          let i = 0;
          i < 500 && (await getDb().outboundQueue.get(row.id))?.status !== "sent";
          i++
        )
          await new Promise((r) => setTimeout(r, 3))
        expect(await getDb().outboundQueue.get(row.id)).toMatchObject({
          status: "sent",
          platformMessageId: "c2c:recall-user:native-recall",
        })
        const calls = httpCalls()
        expect(calls).toHaveLength(3)
        expect(calls.every((c) => c.url.endsWith("/stream_messages"))).toBe(true)
        expect(calls.map((c) => JSON.parse(c.body!))).toMatchObject([
          { index: 0, input_state: 1, is_wakeup: true },
          { index: 1, input_state: 1, is_wakeup: true },
          { index: 2, input_state: 10, is_wakeup: true, stream_msg_id: "native-recall" },
        ])
        const receipts = await getDb()
          .inboundLedger.where("namespace")
          .equals("connector-delivery")
          .toArray()
        expect(receipts).toHaveLength(1)
        expect(
          receipts[0].deliveryReceipt!.quotas.filter((q) => q.key.startsWith("reengagement:"))
        ).toMatchObject([{ cost: 1 }])
        expect(qqPassiveReplyCount("source")).toBe(0)
        expect(
          await a.send({
            ...request,
            metadata: { idempotencyKey: "another", streamKey: "another" },
          })
        ).toMatchObject({ ok: false, error: { code: "validation" } })
        expect(httpCalls()).toHaveLength(3)
      } finally {
        controller.abort()
        await running
        await a.stop()
      }
    })
    it("retains completed and cancelled recall evidence beyond the ordinary 24-hour checkpoint lifetime", async () => {
      const request = recall(),
        a = adapter()
      await startWithDispatch(a, C2C_DISPATCH)
      mockInvoke.mockResolvedValue(httpResp(200, { id: "recall" }))
      expect((await a.send(request)).ok).toBe(true)
      await a.stop()
      const past = Date.now() - 2 * 86400_000
      const rows = await getDb().inboundLedger.where("namespace").equals("qq-stream").toArray()
      await getDb().inboundLedger.update(rows[0].id, { receivedAt: past })
      const restored = adapter()
      await startWithDispatch(restored, C2C_DISPATCH)
      // Another conversation triggers checkpoint pruning without sharing this recipient's allowance.
      expect(
        (
          await restored.send({
            ...request,
            conversationRef: { ...request.conversationRef, sceneId: "another-user" },
            metadata: { idempotencyKey: "other", streamKey: "other" },
          })
        ).ok
      ).toBe(true)
      const count = httpCalls().length
      expect((await restored.send(request)).ok).toBe(true)
      expect(httpCalls()).toHaveLength(count)
      expect(await getDb().inboundLedger.get(rows[0].id)).toBeDefined()
      await restored.stop()
    })
    it.each(["ambiguous", "opt-out", "pii"])(
      "blocks unsafe recall %s before another provider send",
      async (kind) => {
        const a = adapter(),
          request = recall()
        await startWithDispatch(a, C2C_DISPATCH)
        mockInvoke.mockImplementation(async () => {
          if (kind === "ambiguous") throw new Error("ack lost")
          return httpResp(200, { id: "recall" })
        })
        if (kind === "opt-out") {
          const { refreshConnectorConversationDeliveryTarget } =
            await import("@/lib/db/connector-conversation-state")
          const target = {
            address: {
              conversationKey: "qq-official:qq-1:recall-user",
              platform: "qq-official" as const,
              adapterId: "qq-1",
              scopeKind: "private" as const,
              containerId: "recall-user",
            },
            conversationRef: request.conversationRef,
            refreshedAt: Date.now(),
          }
          await refreshConnectorConversationDeliveryTarget(target)
          await getDb().connectorConversationStates.update(target.address.conversationKey, {
            deliveryPermissions: { proactive: false, updatedAt: Date.now() },
          })
        }
        const partial = {
          conversationRef: request.conversationRef,
          streamKey: request.metadata.streamKey,
          sendOptions: request.sendOptions,
          text: kind === "pii" ? "Contact private@example.com" : "Hello",
        }
        await expect(a.streamReply!(partial)).rejects.toThrow()
        if (kind === "ambiguous") {
          expect(await adapter().send(request)).toMatchObject({
            ok: false,
            error: { code: "reconciliation_required" },
          })
          expect(httpCalls()).toHaveLength(1)
        } else expect(httpCalls()).toHaveLength(0)
        await a.stop()
      }
    )
  })
  it("does not acknowledge a menu as accepted when production context capture fails", async () => {
    const { buildAdapterContext } = await import("@/lib/connectors/adapter-context")
    const bus = getBus(),
      observed = jest.fn(),
      controller = new AbortController()
    bus.subscribeInbound(observed)
    const a = adapter({ transportMode: "webhook" })
    const ctx = buildAdapterContext({ adapterId: "qq-1", signal: controller.signal, bus })
    await a.start(ctx)
    const spy = jest
      .spyOn(getDb().connectorAudit, "add")
      .mockRejectedValueOnce(new Error("capture unavailable"))
    try {
      mockInvoke.mockResolvedValue(httpResp(204, ""))
      const listener = (listen as jest.Mock).mock.calls
        .filter(([name]) => name === "connectors://webhook/qq-1")
        .at(-1)![1]
      listener({
        payload: {
          op: 0,
          t: "INTERACTION_CREATE",
          d: {
            id: "menu-failure",
            type: 12,
            scene: "c2c",
            user_openid: "user",
            timestamp: new Date().toISOString(),
            data: { resolved: { feature_id: "help" } },
          },
        },
      })
      for (let i = 0; i < 200 && !httpCalls().length; i++)
        await new Promise((r) => setTimeout(r, 2))
      expect(httpCalls()).toHaveLength(1)
      expect(JSON.parse(httpCalls()[0].body!)).toEqual({ code: 1 })
      expect(observed).not.toHaveBeenCalled()
      expect(await getDb().inboundLedger.where("namespace").equals("inbound").count()).toBe(0)
    } finally {
      spy.mockRestore()
      await a.stop()
    }
  })
  it("retains known audit correlation when the host's first persistence attempt fails", async () => {
    const a = adapter()
    mockInvoke.mockResolvedValue(
      httpResp(202, { err_code: 304024, data: { message_audit: { audit_id: "audit" } } })
    )
    const persist = jest.fn(async () => {
      throw new Error("disk temporarily unavailable")
    })
    const result = await a.send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "channel",
          sceneId: "channel",
          msgId: "in",
          receivedAt: Date.now(),
        },
      }),
      { onPendingReceipt: persist }
    )
    expect(result).toMatchObject({
      ok: false,
      pendingReceipt: { id: "audit" },
      error: { retryable: false },
    })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(httpCalls()).toHaveLength(1)
  })
  it.each([false, true])(
    "subscribes to channel audit events only when explicitly enabled: %s",
    async (enabled) => {
      const a = adapter({ receiveMessageAudit: enabled })
      await startWithDispatch(a, C2C_DISPATCH)
      expect(Boolean(mockStartGateway.mock.calls.at(-1)![0].intents & (1 << 27))).toBe(enabled)
      await a.stop()
    }
  )
  it.each(
    (["webhook", "gateway"] as const).flatMap((transport) =>
      [12, 13, 14, 15, 16, 18, 19, 20].map((type) => ({ transport, type }))
    )
  )(
    "routes $transport native type$type through the common event bus, with ACK only for menus",
    async ({ transport, type }) => {
      const observed = jest.fn(),
        bus = getBus()
      bus.subscribeInbound(observed)
      const a = adapter({ transportMode: transport })
      mockInvoke.mockResolvedValue(httpResp(204, ""))
      const resolved =
        type === 12
          ? { feature_id: "help" }
          : type === 13
            ? { message_id: "sent", feedback_opt: "UNLIKE", checked: 0 }
            : type === 15
              ? { action: "QUIT_STORY" }
              : type === 18 || type === 19
                ? { authorize_data: { scope: type === 19 ? "group_push" : "c2c_push" } }
                : {}
      const dispatch = {
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: `control-${type}`,
          type,
          scene: type === 19 ? "group" : "c2c",
          user_openid: "user",
          group_openid: "group",
          group_member_openid: "operator",
          timestamp: new Date().toISOString(),
          data: { resolved },
        },
      }
      let delivered = false
      mockStartGateway.mockReturnValue({
        selfId: "bot",
        dispatches: fakeDispatches(() => {
          if (!delivered) {
            delivered = true
            return Promise.resolve({ done: false, value: dispatch })
          }
          return new Promise(() => {})
        }),
      })
      await a.start({
        emit: (event, options) => bus.dispatchInboundFull(event, options),
      } as AdapterContext)
      try {
        if (transport === "webhook") {
          const listener = (listen as jest.Mock).mock.calls
            .filter(([name]) => name === "connectors://webhook/qq-1")
            .at(-1)![1]
          listener({ payload: dispatch })
        }
        for (let i = 0; i < 200 && !observed.mock.calls.length; i++)
          await new Promise((r) => setTimeout(r, 2))
        expect(observed).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "system",
            systemKind: type === 13 ? "reaction_removed" : "interaction",
            interaction: expect.any(Object),
            conversationKey: `qq-official:qq-1:${type === 19 ? "group" : "user"}`,
            conversationRef: expect.objectContaining({ scene: type === 19 ? "group" : "c2c" }),
            sender: expect.objectContaining({ remoteUserId: type === 19 ? "operator" : "user" }),
            ...(type === 13
              ? { replacesMessageId: "c2c:user:sent", segments: [{ type: "emoji", code: "👎" }] }
              : {}),
          })
        )
        for (let i = 0; i < 100 && type === 12 && !httpCalls().length; i++)
          await new Promise((r) => setTimeout(r, 2))
        expect(httpCalls().map((call) => call.url)).toEqual(
          type === 12 ? ["https://api.bot.qq.com/interactions/control-12"] : []
        )
        if (type === 12) expect(JSON.parse(httpCalls()[0].body!)).toEqual({ code: 0 })
        expect(await getDb().messages.count()).toBe(0)
        expect(await getDb().outboundQueue.count()).toBe(0)
      } finally {
        await a.stop()
      }
    }
  )
  it.each([0, 1])(
    "does not settle a multipart channel job from part %s audit evidence or resend it",
    async (pendingPart) => {
      const { enqueueOutbound, listDueNow } = await import("@/lib/db/outbound-jobs")
      const { startOutboundRunner } = await import("@/lib/connectors/outbound-runner")
      const a = adapter({ transportMode: "webhook" })
      await a.start({ emit: (event) => getBus().dispatchInboundFull(event) } as AdapterContext)
      const send = jest.spyOn(a, "send")
      if (pendingPart === 1) mockInvoke.mockResolvedValueOnce(httpResp(200, { id: "first-part" }))
      mockInvoke.mockResolvedValueOnce(
        httpResp(202, {
          err_code: 304024,
          data: { message_audit: { audit_id: "one-part-only" } },
        })
      )
      const row = await enqueueOutbound({
        adapterId: "qq-1",
        conversationKey: "qq-official:qq-1:channel",
        source: "manual",
        request: sendReq({
          conversationRef: {
            platform: "qq-official",
            adapterId: "qq-1",
            scene: "channel",
            sceneId: "channel",
            msgId: "in",
          },
          segments: [
            { type: "image", url: "https://cdn.example.org/first.png" },
            { type: "image", url: "https://cdn.example.org/second.png" },
          ],
        }),
      })
      const controller = new AbortController()
      const running = startOutboundRunner({
        adapters: new Map([[a.id, a]]),
        signal: controller.signal,
        pollIntervalMs: 10,
      })
      try {
        for (
          let i = 0;
          i < 500 && (await getDb().outboundQueue.get(row.id))?.status !== "delivery_unknown";
          i++
        )
          await new Promise((r) => setTimeout(r, 2))
        expect(await send.mock.results[0].value).toMatchObject({
          ok: false,
          error: { code: "reconciliation_required", retryable: false },
        })
        expect(await send.mock.results[0].value).not.toHaveProperty("pendingReceipt")
        expect((await getDb().outboundQueue.get(row.id))?.pendingReceipt).toBeUndefined()
        const listener = (listen as jest.Mock).mock.calls
          .filter(([name]) => name === "connectors://webhook/qq-1")
          .at(-1)![1]
        listener({
          payload: {
            op: 0,
            t: "MESSAGE_AUDIT_PASS",
            id: "part-audit",
            d: {
              audit_id: "one-part-only",
              guild_id: "guild",
              channel_id: "channel",
              message_id: "one-part",
              audit_time: new Date().toISOString(),
            },
          },
        })
        for (
          let i = 0;
          i < 200 &&
          !(await getDb().inboundLedger.where("namespace").equals("connector-status").count());
          i++
        )
          await new Promise((r) => setTimeout(r, 2))
        expect(
          await getDb().inboundLedger.where("namespace").equals("connector-status").count()
        ).toBe(1)
        expect((await getDb().outboundQueue.get(row.id))?.status).toBe("delivery_unknown")
        expect(await listDueNow()).toEqual([])
        expect(
          await wasDeliveredByUs("qq-1", row.conversationKey, "channel:channel:one-part")
        ).toBe(false)
        await new Promise((r) => setTimeout(r, 30))
        expect(send).toHaveBeenCalledTimes(1)
        expect(httpCalls()).toHaveLength(pendingPart + 1)
      } finally {
        controller.abort()
        await running
        await a.stop()
      }
    }
  )
  it.each(["early", "late", "restart"] as const)(
    "reconciles an %s channel audit through the shared durable queue without another POST",
    async (timing) => {
      const { enqueueOutbound } = await import("@/lib/db/outbound-jobs")
      const { startOutboundRunner } = await import("@/lib/connectors/outbound-runner")
      const ctx = {
        emit: (event: NormalizedInboundEvent) => getBus().dispatchInboundFull(event),
      } as AdapterContext
      let a = adapter({ transportMode: "webhook" })
      await a.start(ctx)
      const row = await enqueueOutbound({
        adapterId: "qq-1",
        conversationKey: "qq-official:qq-1:channel",
        source: "manual",
        request: sendReq({
          conversationRef: {
            platform: "qq-official",
            adapterId: "qq-1",
            scene: "channel",
            sceneId: "channel",
            msgId: "in",
            receivedAt: Date.now(),
          },
        }),
      })
      const audit = {
        op: 0,
        t: "MESSAGE_AUDIT_PASS",
        id: "audit-pass",
        d: {
          audit_id: "audit",
          guild_id: "guild",
          channel_id: "channel",
          audit_time: new Date().toISOString(),
          message_id: "delivered",
        },
      }
      const deliver = () =>
        (listen as jest.Mock).mock.calls
          .filter(([name]) => name === "connectors://webhook/qq-1")
          .at(-1)![1]({ payload: audit })
      mockInvoke.mockImplementation(async (command) => {
        if (command === "connectors_http_request") {
          if (timing === "early") {
            deliver()
            for (
              let i = 0;
              i < 200 &&
              !(await getDb().inboundLedger.where("namespace").equals("connector-status").count());
              i++
            )
              await new Promise((r) => setTimeout(r, 2))
          }
          return httpResp(202, { err_code: 304024, data: { message_audit: { audit_id: "audit" } } })
        }
        return undefined
      })
      const controller = new AbortController()
      const running = startOutboundRunner({
        adapters: new Map([[a.id, a]]),
        signal: controller.signal,
        pollIntervalMs: 10,
      })
      try {
        for (let i = 0; i < 500 && !(await getDb().outboundQueue.get(row.id))?.pendingReceipt; i++)
          await new Promise((r) => setTimeout(r, 2))
        expect((await getDb().outboundQueue.get(row.id))?.pendingReceipt?.id).toBe("audit")
        if (timing === "restart") {
          controller.abort()
          await running
          await a.stop()
          a = adapter({ transportMode: "webhook" })
          await a.start(ctx)
        }
        if (timing !== "early") deliver()
        for (
          let i = 0;
          i < 500 && (await getDb().outboundQueue.get(row.id))?.status !== "sent";
          i++
        )
          await new Promise((r) => setTimeout(r, 2))
        expect(await getDb().outboundQueue.get(row.id)).toMatchObject({
          status: "sent",
          platformMessageId: "channel:channel:delivered",
        })
        expect(
          await wasDeliveredByUs("qq-1", row.conversationKey, "channel:channel:delivered")
        ).toBe(true)
        expect(httpCalls()).toHaveLength(1)
      } finally {
        controller.abort()
        await running
        await a.stop()
      }
    }
  )
  it.each([
    [200, { err_code: 10001, message: "secret-provider-detail" }],
    [202, { data: { url: "https://qun.qq.com/qunpro/robot/qunshare" } }],
  ])("does not return a link for HTTP%s nondefinitive/business failures", async (status, body) => {
    const a = adapter({ transportMode: "webhook" })
    await a.start(fakeCtx())
    try {
      mockInvoke.mockResolvedValueOnce(httpResp(status, body))
      const { executeConnectorManagement } = await import("@/lib/connectors/management")
      await expect(
        executeConnectorManagement(a, {
          operation: "links.create",
          input: { purpose: "add-contact" },
        })
      ).rejects.toThrow(/^QQ management request failed(?: \(code \d+\))?$/)
      expect(httpCalls()).toHaveLength(1)
    } finally {
      await a.stop()
    }
  })
  it("generates a link through shared management and preserves verified-transport friend attribution through the bus", async () => {
    const bus = getBus(),
      observed = jest.fn()
    bus.subscribeInbound(observed)
    const friend = {
      op: 0,
      t: "FRIEND_ADD",
      id: "friend-referral",
      d: {
        openid: "new-user",
        timestamp: Math.floor(Date.now() / 1000),
        scene: 2003,
        scene_param: "campaign",
        short_code: "short",
        auth_token: "secret",
      },
    }
    // The native verified Webhook seam is exercised by transport-webhook.test;
    // this test drives its actual adapter consumer, parser, bus and durable audit.
    mockStartGateway.mockReturnValue({
      selfId: "bot",
      dispatches: fakeDispatches(() => new Promise(() => {})),
    })
    const a = adapter({ transportMode: "webhook" })
    const ctx = {
      emit: (event: NormalizedInboundEvent) => bus.dispatchInboundFull(event),
    } as AdapterContext
    await a.start(ctx)
    try {
      mockInvoke.mockResolvedValueOnce(
        httpResp(200, { data: { url: "https://qun.qq.com/qunpro/robot/qunshare?data=campaign" } })
      )
      const { executeConnectorManagement } = await import("@/lib/connectors/management")
      await expect(
        executeConnectorManagement(a, {
          operation: "links.create",
          input: { purpose: "add-contact", state: "campaign" },
        } as never)
      ).resolves.toMatchObject({ link: { purpose: "add-contact" } })
      expect(httpCalls().map((call) => [call.method, call.url, JSON.parse(call.body!)])).toEqual([
        ["POST", "https://api.bot.qq.com/v2/generate_url_link", { callback_data: "campaign" }],
      ])
      const callback = (listen as jest.Mock).mock.calls.find(
        ([name]) => name === "connectors://webhook/qq-1"
      )?.[1]
      expect(callback).toBeDefined()
      callback({ payload: friend })
      for (let i = 0; i < 100 && !observed.mock.calls.length; i++)
        await new Promise((r) => setTimeout(r, 1))
      expect(observed).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "system",
          referral: { source: "2003", state: "campaign" },
          segments: [],
          plainText: "",
        })
      )
      for (let i = 0; i < 100; i++) {
        const audit = await getDb().connectorAudit.where("adapterId").equals("qq-1").toArray()
        if (audit.some((row) => row.kind === "inbound.lifecycle")) break
        await new Promise((r) => setTimeout(r, 1))
      }
      const audit = await getDb().connectorAudit.where("adapterId").equals("qq-1").toArray()
      expect(audit).toContainEqual(
        expect.objectContaining({
          kind: "inbound.lifecycle",
          fields: expect.objectContaining({ referral: { source: "2003", state: "campaign" } }),
        })
      )
      expect(await getDb().messages.count()).toBe(0)
      expect(await getDb().outboundQueue.count()).toBe(0)
      expect(httpCalls()).toHaveLength(1)
    } finally {
      await a.stop()
    }
  })
  it.each(["approve", "cancel"] as const)(
    "routes shared skill confirmation %s through a queued native QQ card",
    async (choice) => {
      const { z } = await import("zod")
      const { registerBuiltInSkill } = await import("@/lib/skills/built-in/registry")
      const { runBuiltInSkill } = await import("@/lib/skills/built-in/dispatcher")
      const { resolveBuiltInSkillContext } = await import("@/lib/skills/built-in/context")
      const { registerImElicitationContext } =
        await import("@/lib/connectors/hitl/im-elicitation-context")
      const { buildConfirmSurface } = await import("@/lib/skills/built-in/_shared/confirm-surface")
      const { upsertByConversationKey } = await import("@/lib/db/conversation-overrides")
      const id = `im.g8_confirmation_${choice}`,
        key = "qq-official:qq-1:UO",
        sessionId = `skill-session-${choice}`
      const execute = jest.fn(async () => ({ changed: true }))
      registerBuiltInSkill({
        id,
        family: "im",
        platforms: "any",
        mcpToolName: id.replaceAll(".", "_"),
        label: { en: "Manage resource", "zh-CN": "管理资源" },
        description: { en: "Test mutation", "zh-CN": "测试变更" },
        mutation: "destructive",
        imAccess: "opt-in",
        inputSchema: z.object({}),
        execute,
        hitlSurface: () =>
          buildConfirmSurface({
            surfaceId: `confirm-${choice}`,
            title: "Manage resource",
            summary: "Apply the requested change",
          }),
      })
      const ref = {
        platform: "qq-official" as const,
        adapterId: "qq-1",
        scene: "c2c",
        sceneId: "UO",
        msgId: "in-1",
        receivedAt: Date.now(),
      }
      await getDb().sessions.put({
        id: sessionId,
        title: "Skill session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        platformBinding: {
          adapterId: "qq-1",
          platform: "qq-official",
          conversationKey: key,
          conversationRef: ref,
        },
      } as never)
      await upsertByConversationKey({
        conversationKey: key,
        sessionId,
        allowedBuiltInSkillIds: [id],
      })
      const unregister = registerImElicitationContext({
        sessionId,
        adapterId: "qq-1",
        conversationKey: key,
        conversationRef: ref,
        initiatorUserId: "human",
      })
      const a = adapter(),
        bus = getBus()
      bus.registerAdapter(a)
      try {
        expect(
          await runBuiltInSkill(id, {}, await resolveBuiltInSkillContext(sessionId))
        ).toMatchObject({ status: "pending_hitl" })
        const [job] = await getDb().outboundQueue.toArray()
        expect(job.request.segments[0]).toMatchObject({ type: "a2ui" })
        mockInvoke.mockResolvedValue(httpResp(200, { id: "card" }))
        expect((await a.send(job.request)).ok).toBe(true)
        const payload = JSON.parse(httpCalls().at(-1)!.body!)
        const button = payload.keyboard.content.rows[0].buttons[choice === "approve" ? 0 : 1]
        const callback = await resolveQQInteraction("qq-1", "bot", {
          id: `press-${choice}`,
          scene: "c2c",
          sceneId: "UO",
          actorId: "human",
          buttonData: button.action.data,
          buttonId: button.id,
          messageId: "card",
          timestamp: Date.now(),
        })
        expect(callback).not.toBeNull()
        await bus.dispatchConnectorCallback(callback!)
        expect(execute).toHaveBeenCalledTimes(choice === "approve" ? 1 : 0)
        expect(
          await resolveQQInteraction("qq-1", "bot", {
            id: `second-${choice}`,
            scene: "c2c",
            sceneId: "UO",
            actorId: "human",
            buttonData: button.action.data,
            timestamp: Date.now(),
          })
        ).toBeNull()
      } finally {
        unregister()
      }
    }
  )
  it("stops a paced multipart proactive send when its adapter generation ends", async () => {
    const a = adapter()
    await startWithDispatch(a, C2C_DISPATCH)
    let first!: () => void
    const sentFirst = new Promise<void>((resolve) => {
      first = resolve
    })
    let count = 0
    mockInvoke.mockImplementation(async (_command, args) => {
      const path = args.req.url as string
      if (path.endsWith("/bot_state"))
        return httpResp(200, { allow_proactive_msg: true, member_role: "admin" })
      if (path.endsWith("/files")) return httpResp(200, { file_info: "image" })
      if (path.endsWith("/messages")) {
        count++
        if (count === 1) first()
        return httpResp(200, { id: `sent-${count}` })
      }
      throw new Error("Unexpected endpoint")
    })
    const pending = a.send(
      sendReq({
        sendOptions: { mode: "proactive" },
        segments: [
          { type: "markdown", md: "Hello" },
          { type: "image", url: "https://example.org/image.png" },
        ],
      })
    )
    await sentFirst
    await new Promise((resolve) => setTimeout(resolve, 50))
    await a.stop()
    await startWithDispatch(a, C2C_DISPATCH)
    expect(await pending).toMatchObject({
      error: { code: "reconciliation_required", retryable: false },
    })
    expect(count).toBe(1)
    await a.stop()
  })
  it.each([0, 1, 3, 7, 29.99, 30])(
    "enforces the C2C reengagement interval at day %s",
    async (days) => {
      const a = adapter()
      await startWithDispatch(a, C2C_DISPATCH)
      mockInvoke.mockResolvedValue(httpResp(200, { id: "reengagement" }))
      const request = sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "c2c",
          sceneId: "UO",
          msgId: "in-1",
          receivedAt: Date.now() - days * 86400_000,
        },
        sendOptions: { mode: "reengagement" },
      })
      try {
        expect((await a.send(request)).ok).toBe(days < 30)
        if (days < 30) {
          expect(JSON.parse(httpCalls()[0].body!)).toMatchObject({ is_wakeup: true })
          expect(
            await a.send({ ...request, metadata: { idempotencyKey: "second-wakeup" } })
          ).toMatchObject({ error: { code: "validation" } })
          expect(httpCalls()).toHaveLength(1)
        } else expect(httpCalls()).toHaveLength(0)
      } finally {
        await a.stop()
      }
    }
  )
  it("counts only broadcast-bearing parts toward the group's daily mention allowance", async () => {
    const a = adapter()
    await startWithDispatch(a, C2C_DISPATCH)
    mockInvoke.mockImplementation(async (_command, args) =>
      args.req.url.endsWith("/bot_state")
        ? httpResp(200, { member_role: "admin" })
        : args.req.url.endsWith("/files")
          ? httpResp(200, { file_info: "image" })
          : httpResp(200, { id: `sent-${httpCalls().length}` })
    )
    const req = sendReq({
      segments: [
        { type: "mention", userId: "", audience: "all" },
        { type: "markdown", md: "Announcement" },
        { type: "image", url: "https://example.org/image.png" },
      ],
    })
    expect((await a.send(req)).ok).toBe(true)
    expect((await a.send(req)).ok).toBe(true)
    expect(
      await a.send({ ...req, metadata: { idempotencyKey: "second-broadcast" } })
    ).toMatchObject({ error: { code: "validation", retryable: false } })
    expect(httpCalls().filter((call) => call.url.endsWith("/messages"))).toHaveLength(2)
    await a.stop()
  })
  it.each([true, false, undefined])(
    "enforces captured C2C proactive consent %s before native POST",
    async (allowed) => {
      const a = adapter()
      await startWithDispatch(a, C2C_DISPATCH)
      if (allowed !== undefined) {
        const event = parseQQDispatch("qq-1", "bot", {
          op: 0,
          id: "consent",
          t: allowed ? "C2C_MSG_RECEIVE" : "C2C_MSG_REJECT",
          d: { openid: "UO", timestamp: Math.floor(Date.now() / 1000) },
        } as never)!
        await captureSystemDeliveryContext(event)
      }
      mockInvoke.mockResolvedValue(httpResp(200, { id: "proactive" }))
      const request = sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "c2c",
          sceneId: "UO",
          msgId: "in-1",
          receivedAt: Date.now(),
        },
        sendOptions: { mode: "proactive" },
      })
      const result = await a.send(request)
      expect(result.ok).toBe(allowed === true)
      if (allowed) {
        expect(JSON.parse(httpCalls()[0].body!)).not.toHaveProperty("msg_id")
        expect((await adapter().send(request)).ok).toBe(true)
        expect(httpCalls()).toHaveLength(1)
      } else expect(httpCalls()).toHaveLength(0)
      await a.stop()
    }
  )
  it("protects card and stream reusable media references, including padded tokens", async () => {
    const a = adapter()
    const reference = "qqbot-media://image/v1/token=="
    await expect(
      a.streamReply!({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "c2c",
          sceneId: "UO",
          msgId: "in-1",
          receivedAt: Date.now(),
        },
        streamKey: "unknown-asset",
        text: `![image](${reference})`,
      })
    ).rejects.toThrow(/unknown|expired/)
    expect(await getDb().inboundLedger.where("namespace").equals("qq-stream").count()).toBe(0)
    const req = sendReq({
      segments: [
        {
          type: "card",
          card: {
            kind: "qq-keyboard",
            payload: {
              markdown: { content: `![image](${reference})` },
              keyboard: {
                content: {
                  rows: [
                    {
                      buttons: [
                        {
                          id: "link",
                          render_data: { label: "Open", style: 1 },
                          action: { type: 0, data: "https://example.org", permission: { type: 2 } },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    })
    expect(await a.send(req)).toMatchObject({ error: { code: "validation" } })
    expect(mockInvoke).not.toHaveBeenCalled()
    await rememberConnectorAssets("qq-1", [
      { adapterId: "qq-1", id: "image", reference, expiresAt: Date.now() + 60000 },
    ])
    mockInvoke.mockResolvedValue(httpResp(200, { id: "sent" }))
    expect((await a.send(req)).ok).toBe(true)
  })
  it("isolates passive plugin observers from the trusted event and each other", async () => {
    const bus = getBus(),
      observed = jest.fn(),
      handler = jest.fn().mockResolvedValue(undefined)
    bus.setInboundHandler(handler)
    bus.subscribeInbound((event) => {
      event.messageId = "forged"
      event.deliveryPermissionChange = { proactive: true }
    })
    bus.subscribeInbound(observed)
    const event = parseQQDispatch("qq-1", "bot", C2C_DISPATCH)!
    await bus.dispatchInbound(event)
    expect(observed.mock.calls[0][0].messageId).toBe("in-1")
    expect(handler.mock.calls[0][0].deliveryPermissionChange).toBeUndefined()
  })
  it.each(["group", "c2c"] as const)(
    "never turns arbitrary %s segment paths into privileged filesystem reads",
    async (scene) => {
      for (const url of [
        "/etc/passwd",
        "file:///etc/passwd",
        "C:\\private\\secret.txt",
        "file://localhost/etc/passwd",
      ]) {
        const result = await adapter().send(
          sendReq({
            conversationRef: {
              platform: "qq-official",
              adapterId: "qq-1",
              scene,
              sceneId: "target",
              msgId: "trigger",
            },
            segments: [
              { type: "file", url, name: "file.txt", mimeType: "text/plain", sizeBytes: 1 },
            ],
          })
        )
        expect(result).toMatchObject({ ok: false, error: { code: "validation", retryable: false } })
      }
      expect(mockInvoke).not.toHaveBeenCalled()
      expect(qqPassiveReplyCount("trigger")).toBe(0)
    }
  )

  it.each(["group", "c2c"] as const)(
    "uploads %s inline files on the native host before the passive message",
    async (scene) => {
      mockInvoke.mockImplementation(async (command: string) =>
        command === "connectors_media_upload"
          ? JSON.stringify(httpResp(200, { file_info: "binary-file" }))
          : httpResp(200, { id: "sent" })
      )
      const result = await adapter().send(
        sendReq({
          conversationRef: {
            platform: "qq-official",
            adapterId: "qq-1",
            scene,
            sceneId: "target",
            msgId: "trigger",
            qqMsgIndex: "REFIDX_trigger",
          },
          replyTo: { messageId: "trigger" },
          segments: [
            {
              type: "file",
              url: "data:application/octet-stream;base64,AP+AQQ==",
              name: "sample.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 4,
            },
          ],
        })
      )
      expect(result).toMatchObject({ ok: true, platformMessageId: `${scene}:target:sent` })
      expect(mockInvoke).toHaveBeenCalledWith("connectors_media_upload", {
        req: expect.objectContaining({
          uploadUrl: `https://api.bot.qq.com/v2/${scene === "group" ? "groups" : "users"}/target/files`,
          qq: { fileType: 4, fileName: "sample.bin" },
          sourceUrl: "data:application/octet-stream;base64,AP+AQQ==",
          responseMode: "http",
          headers: expect.objectContaining({ Authorization: "QQBot tok" }),
        }),
      })
      expect(JSON.parse(httpCalls()[0].body!)).toMatchObject({
        msg_id: "trigger",
        msg_type: 7,
        media: { file_info: "binary-file" },
        message_reference: { message_id: "REFIDX_trigger" },
      })
      expect(qqPassiveReplyCount("trigger")).toBe(1)
    }
  )

  it("refreshes one native upload token rejection without reserving a message slot on failure", async () => {
    let uploads = 0
    mockInvoke.mockImplementation(async (command: string) =>
      command === "connectors_media_upload"
        ? JSON.stringify(
            httpResp(
              200,
              ++uploads === 1 ? { err_code: 11243, message: "expired" } : { file_info: "ready" }
            )
          )
        : httpResp(200, { id: "sent" })
    )
    const accessToken = jest.fn().mockResolvedValueOnce("old").mockResolvedValue("new")
    const clearTokenCache = jest.fn()
    const request = sendReq({
      segments: [
        {
          type: "file",
          url: "data:application/pdf;base64,aGk=",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
        },
      ],
    })
    expect((await adapter({ accessToken, clearTokenCache }).send(request)).ok).toBe(true)
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
    expect(uploads).toBe(2)
    expect(qqPassiveReplyCount("m1")).toBe(1)
    __resetQQMsgSeqForTesting()
    mockInvoke.mockImplementation(async () =>
      JSON.stringify(httpResp(200, { err_code: 40093002, message: "daily quota" }))
    )
    expect(await adapter().send(request)).toMatchObject({ ok: false })
    expect(qqPassiveReplyCount("m1")).toBe(0)
  })

  it.each(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE"])(
    "uses confirmed Webhook identity for native %s replies to the bot",
    async (t) => {
      const scene = t === "C2C_MESSAGE_CREATE" ? "c2c" : "group"
      const send = sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene,
          sceneId: "target",
          msgId: "initial",
        },
      })
      mockInvoke.mockResolvedValue(
        httpResp(200, { id: "bot-answer", ext_info: { ref_idx: "REFIDX_bot==" } })
      )
      expect((await adapter().send(send)).ok).toBe(true)
      const handlers: Array<(event: { payload: unknown }) => void> = []
      jest.mocked(listen).mockImplementation(async (_name, handler) => {
        handlers.push(handler as (event: { payload: unknown }) => void)
        return jest.fn()
      })
      const a = adapter({ transportMode: "webhook", selfId: async () => "confirmed-bot" })
      const ctx = fakeCtx()
      try {
        await a.start(ctx)
        for (let i = 0; i < 30 && !handlers.length; i++)
          await new Promise((resolve) => setTimeout(resolve, 5))
        handlers[0]({
          payload: {
            op: 0,
            t,
            d: {
              id: "quote",
              group_openid: "target",
              author: { user_openid: "target", member_openid: "member" },
              content: "follow up",
              message_type: 103,
              message_scene: { ext: ["msg_idx=REFIDX_quote==", "ref_msg_idx=REFIDX_bot=="] },
              msg_elements: [{ content: "bot answer" }],
            },
          },
        })
        for (let i = 0; i < 30 && !(ctx.emit as jest.Mock).mock.calls.length; i++)
          await new Promise((resolve) => setTimeout(resolve, 5))
        const event = (ctx.emit as jest.Mock).mock.calls[0][0] as NormalizedInboundEvent
        expect(event.selfId).toBe("confirmed-bot")
        expect(event.replyTo?.messageId).toBe("bot-answer")
        const candidates = inboundReplyLookupIds(event)
        const delivered = await Promise.all(
          candidates.map((id) => wasDeliveredByUs("qq-1", event.conversationKey, id))
        )
        expect(delivered).toContain(true)
        // Exercise the shared bus's exact delivered-parent rule, then the real evaluator.
        event.replyTo!.parentSenderId = delivered.includes(true) ? event.selfId : undefined
        expect(
          evaluatePolicy(
            { rules: [{ kind: "reply-to-bot" }], blockers: [], storeUnmatchedInDraftMode: false },
            event,
            { recentBotReplyAtByConversation: {}, recentByUserAndChannel: {} }
          ).matched
        ).toBe(true)
      } finally {
        await a.stop()
        jest.mocked(listen).mockReset()
      }
    }
  )

  it("keeps quote indexes through durable job compaction and stored-text replay", async () => {
    const event = parseQQDispatch("qq-1", "bot", {
      ...C2C_DISPATCH,
      d: {
        ...C2C_DISPATCH.d,
        message_scene: { ext: ["msg_idx=REFIDX_current==", "auth_token=secret"] },
      },
    })!
    const { job } = await ensureConnectorInboundJob(event, "queue", { historyOnly: true })
    expect(job.sourceMessageId).toBe("in-1")
    expect(job.event.conversationRef).toMatchObject({
      msgId: "in-1",
      qqMsgIndex: "REFIDX_current==",
    })
    expect(job.event.raw).toBeUndefined()
    const replay = inboundEventFromStoredMessage(event, {
      parts: inboundEventToStoredParts(event),
    } as never)
    expect(replay.conversationRef.qqMsgIndex).toBe("REFIDX_current==")
    mockInvoke.mockResolvedValue(httpResp(200, { id: "answer" }))
    expect(
      await adapter().send(
        sendReq({ conversationRef: replay.conversationRef, replyTo: { messageId: "in-1" } })
      )
    ).toMatchObject({ ok: true })
    expect(JSON.parse(httpCalls()[0].body!)).toMatchObject({
      msg_id: "in-1",
      message_reference: { message_id: "REFIDX_current==" },
    })
  })

  it("keeps confirmed earlier-part quote indexes when a later part fails", async () => {
    let sent = 0
    mockInvoke.mockImplementation(async (_command: string, args: { req: { url: string } }) =>
      args.req.url.endsWith("/files")
        ? httpResp(200, { file_info: "file" })
        : ++sent === 1
          ? httpResp(200, { id: "first", ext_info: { ref_idx: "REFIDX_first" } })
          : httpResp(400, { err_code: 40001, message: "rejected" })
    )
    const result = await adapter().send(
      sendReq({
        segments: [
          { type: "markdown", md: "first" },
          { type: "image", url: "https://cdn.example.org/p.png" },
        ],
      })
    )
    expect(result).toMatchObject({
      ok: false,
      platformMessageId: "group:GO:first",
      error: { code: "reconciliation_required", retryable: false },
    })
    expect(
      await findQQReference(
        { adapterId: "qq-1", scene: "group", sceneId: "GO" },
        { referenceIndex: "REFIDX_first" }
      )
    ).toMatchObject({ messageId: "first" })
    expect(await wasDeliveredByUs("qq-1", "qq-official:qq-1:GO", "group:GO:first")).toBe(true)
  })

  it("does not persist a quote alias for an unconfirmed asynchronous send", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(202, { id: "pending", ext_info: { ref_idx: "REFIDX_pending" } })
    )
    expect(await adapter().send(sendReq())).toMatchObject({
      ok: false,
      error: { code: "reconciliation_required" },
    })
    expect(
      await findQQReference(
        { adapterId: "qq-1", scene: "group", sceneId: "GO" },
        { messageId: "pending" }
      )
    ).toBeUndefined()
    expect(await wasDeliveredByUs("qq-1", "qq-official:qq-1:GO", "group:GO:pending")).toBe(false)
  })

  it.each(["group", "c2c"] as const)(
    "persists every %s sent reference and quotes it after recreation",
    async (scene) => {
      let sent = 0
      mockInvoke.mockImplementation(async (_command: string, args: { req: { url: string } }) =>
        args.req.url.endsWith("/files")
          ? httpResp(200, { file_info: "file" })
          : httpResp(200, { id: `sent-${++sent}`, ext_info: { ref_idx: `REFIDX_sent-${sent}==` } })
      )
      const request = sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene,
          sceneId: "target",
          msgId: "trigger",
        },
        segments: [
          { type: "markdown", md: "**one**" },
          { type: "image", url: "https://cdn.example.org/image.png" },
        ],
      })
      expect(await adapter().send(request)).toMatchObject({
        ok: true,
        platformMessageId: `${scene}:target:sent-2`,
      })
      expect(
        await findQQReference(
          { adapterId: "qq-1", scene, sceneId: "target" },
          { messageId: "sent-1" }
        )
      ).toMatchObject({ referenceIndex: "REFIDX_sent-1==" })
      expect(
        await wasDeliveredByUs("qq-1", "qq-official:qq-1:target", `${scene}:target:sent-1`)
      ).toBe(true)
      const result = await adapter().send({
        ...request,
        segments: [{ type: "text", text: "follow up" }],
        replyTo: { messageId: `${scene}:target:sent-1` },
        metadata: { idempotencyKey: "next" },
      })
      expect(result.ok).toBe(true)
      expect(JSON.parse(httpCalls().at(-1)!.body!)).toMatchObject({
        msg_id: "trigger",
        message_reference: { message_id: "REFIDX_sent-1==" },
      })
    }
  )

  it("records inbound indexes before admission and resolves native replies to actual message IDs", async () => {
    await recordQQReference(
      { adapterId: "qq-1", scene: "c2c", sceneId: "UO" },
      "previous-real-id",
      "REFIDX_parent=="
    )
    const a = adapter()
    const ctx = fakeCtx()
    let yielded = false
    mockStartGateway.mockReturnValue({
      selfId: "bot",
      dispatches: fakeDispatches(() => {
        if (yielded) return new Promise(() => {})
        yielded = true
        return Promise.resolve({
          done: false,
          value: {
            ...C2C_DISPATCH,
            d: {
              ...C2C_DISPATCH.d,
              message_type: 103,
              message_scene: { ext: ["msg_idx=REFIDX_current==", "ref_msg_idx=REFIDX_parent=="] },
              msg_elements: [{ content: "parent" }],
            },
          },
        })
      }),
    })
    await a.start(ctx)
    for (let i = 0; i < 30 && !(ctx.emit as jest.Mock).mock.calls.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "in-1",
        replyTo: { messageId: "previous-real-id", snippet: "parent" },
      })
    )
    const emitted = (ctx.emit as jest.Mock).mock.calls[0][0]
    expect(inboundReplyLookupIds(emitted)).toEqual(["previous-real-id", "c2c:UO:previous-real-id"])
    expect(
      await resolveInboundReplyTo({
        event: emitted,
        findParent: async (id) =>
          id === "previous-real-id"
            ? { id: "local-parent", parts: [{ type: "text", text: "stored parent" }] }
            : undefined,
      })
    ).toEqual({
      messageId: "local-parent",
      preview: "stored parent",
      platformMessageId: "previous-real-id",
    })
    expect(
      await findQQReference(
        { adapterId: "qq-1", scene: "c2c", sceneId: "UO" },
        { messageId: "in-1" }
      )
    ).toMatchObject({ referenceIndex: "REFIDX_current==" })
    await a.stop()
  })

  it("refuses unavailable or cross-conversation quote indexes before HTTP", async () => {
    await recordQQReference(
      { adapterId: "qq-1", scene: "group", sceneId: "different" },
      "older",
      "REFIDX_other"
    )
    for (const messageId of ["older", "group:different:older"]) {
      const result = await adapter().send(sendReq({ replyTo: { messageId } }))
      expect(result).toMatchObject({ ok: false, error: { code: "validation", retryable: false } })
    }
    expect(httpCalls()).toHaveLength(0)
  })

  it.each(["group", "c2c"] as const)(
    "uploads once and sends native Markdown/media parts in %s order",
    async (scene) => {
      let sent = 0
      mockInvoke.mockImplementation(async (_command: string, args: { req: { url: string } }) =>
        args.req.url.endsWith("/files")
          ? httpResp(200, { file_info: "file" })
          : httpResp(200, { id: `sent-${++sent}` })
      )
      const result = await adapter().send(
        sendReq({
          conversationRef: {
            platform: "qq-official",
            adapterId: "qq-1",
            scene,
            sceneId: "target",
            msgId: "mixed-md",
          },
          segments: [
            { type: "markdown", md: "**before**" },
            { type: "image", url: "https://cdn.example.org/a.png" },
            { type: "markdown", md: "_after_" },
          ],
        })
      )
      expect(result).toMatchObject({ ok: true, platformMessageId: `${scene}:target:sent-3` })
      const calls = httpCalls()
      expect(calls).toHaveLength(4)
      expect(calls[0].url).toMatch(/\/files$/)
      const bodies = calls.slice(1).map((call) => JSON.parse(call.body!) as Record<string, unknown>)
      expect(bodies.map((body) => body.msg_type)).toEqual([2, 7, 2])
      expect(bodies[0].markdown).toEqual({ content: "**before**" })
      expect(bodies[1].media).toEqual({ file_info: "file" })
      expect(bodies[2].markdown).toEqual({ content: "_after_" })
      for (const body of [bodies[0], bodies[2]]) {
        expect(body).not.toHaveProperty("content")
        expect(body).not.toHaveProperty("media")
        expect(body.msg_id).toBe("mixed-md")
      }
      expect(qqPassiveReplyCount("mixed-md")).toBe(3)
    }
  )

  it("rejects an over-budget C2C Markdown/media reply before HTTP or reservations", async () => {
    const result = await adapter().send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "c2c",
          sceneId: "user",
          msgId: "budget-md",
        },
        segments: [
          { type: "markdown", md: "one" },
          { type: "image", url: "https://cdn.example.org/a.png" },
          { type: "markdown", md: "two" },
          { type: "image", url: "https://cdn.example.org/b.png" },
          { type: "markdown", md: "three" },
        ],
      })
    )
    expect(result).toMatchObject({ ok: false, error: { code: "validation", retryable: false } })
    expect(httpCalls()).toHaveLength(0)
    expect(qqPassiveReplyCount("budget-md")).toBe(0)
  })

  it("surfaces native Markdown rejection without silently resending a text alternative", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { err_code: 304036, message: "Markdown denied" }))
    expect(
      await adapter().send(sendReq({ segments: [{ type: "markdown", md: "**answer**" }] }))
    ).toMatchObject({
      ok: false,
      error: { code: "platform_4xx", retryable: false },
    })
    expect(httpCalls()).toHaveLength(1)
    expect(JSON.parse(httpCalls()[0].body!).msg_type).toBe(2)
  })

  it("does not treat HTTP 202 with a provisional id and zero code as delivered", async () => {
    mockInvoke.mockResolvedValue(httpResp(202, { id: "pending-id", err_code: 0 }))
    expect(await adapter().send(sendReq())).toMatchObject({
      ok: false,
      error: { code: "reconciliation_required", retryable: false },
    })
    expect(httpCalls()).toHaveLength(1)
  })

  it("refreshes a repeated HTTP-200 token rejection only once", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { err_code: 11243, message: "invalid token" }))
    const clearTokenCache = jest.fn()
    expect(await adapter({ clearTokenCache }).send(sendReq())).toMatchObject({
      ok: false,
      error: { code: "auth_failed", retryable: false },
    })
    expect(httpCalls()).toHaveLength(2)
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
  })

  it("gates and emits full-group Webhook events using confirmed identity without inventing mentions", async () => {
    const handlers: Array<(event: { payload: unknown }) => void> = []
    const unlisten = jest.fn()
    jest.mocked(listen).mockImplementation(async (_name, handler) => {
      handlers.push(handler as (event: { payload: unknown }) => void)
      return unlisten
    })
    let confirmedIdentity = ""
    const a = adapter({ transportMode: "webhook", selfId: async () => confirmedIdentity })
    const ctx = fakeCtx()
    try {
      await a.start(ctx)
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const mentioned of [false, true]) {
        confirmedIdentity = mentioned ? "bot-openid" : ""
        handlers[0]({
          payload: {
            op: 0,
            t: "GROUP_MESSAGE_CREATE",
            d: {
              id: mentioned ? "mentioned" : "unmentioned",
              group_openid: "group",
              content: "hello",
              mentions: mentioned ? [{ member_openid: "bot-openid" }] : [],
            },
          },
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ctx.emit).toHaveBeenCalledTimes(2)
      expect(
        jest.mocked(ctx.emit).mock.calls.map(([event]) => event.mentions.selfMentioned)
      ).toEqual([false, true])
      expect(gateInboundEvent).toHaveBeenCalledTimes(2)
    } finally {
      await a.stop()
      jest.mocked(listen).mockReset()
    }
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    "subscribes to private-guild events only for explicit opt-in=%s",
    async (enabled) => {
      const a = adapter({ receiveGuildMessages: enabled })
      await startWithDispatch(a, C2C_DISPATCH)
      expect(mockStartGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          intents:
            (1 << 30) | (1 << 25) | (1 << 12) | (1 << 26) | (1 << 24) | (enabled ? 1 << 9 : 0),
        })
      )
      await a.stop()
    }
  )

  it.each([null, [], "bad json", {}])(
    "does not claim delivery for malformed or incomplete success bodies: %j",
    async (body) => {
      mockInvoke.mockResolvedValue(httpResp(200, body))
      expect(await adapter().send(sendReq())).toMatchObject({
        ok: false,
        error: { code: "reconciliation_required", retryable: false },
      })
    }
  )

  it("treats a duplicate rejection as ambiguous delivery without resending", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { err_code: 40054005, message: "duplicate" }))
    expect(await adapter().send(sendReq())).toMatchObject({
      ok: false,
      error: { code: "reconciliation_required", retryable: false },
    })
    expect(httpCalls()).toHaveLength(1)
  })

  it("rejects media-upload business errors before sending or reserving a reply", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { err_code: 850031, message: "too large" }))
    const result = await adapter().send(
      sendReq({ segments: [{ type: "image", url: "https://cdn.example.org/a.png" }] })
    )
    expect(result).toMatchObject({ ok: false, error: { code: "platform_4xx", retryable: false } })
    expect(result.error?.message).toContain("850031")
    expect(httpCalls()).toHaveLength(1)
    expect(httpCalls()[0].url).toContain("/files")
    expect(qqPassiveReplyCount("m1")).toBe(0)
  })

  it.each([200, 400])(
    "rejects HTTP %s err_code failures and preserves body trace_id",
    async (status) => {
      mockInvoke.mockResolvedValue(
        httpResp(status, {
          err_code: 40034005,
          code: 0,
          message: "expired",
          trace_id: "body-trace",
        })
      )
      const result = await adapter().send(sendReq())
      expect(result).toMatchObject({ ok: false, error: { code: "platform_4xx", retryable: false } })
      expect(result.error?.message).toContain("40034005")
      expect(result.error?.message).toContain("body-trace")
      expect(httpCalls()).toHaveLength(1)
    }
  )

  it.each([201, 202])(
    "requires reconciliation for HTTP %s pending message audits",
    async (status) => {
      mockInvoke.mockResolvedValue(
        httpResp(status, { err_code: 304024, message: "awaiting audit", trace_id: "audit-trace" })
      )
      const result = await adapter().send(sendReq())
      expect(result).toMatchObject({
        ok: false,
        error: { code: "reconciliation_required", retryable: false },
      })
      expect(result.error?.message).toContain("audit-trace")
      expect(result.error?.message).toContain("304024")
      expect(httpCalls()).toHaveLength(1)
    }
  )

  it("refreshes an HTTP-200 rejected token once and accepts a definitive send", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(200, { err_code: 11243, message: "bad token" }))
      .mockResolvedValueOnce(httpResp(200, { err_code: 0, id: "sent" }))
    const accessToken = jest.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("fresh")
    const clearTokenCache = jest.fn()
    expect(await adapter({ accessToken, clearTokenCache }).send(sendReq())).toMatchObject({
      ok: true,
      platformMessageId: "group:GO:sent",
    })
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
    expect(httpCalls().map((call) => call.body)).toHaveLength(2)
  })

  it("emits unmentioned full-group input without marking it as addressed to the bot", async () => {
    const a = adapter()
    const ctx = fakeCtx()
    mockStartGateway.mockReturnValue({
      selfId: "bot",
      dispatches: (async function* () {
        yield {
          op: 0,
          t: "GROUP_MESSAGE_CREATE",
          d: { id: "full-input", group_openid: "group", content: "hello all" },
        }
      })(),
    })
    await a.start(ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "full-input",
        mentions: { selfMentioned: false, users: [] },
      })
    )
    await a.stop()
  })

  it("does not emit a stopped run's delayed admission or overwrite restart health", async () => {
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: (value: boolean) => void
    ;(gateInboundEvent as jest.Mock).mockImplementationOnce(() => {
      entered()
      return new Promise<boolean>((resolve) => {
        release = resolve
      })
    })
    mockStartGateway.mockReturnValueOnce({
      selfId: "bot",
      dispatches: (async function* () {
        yield C2C_DISPATCH
      })(),
    })
    const a = adapter(),
      old = fakeCtx(),
      current = fakeCtx()
    await a.start(old)
    await ready
    await a.stop()
    mockStartGateway.mockReturnValueOnce({
      selfId: "bot",
      dispatches: fakeDispatches(() => new Promise(() => {})),
    })
    await a.start(current)
    mockStartGateway.mock.calls[1][0].onHealth({ state: "running" })
    mockStartGateway.mock.calls[0][0].onHealth({ state: "degraded", reason: "stale" })
    release(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      expect(old.emit).not.toHaveBeenCalled()
      expect(current.emit).not.toHaveBeenCalled()
      expect(a.health().state).toBe("running")
    } finally {
      await a.stop()
    }
  })
  it("delivers recalls directly without media download or admission", async () => {
    const a = adapter()
    const context = fakeCtx()
    jest.mocked(gateInboundEvent).mockClear()
    jest.mocked(gateInboundEvent).mockResolvedValueOnce(false)
    let delivered = false
    mockStartGateway.mockReturnValue({
      selfId: "bot",
      dispatches: fakeDispatches(() => {
        if (delivered) return new Promise(() => {})
        delivered = true
        return Promise.resolve({
          done: false,
          value: {
            op: 0,
            t: "PUBLIC_MESSAGE_DELETE",
            d: { message: { id: "parent", channel_id: "channel" } },
          },
        })
      }),
    })
    await a.start(context)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(context.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "delete", replacesMessageId: "parent" })
    )
    expect(httpCalls()).toEqual([])
    expect(gateInboundEvent).not.toHaveBeenCalled()
    await a.stop()
  })
  it.each(["group", "c2c"])(
    "uploads public media before sending a passive %s message",
    async (scene) => {
      mockInvoke
        .mockResolvedValueOnce(httpResp(200, { file_info: "opaque-file", ttl: 3600 }))
        .mockResolvedValueOnce(httpResp(200, { id: "media-sent" }))
      const res = await adapter().send(
        sendReq({
          conversationRef: {
            platform: "qq-official",
            adapterId: "qq-1",
            scene,
            sceneId: "target",
            msgId: "m1",
          },
          segments: [
            { type: "text", text: "caption" },
            { type: "image", url: "https://cdn.example.org/image.png" },
          ],
        })
      )
      expect(res.ok).toBe(true)
      const calls = httpCalls()
      expect(calls[0].url).toBe(
        `https://api.bot.qq.com/v2/${scene === "group" ? "groups" : "users"}/target/files`
      )
      expect(JSON.parse(calls[0].body!)).toEqual({
        file_type: 1,
        url: "https://cdn.example.org/image.png",
        srv_send_msg: false,
      })
      expect(JSON.parse(calls[1].body!)).toMatchObject({
        msg_type: 7,
        content: "caption",
        media: { file_info: "opaque-file" },
        msg_id: "m1",
      })
    }
  )

  it("sends multiple resources in order and requires reconciliation after partial failure", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(200, { file_info: "image" }))
      .mockResolvedValueOnce(httpResp(200, { file_info: "video" }))
      .mockResolvedValueOnce(httpResp(200, { id: "first" }))
      .mockResolvedValueOnce(httpResp(503, { message: "busy" }))
    const result = await adapter().send(
      sendReq({
        segments: [
          { type: "image", url: "https://cdn.example.org/a.png" },
          { type: "text", text: "second caption" },
          { type: "video", url: "https://cdn.example.org/b.mp4" },
        ],
      })
    )
    expect(result).toMatchObject({
      ok: false,
      platformMessageId: "group:GO:first",
      error: { code: "reconciliation_required", retryable: false },
    })
    const payloads = httpCalls().map((call) => JSON.parse(call.body!))
    expect(payloads[2]).toMatchObject({ content: " ", media: { file_info: "image" } })
    expect(payloads[3]).toMatchObject({ content: "second caption", media: { file_info: "video" } })
    expect(payloads[2].msg_seq).not.toBe(payloads[3].msg_seq)
  })

  it("does not consume reply slots when upload fails and retries a fresh upload", async () => {
    const a = adapter()
    const req = sendReq({
      segments: [{ type: "voice", url: "https://cdn.example.org/a.silk", mimeType: "audio/silk" }],
    })
    mockInvoke.mockResolvedValueOnce(httpResp(503, { message: "upload busy" }))
    expect((await a.send(req)).error?.retryable).toBe(true)
    expect(httpCalls()).toHaveLength(1)
    mockInvoke
      .mockResolvedValueOnce(httpResp(200, { file_info: "voice" }))
      .mockResolvedValueOnce(httpResp(200, { id: "voice-sent" }))
    expect((await a.send(req)).ok).toBe(true)
    expect(JSON.parse(httpCalls()[2].body!).msg_seq).toBe(qqPassiveMsgSeq("k"))
  })

  it("uses native image URLs for channel replies and rejects unsupported files before HTTP", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "image" }))
    const result = await adapter().send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "channel",
          sceneId: "channel",
          msgId: "m1",
        },
        segments: [{ type: "image", url: "https://cdn.example.org/a.png" }],
      })
    )
    expect(result.ok).toBe(true)
    expect(JSON.parse(httpCalls()[0].body!)).toMatchObject({
      image: "https://cdn.example.org/a.png",
      msg_id: "m1",
    })
    mockInvoke.mockClear()
    const failed = await adapter().send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "channel",
          sceneId: "channel",
          msgId: "m1",
        },
        segments: [
          {
            type: "file",
            url: "https://cdn.example.org/a.pdf",
            name: "a.pdf",
            mimeType: "application/pdf",
            sizeBytes: 10,
          },
        ],
      })
    )
    expect(failed.error).toMatchObject({ code: "validation", retryable: false })
    expect(mockInvoke).not.toHaveBeenCalled()
  })
  it("exposes correct meta and initial health", () => {
    const a = adapter()
    expect(a.meta.type).toBe("qq-official")
    expect(a.meta.transportModes).toContain("gateway")
    expect(a.meta.capabilities).toContain("send.text")
    expect(a.health().state).toBe("starting")
  })

  it("send() POSTs a group message and returns the scene-qualified message id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "sent-1" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    // Composite `${scene}:${sceneId}:${id}` — delete/reactions need the scene.
    expect(res.platformMessageId).toBe("group:GO:sent-1")
    const req = mockInvoke.mock.calls[0][1].req
    expect(req.url).toContain("/v2/groups/GO/messages")
    expect(req.headers.Authorization).toBe("QQBot tok")
    expect(JSON.parse(req.body)).toMatchObject({
      content: "hello",
      msg_type: 0,
      msg_id: "m1",
      msg_seq: qqPassiveMsgSeq("k"),
    })
  })

  it("send() requires reconciliation when a response has no definitive message id", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, {}))
    const res = await adapter().send(sendReq())
    expect(res).toMatchObject({
      ok: false,
      error: { code: "reconciliation_required", retryable: false },
    })
    expect(res.platformMessageId).toBeUndefined()
  })

  it("send() rejects an unaddressable ref", async () => {
    const res = await adapter().send({
      conversationRef: { platform: "qq-official", adapterId: "qq-1" },
      segments: [{ type: "text", text: "x" }],
      metadata: { idempotencyKey: "k" },
    })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("validation")
  })

  it("retries a 401 once with a fresh token and succeeds", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(401, { message: "token expired" }))
      .mockResolvedValueOnce(httpResp(200, { id: "sent-2" }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("group:GO:sent-2")
    expect(mockInvoke).toHaveBeenCalledTimes(2)
  })

  it("a 401 also evicts the injected token cache before the retry", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(401, { message: "token expired" }))
      .mockResolvedValueOnce(httpResp(200, { id: "sent-2" }))
    const clearTokenCache = jest.fn()
    const res = await adapter({ clearTokenCache }).send(sendReq())
    expect(res.ok).toBe(true)
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
  })

  it("maps a persistent 401 to a non-retryable auth_failed after one retry", async () => {
    mockInvoke.mockResolvedValue(httpResp(401, { message: "bad token", code: 11244 }))
    const a = adapter()
    const res = await a.send(sendReq())
    expect(res.error?.code).toBe("auth_failed")
    expect(res.error?.retryable).toBe(false)
    // Exactly one retry — not an infinite refresh loop.
    expect(mockInvoke).toHaveBeenCalledTimes(2)
    // health() reports the stable code (localized by the Health UI and read by
    // the heartbeat sweep); the platform detail travels on the error message.
    expect(a.health().reason).toBe("auth_failed")
    expect(res.error?.message).toContain("failed: bad token")
  })

  it("maps a 429 to rate_limited", async () => {
    mockInvoke.mockResolvedValue(httpResp(429, { message: "slow" }))
    const res = await adapter().send(sendReq())
    expect(res.error?.code).toBe("rate_limited")
  })

  it("includes the platform code and X-Tps-trace-id in failure messages", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(400, { message: "bad payload", code: 5003 }, { "X-Tps-trace-id": "TRACE-1" })
    )
    const res = await adapter().send(sendReq())
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.message).toContain("(code 5003)")
    expect(res.error?.message).toContain("[trace TRACE-1]")
  })

  it("reads a lowercased x-tps-trace-id header too", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(400, { message: "bad", code: 1 }, { "x-tps-trace-id": "trace-lc" })
    )
    const res = await adapter().send(sendReq())
    expect(res.error?.message).toContain("[trace trace-lc]")
  })

  it("maps code 22009 on a passive reply to a distinct reply-window error", async () => {
    mockInvoke.mockResolvedValue(httpResp(400, { message: "msg limit exceed", code: 22009 }))
    const res = await adapter().send(sendReq())
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe("platform_4xx")
    expect(res.error?.retryable).toBe(false)
    expect(res.error?.message).toContain("reply window")
  })

  it("rejects a proactive send before HTTP dispatch", async () => {
    mockInvoke.mockResolvedValue(httpResp(400, { message: "msg limit exceed", code: 22009 }))
    const res = await adapter().send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "group",
          sceneId: "GO",
        },
      })
    )
    expect(res.error?.code).toBe("validation")
    expect(res.error?.retryable).toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

describe("createQQOfficialAdapter — delete", () => {
  it("recalls a group message via DELETE /v2/groups/{openid}/messages/{id}", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, ""))
    await adapter().delete!("group:GO:sent-1")
    const [call] = httpCalls()
    expect(call.method).toBe("DELETE")
    expect(call.url).toBe("https://api.bot.qq.com/v2/groups/GO/messages/sent-1")
    expect(call.body).toBeUndefined()
  })

  it("recalls c2c / channel / direct messages on their scene endpoints (hidetip on guild)", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, ""))
    const a = adapter()
    await a.delete!("c2c:UO:m1")
    await a.delete!("channel:CH:m2")
    await a.delete!("direct:GUILD:m3")
    const urls = httpCalls().map((c) => c.url.replace("https://api.bot.qq.com", ""))
    expect(urls).toEqual([
      "/v2/users/UO/messages/m1",
      "/channels/CH/messages/m2?hidetip=false",
      "/dms/GUILD/messages/m3?hidetip=false",
    ])
  })

  it("throws on a bare (undecodable) message id without calling the platform", async () => {
    await expect(adapter().delete!("sent-1")).rejects.toThrow(/scene:sceneId:id/)
    expect(httpCalls()).toHaveLength(0)
  })

  it("retries a 401 once with a fresh token, then surfaces the failure", async () => {
    mockInvoke
      .mockResolvedValueOnce(httpResp(401, { message: "expired" }))
      .mockResolvedValueOnce(httpResp(200, ""))
    await expect(adapter().delete!("group:GO:m1")).resolves.toBeUndefined()
    expect(httpCalls()).toHaveLength(2)

    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(httpResp(404, { message: "gone", code: 50006 }))
    await expect(adapter().delete!("group:GO:m1")).rejects.toThrow(/gone \(code 50006\)/)
  })
})

describe("createQQOfficialAdapter — reactions (channel scene only)", () => {
  it("addReaction PUTs /channels/{c}/messages/{m}/reactions/{type}/{id} and returns the emoji as reactionId", async () => {
    mockInvoke.mockResolvedValue(httpResp(204, ""))
    const ref = await adapter().addReaction!("channel:CH:m9", "1:4")
    const [call] = httpCalls()
    expect(call.method).toBe("PUT")
    expect(call.url).toBe("https://api.bot.qq.com/channels/CH/messages/m9/reactions/1/4")
    expect(ref).toEqual({ reactionId: "1:4" })
  })

  it("removeReaction DELETEs the same path", async () => {
    mockInvoke.mockResolvedValue(httpResp(204, ""))
    await adapter().removeReaction!("channel:CH:m9", "2:128512")
    const [call] = httpCalls()
    expect(call.method).toBe("DELETE")
    expect(call.url).toBe("https://api.bot.qq.com/channels/CH/messages/m9/reactions/2/128512")
  })

  it("throws unsupported for non-channel scenes and on malformed ids / emoji", async () => {
    const a = adapter()
    await expect(a.addReaction!("group:GO:m1", "1:4")).rejects.toThrow(/unsupported/)
    await expect(a.removeReaction!("c2c:UO:m1", "1:4")).rejects.toThrow(/unsupported/)
    await expect(a.addReaction!("m1", "1:4")).rejects.toThrow(/scene:sceneId:id/)
    await expect(a.addReaction!("channel:CH:m1", "👍")).rejects.toThrow(/<type>:<id>/)
    expect(httpCalls()).toHaveLength(0)
  })
})

describe("createQQOfficialAdapter — typing (c2c only)", () => {
  it("sends a msg_type 6 input_notify passive reply for a fresh c2c inbound", async () => {
    const a = adapter()
    await startWithDispatch(a, C2C_DISPATCH)
    mockInvoke.mockResolvedValue(httpResp(200, { id: "typing-ack" }))
    await a.setTyping!("qq-official:qq-1:UO", true)
    const [call] = httpCalls()
    expect(call.method).toBe("POST")
    expect(call.url).toBe("https://api.bot.qq.com/v2/users/UO/messages")
    const body = JSON.parse(call.body!) as Record<string, unknown>
    expect(body).toMatchObject({
      msg_type: 6,
      input_notify: { input_type: 1, input_second: 60 },
      msg_id: "in-1",
    })
    expect(typeof body.msg_seq).toBe("number")
    // The indicator consumed one passive slot of the inbound msg_id …
    expect(qqPassiveReplyCount("in-1")).toBe(1)
    // … with a seq that cannot collide with a reply's idempotency-derived seq.
    expect(body.msg_seq).not.toBe(qqPassiveMsgSeq("k"))
    await a.stop()
  })

  it("is a no-op for on=false, unknown conversations and non-c2c scenes", async () => {
    const a = adapter()
    await startWithDispatch(a, {
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "g-1", content: "hi", group_openid: "GO" },
    })
    await a.setTyping!("qq-official:qq-1:GO", true)
    await a.setTyping!("qq-official:qq-1:UO", true)
    await a.setTyping!("qq-official:qq-1:UO", false)
    expect(httpCalls()).toHaveLength(0)
    await a.stop()
  })

  it("reserves the fourth C2C slot for the final reply and respects expiry", async () => {
    const a = adapter()
    await startWithDispatch(a, C2C_DISPATCH)
    mockInvoke.mockResolvedValue(httpResp(200, {}))
    for (let i = 0; i < 6; i++) await a.setTyping!("qq-official:qq-1:UO", true)
    // Slots 1..3 fired; the fourth slot is reserved for the real reply.
    expect(httpCalls()).toHaveLength(3)
    expect(qqPassiveReplyCount("in-1")).toBe(3)
    mockInvoke.mockResolvedValue(httpResp(200, { id: "final" }))
    expect(
      await a.send(
        sendReq({
          conversationRef: {
            platform: "qq-official",
            adapterId: "qq-1",
            scene: "c2c",
            sceneId: "UO",
            msgId: "in-1",
          },
        })
      )
    ).toMatchObject({ ok: true, platformMessageId: "c2c:UO:final" })
    expect(qqPassiveReplyCount("in-1")).toBe(4)

    // Fresh adapter, expired window → no-op.
    __resetQQMsgSeqForTesting()
    mockInvoke.mockReset()
    mockStartGateway.mockReset()
    const b = adapter()
    const now = Date.now()
    const dateSpy = jest.spyOn(Date, "now").mockReturnValue(now)
    await startWithDispatch(b, C2C_DISPATCH)
    dateSpy.mockReturnValue(now + 61 * 60_000)
    await b.setTyping!("qq-official:qq-1:UO", true)
    expect(httpCalls()).toHaveLength(0)
    dateSpy.mockRestore()
    await a.stop()
    await b.stop()
  })
})

describe("createQQOfficialAdapter — credentials", () => {
  it("refreshCredentials() evicts the injected token cache", async () => {
    const clearTokenCache = jest.fn()
    await adapter({ clearTokenCache }).refreshCredentials!()
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
    // Without an injected evictor it is a harmless no-op.
    await expect(adapter().refreshCredentials!()).resolves.toBeUndefined()
  })

  it("wires clearTokenCache into the gateway's onAuthInvalid", async () => {
    const clearTokenCache = jest.fn()
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => new Promise(() => {})),
    })
    const a = adapter({ clearTokenCache })
    await a.start(fakeCtx())
    const gatewayOpts = mockStartGateway.mock.calls[0][0] as { onAuthInvalid?: () => unknown }
    expect(typeof gatewayOpts.onAuthInvalid).toBe("function")
    await gatewayOpts.onAuthInvalid!()
    expect(clearTokenCache).toHaveBeenCalledTimes(1)
    await a.stop()
  })

  it("declares delete / typing / send.reaction and no edit or history", () => {
    const a = adapter()
    expect(a.meta.capabilities).toEqual(
      expect.arrayContaining(["delete", "typing", "send.reaction"])
    )
    expect(a.meta.capabilities).not.toContain("edit")
    expect(a.meta.capabilities).not.toContain("history.fetch")
    expect(a.edit).toBeUndefined()
    expect(a.fetchHistory).toBeUndefined()
  })
})

describe("createQQOfficialAdapter — health reason", () => {
  it("marks degraded with a reason when the gateway loop throws", async () => {
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => Promise.reject(new Error("gateway blew up"))),
    })
    const a = adapter()
    await a.start(fakeCtx())
    await new Promise((r) => setTimeout(r, 0))
    expect(a.health().state).toBe("degraded")
    expect(a.health().reason).toContain("gateway blew up")
  })

  it("marks down with a reason when the gateway stream ends without stop()", async () => {
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => Promise.resolve({ done: true, value: undefined })),
    })
    const a = adapter()
    await a.start(fakeCtx())
    await new Promise((r) => setTimeout(r, 0))
    expect(a.health().state).toBe("down")
    expect(a.health().reason).toContain("ended unexpectedly")
  })

  it("clears the reason on a clean stop() and on a later successful send", async () => {
    mockStartGateway.mockReturnValue({
      selfId: "",
      dispatches: fakeDispatches(() => new Promise(() => {})),
    })
    const a = adapter()
    await a.start(fakeCtx())
    mockStartGateway.mock.calls[0][0].onHealth({ state: "running" })
    expect(a.health().state).toBe("running")

    mockInvoke.mockResolvedValue(httpResp(401, { message: "rotated" }))
    await a.send(sendReq())
    expect(a.health().reason).toBeDefined()

    mockInvoke.mockResolvedValue(httpResp(200, { id: "ok-1" }))
    await a.send(sendReq())
    expect(a.health().reason).toBeUndefined()

    await a.stop()
    expect(a.health()).toMatchObject({ state: "down" })
    expect(a.health().reason).toBeUndefined()
  })
})

it("propagates all QQ text alternatives across native media parts", async () => {
  mockInvoke
    .mockResolvedValueOnce(httpResp(200, { file_info: "uploaded" }))
    .mockResolvedValueOnce(httpResp(200, { id: "sent1" }))
    .mockResolvedValueOnce(httpResp(200, { id: "sent2" }))
  const result = await adapter().send(
    sendReq({
      segments: [
        { type: "mention", userId: "u", displayName: "Alice" },
        { type: "image", url: "https://example.com/a.jpg" },
        { type: "reply", messageId: "prior", snippet: "context" },
        { type: "poll", question: "Pick", options: ["A", "B"] },
        { type: "location", lat: 1, lon: 2, name: "Office" },
      ],
    })
  )
  expect(result).toMatchObject({
    ok: true,
    downgrades: [
      { from: "mention", to: "text" },
      { from: "reply", to: "text" },
      { from: "poll", to: "text" },
      { from: "location", to: "text" },
    ],
  })
  const calls = httpCalls()
  expect(JSON.parse(calls[1].body!)).toMatchObject({
    msg_type: 7,
    content: "@Alice",
    media: { file_info: "uploaded" },
  })
  expect(JSON.parse(calls[2].body!).content).toContain("Office")
})
it("rejects a trailing QQ opaque card before any upload or send", async () => {
  const result = await adapter().send(
    sendReq({
      segments: [
        { type: "image", url: "https://example.com/a.jpg" },
        { type: "card", card: { kind: "custom", payload: { title: "x" } } },
      ],
    })
  )
  expect(result).toMatchObject({ ok: false, error: { code: "validation", retryable: false } })
  expect(httpCalls()).toEqual([])
  expect(qqPassiveReplyCount("m1")).toBe(0)
})

const keyboardSurface = {
  type: "a2ui" as const,
  surfaceId: "qq-controls",
  plainTextMirror: "Choose [Approve]",
  content: {
    rootId: "root",
    dataModel: {},
    components: {
      root: { component: "Column", children: ["body", "approve"] },
      body: { component: "Text", text: "Choose" },
      approve: { component: "Button", text: "Approve", action: "approve" },
    },
  },
}

function welcomeSegment(commands = false, surfaceId = "welcome:qq-test") {
  return buildA2UISegment(
    surfaceId,
    buildHelpSurface({
      surfaceId,
      mode: "welcome",
      displayName: "Private adapter name",
      welcomeText: "你好，直接描述任务即可。",
      quickCommands: commands
        ? [
            {
              triggerKey: "tasks",
              label: "查看待办",
              action: { type: "prompt", value: "列出待办" },
            },
          ]
        : [],
    })
  )
}

it.each([
  ["group", false],
  ["group", true],
  ["c2c", false],
  ["c2c", true],
] as const)(
  "delivers the composed %s welcome with Markdown and confirmed bindings (%s)",
  async (scene, commands) => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "welcome-message" }))
    const result = await adapter().send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene,
          sceneId: "target",
          msgId: "trigger",
        },
        segments: [welcomeSegment(commands)],
      })
    )
    expect(result).toMatchObject({ ok: true, platformMessageId: `${scene}:target:welcome-message` })
    expect(httpCalls()).toHaveLength(1)
    const body = JSON.parse(httpCalls()[0]!.body!)
    expect(body).toMatchObject({
      msg_type: 2,
      msg_id: "trigger",
      markdown: { content: expect.stringContaining("## 👋 开始一个新任务") },
    })
    expect(body.markdown.content).toContain("\n\n你好，直接描述任务即可。\n\n**快捷指令**")
    expect(body).not.toHaveProperty("content")
    expect(body.markdown.content).not.toContain("Private adapter name")
    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings).toHaveLength(commands ? 1 : 0)
    if (commands) {
      expect(body.markdown.content).not.toContain("查看待办")
      expect(bindings[0]).toMatchObject({
        kind: "help_quick_command",
        conversationKey: "qq-official:qq-1:target",
        payload: {
          action: { type: "prompt", value: "列出待办" },
          qqKeyboard: { messageId: "welcome-message", scene, sceneId: "target" },
        },
      })
    }
  }
)

it("does not authorize welcome buttons after an uncertain provider result", async () => {
  mockInvoke.mockRejectedValue(new Error("Connection lost after POST"))
  const result = await adapter().send(sendReq({ segments: [welcomeSegment(true)] }))
  expect(result.ok).toBe(false)
  expect(httpCalls()).toHaveLength(1)
  expect(await getDb().connectorCallbackBindings.count()).toBe(0)
})

it.each(["group", "c2c"] as const)(
  "round-trips shared %s welcome commands once and keeps a fresh card clickable",
  async (scene) => {
    const { createAdapterInstance } = await import("@/lib/db/adapter-instances")
    const row = await createAdapterInstance({
      type: "qq-official",
      displayName: "Command test",
      enabled: true,
      transportMode: "gateway",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      mediaModelPolicy: "local_extract_only",
      defaultMode: "auto",
      welcomeCardEnabled: false,
      trigger: {
        rules: [{ kind: "private-default" }, { kind: "self-mention" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
    })
    const a = adapter({ id: row.id }),
      bus = getBus(),
      routeHandler = jest.fn()
    bus.registerAdapter(a)
    bus.routeHandler = routeHandler
    mockInvoke.mockResolvedValue(httpResp(200, { id: "command-card" }))
    const tokens: string[] = []
    try {
      for (const ordinal of [0, 1]) {
        expect(
          (
            await a.send(
              sendReq({
                conversationRef: {
                  platform: "qq-official",
                  adapterId: row.id,
                  scene,
                  sceneId: "target",
                  msgId: `source-${ordinal}`,
                },
                segments: [welcomeSegment(true, `welcome:command-${ordinal}`)],
                metadata: { idempotencyKey: `command-${ordinal}` },
              })
            )
          ).ok
        ).toBe(true)
        const button = JSON.parse(httpCalls().at(-1)!.body!).keyboard.content.rows[0].buttons[0]
        tokens.push(button.action.data)
        const callback = await resolveQQInteraction(row.id, "bot", {
          id: `press-${ordinal}`,
          scene,
          sceneId: "target",
          actorId: scene === "c2c" ? "target" : "member",
          buttonData: button.action.data,
          buttonId: button.id,
          messageId: "command-card",
          timestamp: Date.now(),
        })
        expect(callback).not.toBeNull()
        await bus.dispatchConnectorCallback(callback!)
        await bus.dispatchConnectorCallback(callback!)
        await bus.flushInboundTurns()
        expect(routeHandler).toHaveBeenCalledTimes(ordinal + 1)
      }
      expect(new Set(tokens).size).toBe(2)
      expect(routeHandler.mock.calls.every(([event]) => event.plainText === "列出待办")).toBe(true)
      expect(
        routeHandler.mock.calls.every(
          ([event]) =>
            event.conversationRef.scene === scene && event.conversationRef.sceneId === "target"
        )
      ).toBe(true)
    } finally {
      await a.stop()
    }
  }
)

it.each(["multipart", "stream-final"] as const)(
  "keeps real QQ %s uncertainty non-replayable across an outbound runner restart",
  async (kind) => {
    const a = adapter()
    let posts = 0
    mockInvoke.mockImplementation(async (command: string) => {
      if (command !== "connectors_http_request") return undefined
      if (++posts === 1) return httpResp(200, { id: "known-first-part" })
      throw new Error("Synthetic connection loss after POST")
    })
    const request = sendReq({
      conversationRef: {
        platform: "qq-official",
        adapterId: "qq-1",
        scene: "c2c",
        sceneId: "target",
        msgId: "trigger",
        receivedAt: Date.now(),
      },
      metadata: { idempotencyKey: `unknown-${kind}`, streamKey: "complex-turn" },
      segments:
        kind === "multipart"
          ? [{ type: "markdown", md: "Part one" }, keyboardSurface]
          : [{ type: "markdown", md: "Partial complete" }],
    })
    if (kind === "stream-final")
      await a.streamReply!({
        conversationRef: request.conversationRef,
        streamKey: "complex-turn",
        text: "Partial",
      })
    const { getConnectorDeliveryGateway } = await import("@/lib/connectors/delivery-gateway")
    const { startOutboundRunner } = await import("@/lib/connectors/outbound-runner")
    const { waitForOutboundTerminal } = await import("@/lib/db/outbound-jobs")
    const job = await getConnectorDeliveryGateway().enqueue({
      adapterId: a.id,
      conversationKey: "qq-official:qq-1:target",
      request,
      source: "manual",
    })
    const controller = new AbortController()
    const running = startOutboundRunner({
      adapters: new Map([[a.id, a]]),
      signal: controller.signal,
      pollIntervalMs: 10,
    })
    try {
      expect(await waitForOutboundTerminal(job.id, 3000)).toMatchObject({
        status: "delivery_unknown",
        lastErrorCode: "delivery_unknown",
      })
    } finally {
      controller.abort()
      await running
      await a.stop()
    }
    const beforeRestart = httpCalls().length
    expect(beforeRestart).toBe(2)
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
    if (kind === "multipart")
      expect(
        await wasDeliveredByUs("qq-1", "qq-official:qq-1:target", "c2c:target:known-first-part")
      ).toBe(true)
    else
      expect(
        (await getDb().inboundLedger.where("namespace").equals("qq-stream").first())?.qqStream
      ).toMatchObject({ messageId: "known-first-part", phase: "uncertain" })
    const restored = adapter()
    const restartedController = new AbortController()
    let observations = 0
    await startOutboundRunner({
      adapters: new Map([[restored.id, restored]]),
      signal: restartedController.signal,
      pollIntervalMs: 10,
      onSchedulerState: () => {
        if (++observations >= 3) restartedController.abort()
      },
    })
    expect(observations).toBeGreaterThanOrEqual(3)
    expect(httpCalls()).toHaveLength(beforeRestart)
    expect(await getDb().outboundQueue.get(job.id)).toMatchObject({ status: "delivery_unknown" })
    await restored.stop()
  }
)

it.each(["group", "c2c"] as const)(
  "sends %s A2UI buttons as native keyboard content",
  async (scene) => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "keyboard-message" }))
    const result = await adapter().send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene,
          sceneId: "target",
          msgId: "trigger",
        },
        segments: [keyboardSurface],
      })
    )
    expect(result.ok).toBe(true)
    const payload = JSON.parse(httpCalls()[0]!.body!)
    expect(payload.keyboard.content.rows[0].buttons[0]).toMatchObject({
      render_data: { label: "Approve" },
      action: { type: 1, permission: { type: 2 } },
    })
    expect(payload.keyboard.content.rows[0].buttons[0].action.data).toMatch(/^qqkb:/)
    expect(payload.msg_id).toBe("trigger")
  }
)

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  expect(predicate()).toBe(true)
}

it.each(["group", "c2c"] as const)(
  "round-trips %s native buttons through the real callback bus and acknowledges before work finishes",
  async (scene) => {
    mockInvoke.mockImplementation(async (command: string, args: { req?: { method?: string } }) => {
      if (command === "connectors_http_request")
        return args.req?.method === "PUT"
          ? httpResp(204, "")
          : httpResp(200, { id: "sent-keyboard" })
      return undefined
    })
    const a = adapter()
    await a.send(
      sendReq({
        conversationRef: {
          platform: "qq-official",
          adapterId: "qq-1",
          scene,
          sceneId: "target",
          msgId: "trigger",
        },
        segments: [keyboardSurface],
      })
    )
    const buttonData = JSON.parse(httpCalls()[0]!.body!).keyboard.content.rows[0].buttons[0].action
      .data
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const handler = jest.fn(async () => pending)
    getBus().callbackHandler = handler
    const ctx = fakeCtx()
    const dispatch = {
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        id: "press-one",
        type: 11,
        scene,
        chat_type: scene === "group" ? 1 : 2,
        group_openid: scene === "group" ? "target" : undefined,
        group_member_openid: scene === "group" ? "owner" : undefined,
        user_openid: scene === "c2c" ? "target" : undefined,
        timestamp: new Date().toISOString(),
        data: { type: 11, resolved: { button_data: buttonData, button_id: "b0" } },
      },
    }
    let sequence = 0
    mockStartGateway.mockReturnValue({
      selfId: "bot",
      dispatches: fakeDispatches(() =>
        sequence++ < 2 ? Promise.resolve({ done: false, value: dispatch }) : new Promise(() => {})
      ),
    })
    await a.start(ctx)
    try {
      await until(() => httpCalls().some((call) => call.method === "PUT"))
      expect(handler).toHaveBeenCalledTimes(1)
      expect(ctx.emit).not.toHaveBeenCalled()
      const ack = httpCalls().filter((call) => call.method === "PUT")
      expect(ack).toHaveLength(1)
      expect(ack[0]!.url).toMatch(/interactions\/press-one$/)
      expect(JSON.parse(ack[0]!.body!)).toEqual({ code: 0 })
      const event = (handler.mock.calls as unknown[][])[0]![0] as {
        deliveryTarget: { conversationRef: unknown }
      }
      expect(event.deliveryTarget.conversationRef).toMatchObject({
        scene,
        sceneId: "target",
        eventId: "press-one",
      })
      expect(
        (await getDb().connectorConversationStates.get("qq-official:qq-1:target"))?.deliveryTarget
          ?.conversationRef.eventId
      ).toBe("press-one")
    } finally {
      finish()
      await a.stop()
      await new Promise((r) => setTimeout(r, 5))
    }
  }
)

it("refuses blocked callback chats before bus dispatch and returns denied acknowledgement", async () => {
  mockInvoke.mockResolvedValue(httpResp(200, { id: "sent-keyboard" }))
  const a = adapter()
  await a.send(sendReq({ segments: [keyboardSurface] }))
  const buttonData = JSON.parse(httpCalls()[0]!.body!).keyboard.content.rows[0].buttons[0].action
    .data
  const handler = jest.fn(async () => undefined)
  getBus().callbackHandler = handler
  jest.mocked(gateInboundEvent).mockResolvedValue(false)
  await startWithDispatch(a, {
    op: 0,
    t: "INTERACTION_CREATE",
    d: {
      id: "blocked",
      type: 11,
      scene: "group",
      group_openid: "GO",
      group_member_openid: "user",
      timestamp: new Date().toISOString(),
      data: { type: 11, resolved: { button_data: buttonData } },
    },
  })
  try {
    await until(() => httpCalls().some((call) => call.method === "PUT"))
    expect(handler).not.toHaveBeenCalled()
    expect(JSON.parse(httpCalls().find((call) => call.method === "PUT")!.body!)).toEqual({
      code: 4,
    })
  } finally {
    await a.stop()
  }
})

it("creates no callback receipt for an unconfirmed native keyboard send", async () => {
  mockInvoke.mockResolvedValue(httpResp(202, { id: "pending" }))
  const result = await adapter().send(sendReq({ segments: [keyboardSurface] }))
  expect(result.ok).toBe(false)
  expect(await getDb().connectorCallbackBindings.count()).toBe(0)
})

it("retries the same interaction after a transient bus failure without acknowledging twice", async () => {
  mockInvoke.mockResolvedValue(httpResp(200, { id: "sent" }))
  const a = adapter()
  await a.send(sendReq({ segments: [keyboardSurface] }))
  const token = JSON.parse(httpCalls()[0]!.body!).keyboard.content.rows[0].buttons[0].action.data
  const dispatch = {
    op: 0,
    t: "INTERACTION_CREATE",
    d: {
      id: "retry-press",
      type: 11,
      scene: "group",
      group_openid: "GO",
      group_member_openid: "user",
      timestamp: new Date().toISOString(),
      data: { type: 11, resolved: { button_data: token } },
    },
  }
  let nextDelivery!: (value: IteratorResult<unknown>) => void
  let initial = true
  mockStartGateway.mockReturnValue({
    selfId: "bot",
    dispatches: fakeDispatches(() => {
      if (initial) {
        initial = false
        return Promise.resolve({ done: false, value: dispatch })
      }
      return new Promise((resolve) => {
        nextDelivery = resolve
      })
    }),
  })
  const bus = getBus()
  const spy = jest
    .spyOn(bus, "dispatchConnectorCallback")
    .mockImplementationOnce(async (_event, options) => {
      options?.onDecision?.({ status: "failed" })
      return "retry"
    })
    .mockImplementationOnce(async (_event, options) => {
      options?.onDecision?.({ status: "accepted", kind: "generic" })
      return "terminal"
    })
  try {
    await a.start(fakeCtx())
    await until(
      () => spy.mock.calls.length === 1 && httpCalls().some((call) => call.method === "PUT")
    )
    await new Promise((r) => setTimeout(r, 5))
    nextDelivery({ done: false, value: dispatch })
    await until(() => spy.mock.calls.length === 2)
    expect(httpCalls().filter((call) => call.method === "PUT")).toHaveLength(1)
  } finally {
    await a.stop()
    spy.mockRestore()
  }
})

it.each(["group", "c2c"] as const)(
  "preserves %s Markdown, keyboard, media, quote and aggregate passive preflight",
  async (scene) => {
    let sequence = 0
    mockInvoke.mockImplementation(async (_command: string, args: { req: { url: string } }) =>
      args.req.url.endsWith("/files")
        ? httpResp(200, { file_info: "uploaded" })
        : httpResp(200, { id: `part-${++sequence}` })
    )
    const a = adapter()
    const input = sendReq({
      conversationRef: {
        platform: "qq-official",
        adapterId: "qq-1",
        scene,
        sceneId: "target",
        msgId: "trigger",
        qqMsgIndex: "REFIDX_current==",
        receivedAt: Date.now(),
      },
      replyTo: { messageId: "trigger" },
      segments: [
        { type: "markdown", md: "**Before**" },
        keyboardSurface,
        { type: "image", url: "https://cdn.example.org/image.png" },
        { type: "text", text: "after" },
      ],
    })
    expect((await a.send(input)).ok).toBe(true)
    const sends = httpCalls()
      .filter((call) => call.url.endsWith("/messages"))
      .map((call) => JSON.parse(call.body!))
    expect(sends.map((call) => call.msg_type)).toEqual([2, 2, 7, 0])
    expect(sends[1]!.markdown).toEqual({ content: "Choose" })
    expect(sends[1]).not.toHaveProperty("content")
    expect(sends[1]!.keyboard).toBeDefined()
    expect(sends[0]!.keyboard).toBeUndefined()
    expect(sends[2]!.media).toEqual({ file_info: "uploaded" })
    for (const call of sends)
      expect(call.message_reference).toEqual({ message_id: "REFIDX_current==" })
    const priorCalls = httpCalls().length
    const refused = await a.send({ ...input, metadata: { idempotencyKey: "over-cap" } })
    expect(refused.ok).toBe(false)
    expect(httpCalls()).toHaveLength(priorCalls)
  }
)

it("keeps transient authored-binding storage failures retryable without a native call or consumed slot", async () => {
  await recordCallbackBinding({
    adapterId: "qq-1",
    actionId: "wfapp:storage-test",
    kind: "wf_approve",
    surfaceId: "qq-controls",
    componentId: "approve",
    conversationKey: "qq-official:qq-1:GO",
  })
  const content = {
    ...keyboardSurface.content,
    components: {
      ...keyboardSurface.content.components,
      approve: { ...keyboardSurface.content.components.approve, value: "wfapp:storage-test" },
    },
  }
  const input = sendReq({ segments: [{ ...keyboardSurface, content }] })
  const a = adapter()
  const where = jest
    .spyOn(getDb().connectorCallbackBindings, "where")
    .mockImplementationOnce(() => {
      throw new Error("temporary storage read failure")
    })
  try {
    const failed = await a.send(input)
    expect(failed).toMatchObject({ ok: false, error: { retryable: true } })
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(qqPassiveReplyCount("m1")).toBe(0)
  } finally {
    where.mockRestore()
  }
  mockInvoke.mockResolvedValue(httpResp(200, { id: "recovered" }))
  expect((await a.send(input)).ok).toBe(true)
})

it("retains the confirmed platform ID if the keyboard receipt write fails", async () => {
  mockInvoke.mockResolvedValue(httpResp(200, { id: "confirmed-keyboard" }))
  const write = jest
    .spyOn(getDb().connectorCallbackBindings, "bulkPut")
    .mockRejectedValueOnce(new Error("temporary receipt write failure"))
  try {
    const result = await adapter().send(sendReq({ segments: [keyboardSurface] }))
    expect(result).toMatchObject({
      ok: false,
      platformMessageId: "group:GO:confirmed-keyboard",
      error: { code: "reconciliation_required", retryable: false },
    })
    expect(httpCalls()).toHaveLength(1)
  } finally {
    write.mockRestore()
  }
})

it.each([
  ["message", 1000],
  ["interaction", 1000],
  ["message", 0],
  ["interaction", 0],
  ["message", 1],
] as const)(
  "streams a native C2C %s reply with reported length %s and completes the same message through send",
  async (source, remaining) => {
    mockInvoke.mockResolvedValue(
      httpResp(200, {
        id: "server-stream",
        remain_msg_len: remaining,
        ext_info: { ref_idx: "REFIDX_stream==" },
      })
    )
    const a = adapter()
    const conversationRef = {
      platform: "qq-official" as const,
      adapterId: "qq-1",
      scene: "c2c",
      sceneId: "target",
      receivedAt: Date.now(),
      ...(source === "message" ? { msgId: "source" } : { eventId: "source" }),
    }
    expect(typeof a.streamReply).toBe("function")
    await a.streamReply!({ conversationRef, streamKey: "turn-one", text: "Hello" })
    const result = await a.send(
      sendReq({
        conversationRef,
        metadata: { idempotencyKey: "final-one", streamKey: "turn-one" },
        segments: [{ type: "markdown", md: "Hello world" }],
      })
    )
    expect(result).toMatchObject({ ok: true, platformMessageId: "c2c:target:server-stream" })
    const calls = httpCalls()
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.url.endsWith("/v2/users/target/stream_messages"))).toBe(true)
    const frames = calls.map((call) => JSON.parse(call.body!))
    expect(frames.map((frame) => frame.index)).toEqual([0, 1])
    expect(frames.map((frame) => frame.input_state)).toEqual([1, 10])
    expect(frames[1]).toMatchObject({
      input_mode: "replace",
      content_raw: "Hello world",
      stream_msg_id: "server-stream",
      msg_seq: frames[0].msg_seq,
    })
    expect(frames[0]).toHaveProperty(source === "message" ? "msg_id" : "event_id", "source")
    expect(frames[0]).not.toHaveProperty(source === "message" ? "event_id" : "msg_id")
    expect(qqPassiveReplyCount(source === "message" ? "source" : "event:source")).toBe(1)
  }
)

describe("native C2C stream adapter lifecycle regressions", () => {
  const captured = () => ({
    platform: "qq-official" as const,
    adapterId: "qq-1",
    scene: "c2c",
    sceneId: "target",
    msgId: "lifecycle-source",
    receivedAt: Date.now(),
  })
  const finalFor = (conversationRef: ReturnType<typeof captured>) =>
    sendReq({
      conversationRef,
      metadata: { idempotencyKey: "lifecycle-final", streamKey: "lifecycle-turn" },
      segments: [{ type: "markdown", md: "Hello world" }],
    })

  it.each([200, 429])(
    "cancels an in-flight ACK and retains the tombstone after close HTTP %s",
    async (closeStatus) => {
      let entered!: () => void, release!: () => void
      const atHttp = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const a = adapter(),
        conversationRef = captured()
      mockInvoke
        .mockImplementationOnce(async () => {
          entered()
          await gate
          return httpResp(200, { id: "cancelled-server" })
        })
        .mockResolvedValue(httpResp(closeStatus, { id: "cancelled-server" }))
      const partial = { conversationRef, streamKey: "lifecycle-turn", text: "Hello" }
      const preview = a.streamReply!(partial)
      try {
        await atHttp
        const cancelling = a.cancelStreamReply!(partial)
        const outcome = cancelling.then(
          () => null,
          (error: unknown) => error
        )
        release()
        await preview
        if (closeStatus === 429) expect(await outcome).toBeInstanceOf(Error)
        else expect(await outcome).toBeNull()
        await a.streamReply!({ ...partial, text: "Hello unsafe late content" })
        expect(await a.send(finalFor(conversationRef))).toMatchObject({
          ok: false,
          error: { code: "validation" },
        })
        await a.stop()
        expect(await adapter().send(finalFor(conversationRef))).toMatchObject({
          ok: false,
          error: { code: "validation" },
        })
        const frames = httpCalls().map((call) => JSON.parse(call.body!))
        expect(frames).toHaveLength(2)
        expect(frames.map((frame) => [frame.index, frame.input_state])).toEqual([
          [0, 1],
          [1, 10],
        ])
        expect(frames[1]).toMatchObject({
          stream_msg_id: "cancelled-server",
          content_raw: "Hello",
          msg_seq: frames[0].msg_seq,
        })
        expect(httpCalls().every((call) => call.url.endsWith("/stream_messages"))).toBe(true)
        expect(
          (await getDb().inboundLedger.where("namespace").equals("qq-stream").first())?.qqStream
            ?.phase
        ).toBe("cancelled")
        expect(qqPassiveReplyCount("lifecycle-source")).toBe(1)
      } finally {
        release()
        await a.stop()
      }
    }
  )

  it("continues the same acknowledged stream after adapter stop/start and replays final locally", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { id: "restarted-server" }))
    const a = adapter(),
      conversationRef = captured()
    await a.streamReply!({ conversationRef, streamKey: "lifecycle-turn", text: "Hello" })
    await a.stop()
    await expect(
      a.streamReply!({ conversationRef, streamKey: "lifecycle-turn", text: "Hello stale" })
    ).rejects.toThrow(/unavailable/)
    expect(httpCalls()).toHaveLength(1)
    await startWithDispatch(a, C2C_DISPATCH)
    try {
      expect(await a.send(finalFor(conversationRef))).toMatchObject({
        ok: true,
        platformMessageId: "c2c:target:restarted-server",
      })
      await a.stop()
      expect(await adapter().send(finalFor(conversationRef))).toMatchObject({
        ok: true,
        platformMessageId: "c2c:target:restarted-server",
      })
      const frames = httpCalls().map((call) => JSON.parse(call.body!))
      expect(frames).toHaveLength(2)
      expect(frames[1]).toMatchObject({
        index: 1,
        input_state: 10,
        stream_msg_id: "restarted-server",
        msg_seq: frames[0].msg_seq,
      })
      expect(qqPassiveReplyCount("lifecycle-source")).toBe(1)
    } finally {
      await a.stop()
    }
  })

  it.each(["pending", "missing-id", "changed-id", "timeout"])(
    "does not resend an ambiguous %s final through a rebuilt adapter",
    async (fault) => {
      const a = adapter(),
        conversationRef = captured()
      mockInvoke.mockResolvedValueOnce(httpResp(200, { id: "known-server" }))
      await a.streamReply!({ conversationRef, streamKey: "lifecycle-turn", text: "Hello" })
      if (fault === "timeout") mockInvoke.mockRejectedValueOnce(new Error("ACK connection lost"))
      else
        mockInvoke.mockResolvedValueOnce(
          httpResp(fault === "pending" ? 202 : 200, {
            ...(fault === "missing-id"
              ? {}
              : { id: fault === "changed-id" ? "different-server" : "known-server" }),
          })
        )
      try {
        const request = finalFor(conversationRef)
        expect(await a.send(request)).toMatchObject({
          ok: false,
          error: { code: "reconciliation_required", retryable: false },
        })
        await a.stop()
        expect(await adapter().send(request)).toMatchObject({
          ok: false,
          error: { code: "reconciliation_required", retryable: false },
        })
        const calls = httpCalls()
        expect(calls).toHaveLength(2)
        expect(calls.every((call) => call.url.endsWith("/stream_messages"))).toBe(true)
        expect(JSON.parse(calls[1].body!)).toMatchObject({
          stream_msg_id: "known-server",
          index: 1,
          input_state: 10,
        })
        expect(
          (await getDb().inboundLedger.where("namespace").equals("qq-stream").first())?.qqStream
        ).toMatchObject({ phase: "uncertain", messageId: "known-server" })
        expect(qqPassiveReplyCount("lifecycle-source")).toBe(1)
      } finally {
        await a.stop()
      }
    }
  )
})

it.each([
  ["mp3", "audio/mpeg"],
  ["aac", "audio/aac"],
  ["m4a", "audio/mp4"],
  ["m4a_tail", "audio/x-m4a"],
] as const)(
  "turns buffered %s TTS into real SILK, queues bytes and retries C2C without resynthesis",
  async (format, mimeType) => {
    const { synthesizeConnectorVoice } = await import("@/lib/connectors/voice")
    const { transcodeAudio } = await import("@/lib/audio/transcode")
    const { ttsOrchestrator } = await import("@/lib/tts/tts-orchestrator")
    const { ConnectorDeliveryGateway } = await import("@/lib/connectors/delivery-gateway")
    const { enqueueOutbound } = await import("@/lib/db/outbound-jobs")
    const { execFileSync } = await import("node:child_process")
    const fixtures = await import("@/lib/audio/test-audio.json")
    const synthesize = jest.spyOn(ttsOrchestrator, "synthesize").mockResolvedValue({
      success: true,
      audioData: new Uint8Array(Buffer.from(fixtures[format], "base64")).buffer,
      mimeType,
      provider: "openai",
      billedCharacters: 5,
      spokenText: "Hello",
    })
    jest.mocked(transcodeAudio).mockImplementation(async (request) => {
      const script = `const {transcodeAudioBytes}=require("./lib/audio/transcode-core.ts");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",async()=>{const x=JSON.parse(s);x.bytes=new Uint8Array(Buffer.from(x.bytes,"base64"));const r=await transcodeAudioBytes(x);console.log(JSON.stringify({...r,bytes:Buffer.from(r.bytes).toString("base64")}))})`
      const result = JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
          input: JSON.stringify({
            ...request,
            bytes: Buffer.from(request.bytes).toString("base64"),
          }),
          timeout: 15000,
        }).toString()
      )
      return { ...result, bytes: new Uint8Array(Buffer.from(result.bytes, "base64")) }
    })
    try {
      const a = adapter(),
        conversationRef = {
          platform: "qq-official",
          adapterId: "qq-1",
          scene: "c2c",
          sceneId: "target",
          msgId: "voice-trigger",
        }
      const voice = await synthesizeConnectorVoice({
        adapter: a,
        target: conversationRef,
        text: "Hello",
      })
      const gateway = new ConnectorDeliveryGateway({
        planDelivery: async () => ({ action: "send" }),
        persistOne: enqueueOutbound,
        recordReceipt: async () => {},
        appendAudit: async () => {},
      })
      const queued = await gateway.enqueueAuthorized({
        adapterId: a.id,
        conversationKey: "qq-official:qq-1:target",
        source: "skill",
        authorization: { kind: "human", actor: "connector-user" },
        request: { conversationRef, segments: [voice], metadata: { idempotencyKey: "tts-c2c" } },
      })
      expect(queued.kind).toBe("queued")
      if (queued.kind !== "queued") throw Error("Expected queued voice")
      const stored = await getDb().outboundQueue.get(queued.job.id)
      expect(stored?.request.segments).toEqual([voice])
      let uploads = 0
      mockInvoke.mockImplementation(
        async (command: string, args: { req: { sourceUrl?: string } }) => {
          if (command === "connectors_media_upload") {
            uploads++
            const bytes = Buffer.from(args.req.sourceUrl!.split(",")[1], "base64")
            expect([...bytes.subarray(0, 10)]).toEqual([2, 35, 33, 83, 73, 76, 75, 95, 86, 51])
            return JSON.stringify(
              httpResp(
                uploads === 1 ? 503 : 200,
                uploads === 1 ? { message: "busy" } : { file_info: "tts-silk" }
              )
            )
          }
          return httpResp(200, { id: "voice-sent" })
        }
      )
      expect((await a.send(stored!.request)).error?.retryable).toBe(true)
      expect((await a.send(stored!.request)).ok).toBe(true)
      expect(mockInvoke).toHaveBeenCalledWith("connectors_media_upload", {
        req: expect.objectContaining({
          uploadUrl: "https://api.bot.qq.com/v2/users/target/files",
          qq: { fileType: 3, fileName: "voice.silk" },
          sourceUrl: voice.url,
        }),
      })
      expect(JSON.parse(httpCalls()[0].body!)).toMatchObject({
        msg_type: 7,
        msg_id: "voice-trigger",
        media: { file_info: "tts-silk" },
      })
      expect(synthesize).toHaveBeenCalledTimes(1)
      expect(transcodeAudio).toHaveBeenCalledTimes(1)
    } finally {
      synthesize.mockRestore()
      jest.mocked(transcodeAudio).mockReset()
    }
  }
)
