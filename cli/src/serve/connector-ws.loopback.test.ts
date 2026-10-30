import { createWeComAdapter } from "@/lib/connectors/adapters/wecom"
import { createDingTalkAdapter } from "@/lib/connectors/adapters/dingtalk"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import { ConnectorLoopback, deferred, waitFor } from "@/cli/src/test-support/connector-loopback"

jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))

const reqId = (body: Record<string, unknown>) => (body.headers as { req_id: string }).req_id
const outbound = (event: NormalizedInboundEvent, text = "真实回复 ✓") => ({
  conversationRef: event.conversationRef,
  segments: [{ type: "text" as const, text }],
  metadata: { idempotencyKey: "wire-key" },
})
const wecomMessage = (id: string) => ({
  cmd: "aibot_msg_callback",
  headers: { req_id: `req-${id}` },
  body: {
    msgid: id,
    aibotid: "self",
    chatid: `chat-${id}`,
    chattype: "single",
    from: { userid: `user-${id}` },
    msgtype: "text",
    text: { content: `hello-${id}` },
  },
})

async function withWecom(
  run: (
    wire: ConnectorLoopback,
    adapter: PlatformAdapter,
    events: NormalizedInboundEvent[]
  ) => Promise<void>
) {
  const wire = await new ConnectorLoopback().open()
  const events: NormalizedInboundEvent[] = []
  wire.onFrame = ({ socket, body }) =>
    socket.send(JSON.stringify({ headers: body.headers, errcode: 0 }))
  const adapter = createWeComAdapter({
    id: "wire-wecom",
    displayName: "Wire",
    botId: async () => "synthetic-bot",
    secret: async () => "synthetic-secret",
    _wsUrl: wire.wsUrl,
    _backoffBaseMs: 1,
  })
  try {
    await adapter.start(
      wire.context(adapter.id, async (event) => {
        events.push(event)
      })
    )
    await run(wire, adapter, events)
    expect(wire.errors).toEqual([])
  } finally {
    try {
      await adapter.stop()
      await waitFor(() => wire.activeSocketCount === 0, "WeCom socket closure")
      expect(wire.listeners.size).toBe(0)
    } finally {
      await wire.close()
    }
  }
}

describe("WeCom production adapter over actual loopback WebSocket", () => {
  it("subscribes with credentials, parses callbacks, and keeps stream/final request IDs isolated", async () => {
    await withWecom(async (wire, adapter, events) => {
      expect(wire.frames[0].body).toMatchObject({
        cmd: "aibot_subscribe",
        body: { bot_id: "synthetic-bot", secret: "synthetic-secret" },
      })
      wire.connections[0].socket.send(JSON.stringify(wecomMessage("A")))
      wire.connections[0].socket.send(JSON.stringify(wecomMessage("B")))
      await waitFor(() => events.length === 2, "two normalized callbacks")
      expect(events.map((event) => event.plainText)).toEqual(["hello-A", "hello-B"])
      await adapter.streamReply!({ conversationRef: events[0].conversationRef, text: "partial A" })
      expect((await adapter.send(outbound(events[1], "final B"))).ok).toBe(true)
      expect((await adapter.send(outbound(events[0], "final A"))).ok).toBe(true)
      const replies = wire.frames
        .filter((frame) => frame.body.cmd === "aibot_respond_msg")
        .map((frame) => frame.body)
      expect(replies.map(reqId)).toEqual(["req-A", "req-B", "req-A"])
      expect(replies.map((frame) => frame.body)).toEqual([
        expect.objectContaining({
          stream: expect.objectContaining({ content: "partial A", finish: false }),
        }),
        expect.objectContaining({
          stream: expect.objectContaining({ content: "final B", finish: true }),
        }),
        expect.objectContaining({
          stream: expect.objectContaining({ content: "final A", finish: true }),
        }),
      ])
      expect((replies[0].body as { stream: { id: string } }).stream.id).toBe(
        (replies[2].body as { stream: { id: string } }).stream.id
      )
      const streamA = (replies[0].body as { stream: { id: string } }).stream.id
      const streamB = (replies[1].body as { stream: { id: string } }).stream.id
      expect(streamA).toEqual(expect.any(String))
      expect(streamA.length).toBeGreaterThan(0)
      expect(streamB.length).toBeGreaterThan(0)
      expect(streamA).not.toBe(streamB)
      expect(wire.frames.some((frame) => frame.body.cmd === "aibot_send_msg")).toBe(false)
    })
  })

  it("a delayed preview ACK cannot resolve a final reply before the final ACK arrives", async () => {
    await withWecom(async (wire, adapter, events) => {
      const socket = wire.connections[0].socket
      socket.send(JSON.stringify(wecomMessage("preview")))
      await waitFor(() => events.length === 1, "preview callback")
      wire.onFrame = () => {}
      await adapter.streamReply!({ conversationRef: events[0].conversationRef, text: "preview" })
      let settled = false
      const final = adapter.send(outbound(events[0])).then((result) => {
        settled = true
        return result
      })
      await waitFor(
        () => wire.frames.filter((frame) => frame.body.cmd === "aibot_respond_msg").length === 2,
        "pending final frame"
      )
      socket.send(JSON.stringify({ headers: { req_id: "req-preview" }, errcode: 0 }))
      await wire.flush(socket)
      const resolvedByPreview = settled
      socket.send(
        JSON.stringify({
          headers: { req_id: "req-preview" },
          errcode: 40014,
          errmsg: "final rejected",
        })
      )
      expect((await final).ok).toBe(false)
      expect(resolvedByPreview).toBe(false)
    })
  })

  it("server rejection of a final reply is a failure, never a successful receipt", async () => {
    await withWecom(async (wire, adapter, events) => {
      wire.connections[0].socket.send(JSON.stringify(wecomMessage("rejected")))
      await waitFor(() => events.length === 1, "callback")
      wire.onFrame = ({ socket, body }) =>
        socket.send(
          JSON.stringify({ headers: body.headers, errcode: 40014, errmsg: "invalid callback" })
        )
      const result = await adapter.send(outbound(events[0]))
      expect(result.ok).toBe(false)
      expect(result.error?.retryable).toBe(false)
      expect(wire.frames.filter((frame) => frame.body.cmd === "aibot_respond_msg")).toHaveLength(1)
    })
  })

  it("a connection lost before ACK fails the send and re-subscribes on a fresh real socket", async () => {
    await withWecom(async (wire, adapter, events) => {
      wire.connections[0].socket.send(JSON.stringify(wecomMessage("lost")))
      await waitFor(() => events.length === 1, "callback")
      wire.onFrame = ({ socket, body }) => {
        if (body.cmd === "aibot_respond_msg") socket.terminate()
        else socket.send(JSON.stringify({ headers: body.headers, errcode: 0 }))
      }
      expect((await adapter.send(outbound(events[0]))).ok).toBe(false)
      await waitFor(
        () => wire.connections.length === 2 && adapter.health().state === "running",
        "new subscribed socket"
      )
      expect(wire.frames.filter((frame) => frame.body.cmd === "aibot_subscribe")).toHaveLength(2)
      expect(wire.frames.filter((frame) => frame.body.cmd === "aibot_respond_msg")).toHaveLength(1)
      wire.connections[1].socket.send(JSON.stringify(wecomMessage("new")))
      await waitFor(() => events.length === 2, "new socket callback")
      expect(events[1].messageId).toBe("new")
    })
  })

  it("stop releases the real socket and every listener and refuses further sends", async () => {
    await withWecom(async (wire, adapter, events) => {
      wire.connections[0].socket.send(JSON.stringify(wecomMessage("stop")))
      await waitFor(() => events.length === 1, "callback")
      await adapter.stop()
      await waitFor(() => wire.activeSocketCount === 0, "stopped socket")
      expect(wire.listeners.size).toBe(0)
      expect((await adapter.send(outbound(events[0]))).ok).toBe(false)
      expect(wire.frames.filter((frame) => frame.body.cmd === "aibot_respond_msg")).toHaveLength(0)
    })
  })
})

const dingCallback = (id: string) => ({
  type: "CALLBACK",
  headers: { topic: "/v1.0/im/bot/messages/get", messageId: id },
  data: JSON.stringify({
    msgId: id,
    conversationId: "conversation-A",
    conversationType: "1",
    senderStaffId: "staff-A",
    chatbotUserId: "self",
    robotCode: "robot-A",
    msgtype: "text",
    text: { content: `hello-${id}` },
  }),
})
const ackId = (body: Record<string, unknown>) => (body.headers as { messageId?: string })?.messageId

async function withDing(
  run: (
    wire: ConnectorLoopback,
    adapter: PlatformAdapter,
    controller: AbortController
  ) => Promise<void>,
  emit: (event: NormalizedInboundEvent, adapter: PlatformAdapter) => Promise<void> = async () => {}
) {
  const wire = await new ConnectorLoopback().open()
  let registers = 0
  wire.onHttp = (req) => {
    if (req.method !== "POST") return { status: 405, body: {} }
    if (req.url.pathname === "/v1.0/gateway/connections/open")
      return { body: { endpoint: wire.wsUrl, ticket: `ticket-${++registers}` } }
    if (req.url.pathname === "/v1.0/robot/oToMessages/batchSend")
      return { body: { processQueryKey: "accepted" } }
    return { status: 404, body: { error: "Unexpected DingTalk endpoint" } }
  }
  const adapter = createDingTalkAdapter({
    id: "wire-ding",
    displayName: "Wire",
    appKey: async () => "synthetic-app",
    appSecret: async () => "synthetic-secret",
    accessToken: async () => "synthetic-token",
    selfId: "self",
  })
  const controller = new AbortController()
  try {
    await adapter.start(
      wire.context(adapter.id, (event) => emit(event, adapter), controller.signal)
    )
    await waitFor(() => wire.listeners.size === 2, "DingTalk socket subscriptions")
    await run(wire, adapter, controller)
    expect(wire.errors).toEqual([])
  } finally {
    try {
      await adapter.stop()
      await waitFor(() => wire.activeSocketCount === 0, "DingTalk socket closure")
      expect(wire.listeners.size).toBe(0)
    } finally {
      await wire.close()
    }
  }
}

describe("DingTalk production adapter over actual loopback HTTP and WS", () => {
  it("registers, uses its ticket, emits a callback, sends a reply, then acknowledges consumption", async () => {
    await withDing(
      async (wire) => {
        expect(wire.requests[0].body).toMatchObject({
          clientId: "synthetic-app",
          clientSecret: "synthetic-secret",
        })
        expect(wire.requests[0].url.pathname).toBe("/v1.0/gateway/connections/open")
        expect(wire.requests[0].method).toBe("POST")
        expect(wire.connections[0].url).toBe("/ws?ticket=ticket-1")
        wire.connections[0].socket.send(JSON.stringify(dingCallback("one")))
        await waitFor(
          () => wire.frames.some((frame) => ackId(frame.body) === "one"),
          "consumption ACK"
        )
        const sent = wire.requests.find((req) =>
          req.url.pathname.endsWith("/oToMessages/batchSend")
        )!
        expect(sent.headers["x-acs-dingtalk-access-token"]).toBe("synthetic-token")
        expect(sent.body).toMatchObject({
          robotCode: "robot-A",
          userIds: ["staff-A"],
          msgKey: "sampleText",
        })
        expect(JSON.parse(String(sent.body.msgParam))).toEqual({ content: "真实回复 ✓" })
        expect(wire.frames.find((frame) => ackId(frame.body) === "one")!.body.code).toBe(200)
      },
      async (event, adapter) => {
        expect(event.plainText).toBe("hello-one")
        expect((await adapter.send(outbound(event))).ok).toBe(true)
      }
    )
  })

  it("does not success-ACK while durable acceptance is held and NACKs a rejected delivery", async () => {
    const entered = deferred<void>(),
      release = deferred<void>()
    await withDing(
      async (wire) => {
        wire.connections[0].socket.send(JSON.stringify(dingCallback("held")))
        await entered.promise
        await wire.flush(wire.connections[0].socket)
        expect(wire.frames.some((frame) => ackId(frame.body) === "held")).toBe(false)
        release.reject(new Error("acceptance failed"))
        wire.connections[0].socket.send(
          JSON.stringify({
            type: "SYSTEM",
            headers: { topic: "ping", messageId: "after-held" },
            data: "{}",
          })
        )
        await waitFor(
          () => wire.frames.some((frame) => ackId(frame.body) === "after-held"),
          "post-consumption protocol fence"
        )
        expect(
          wire.frames
            .filter((frame) => ackId(frame.body) === "held")
            .map((frame) => frame.body.code)
        ).toEqual([500])
        expect(wire.requests.filter((req) => req.url.pathname.endsWith("/batchSend"))).toHaveLength(
          0
        )
      },
      async () => {
        entered.resolve()
        await release.promise
      }
    )
  })

  it("re-registers with a fresh ticket after a protocol disconnect and consumes the next callback", async () => {
    const events: NormalizedInboundEvent[] = []
    await withDing(
      async (wire) => {
        wire.connections[0].socket.send(
          JSON.stringify({ type: "SYSTEM", headers: { topic: "disconnect" } })
        )
        await waitFor(
          () => wire.connections.length === 2 && wire.listeners.size === 2,
          "reconnected DingTalk socket"
        )
        expect(wire.connections[1].url).toBe("/ws?ticket=ticket-2")
        wire.connections[1].socket.send(JSON.stringify(dingCallback("after")))
        await waitFor(
          () => wire.frames.some((frame) => ackId(frame.body) === "after"),
          "new socket ACK"
        )
        expect(events.map((event) => event.messageId)).toEqual(["after"])
        expect(wire.frames.find((frame) => ackId(frame.body) === "after")!.socket).toBe(
          wire.connections[1].socket
        )
      },
      async (event) => {
        events.push(event)
      }
    )
  })

  it("runtime cancellation releases an established socket without another registration", async () => {
    await withDing(async (wire, adapter, controller) => {
      controller.abort()
      await waitFor(() => wire.activeSocketCount === 0, "runtime abort socket closure")
      expect(wire.listeners.size).toBe(0)
      expect(adapter.health().state).toBe("down")
      expect(
        wire.requests.filter((req) => req.url.pathname.endsWith("/gateway/connections/open"))
      ).toHaveLength(1)
    })
  })
})
