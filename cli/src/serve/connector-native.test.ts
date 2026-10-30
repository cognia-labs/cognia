import {
  createCipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto"
import { once } from "node:events"
import WebSocket from "ws"
import { ConnectorLoopback, deferred, waitFor } from "@/cli/src/test-support/connector-loopback"
import { connectorListen } from "@/lib/connectors/events"
import {
  connectorsHttpRequest,
  connectorsWsOpen,
  connectorsWsClose,
  connectorsWechatOaInboundList,
  connectorsWechatOaInboundClaim,
  connectorsWechatOaInboundAck,
} from "@/lib/connectors/tauri/commands"
import { createWechatOaAdapter } from "@/lib/connectors/adapters/wechat-oa"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))

const nativeOnly = process.env.COGNIA_IM_NATIVE === "1" ? describe : describe.skip
const timestamp = () => String(Math.floor(Date.now() / 1000))
const privateKey = (seed: Buffer) =>
  createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  })
const sha1 = (...items: string[]) => createHash("sha1").update(items.sort().join("")).digest("hex")
const xml = (id: string) =>
  `<xml><ToUserName>gh_bot</ToUserName><FromUserName>openid-A</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content>hello-${id}</Content><MsgId>${id}</MsgId></xml>`

async function fixture(
  run: (
    wire: ConnectorLoopback,
    events: Array<{ topic: string; payload: Record<string, unknown> }>
  ) => Promise<void>
) {
  const wire = await new ConnectorLoopback().open()
  const events: Array<{ topic: string; payload: Record<string, unknown> }> = []
  const emit = wire.emit.bind(wire)
  wire.emit = (topic, payload) => {
    events.push({ topic, payload: payload as Record<string, unknown> })
    emit(topic, payload)
  }
  try {
    await run(wire, events)
    expect(wire.errors).toEqual([])
  } finally {
    await wire.close()
  }
}
async function register(
  wire: ConnectorLoopback,
  id: string,
  type: string,
  credentials: Record<string, string>
) {
  await wire.native!.call("fixture_register", { reg: { adapterId: id, adapterType: type } })
  for (const [credential, value] of Object.entries(credentials))
    await wire.native!.call("connectors_keyring_set", { adapterId: id, credential, value })
}
async function post(
  wire: ConnectorLoopback,
  id: string,
  body: string,
  headers: Record<string, string> = {},
  query = ""
) {
  const response = await fetch(`${wire.native!.origin}/webhook/spoofed-kind/${id}${query}`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(4000),
  })
  return { status: response.status, body: await response.text() }
}
const oaQuery = (token = "oa-token") => `?timestamp=1&nonce=n&signature=${sha1(token, "1", "n")}`

nativeOnly("production Rust connector bridge with real isolated encrypted persistence", () => {
  it("enforces the native bounded HTTP response budget", async () => {
    await fixture(async (wire) => {
      const expected = { text: "原生✓".repeat(256) }
      wire.onHttp = () => ({ body: expected })
      const exactBytes = Buffer.byteLength(JSON.stringify(expected))
      const req = { url: `${wire.origin}/message`, method: "GET" }
      await expect(
        wire.native!.call("connectors_bounded_http_request", { req, maxResponseBytes: 64 })
      ).rejects.toThrow("download_body_too_large")
      await expect(
        wire.native!.call("connectors_bounded_http_request", {
          req,
          maxResponseBytes: exactBytes - 1,
        })
      ).rejects.toThrow("download_body_too_large")
      const response = await wire.native!.call<{ status: number; body: string }>(
        "connectors_bounded_http_request",
        { req, maxResponseBytes: exactBytes }
      )
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual(expected)
    })
  })

  it("preserves binary WS command bytes without converting them to text", async () => {
    await fixture(async (wire) => {
      const bytes: Buffer[] = []
      wire.onBinary = (socket, data) => {
        bytes.push(data)
        socket.send(JSON.stringify({ binaryReceived: true }))
      }
      const handle = await connectorsWsOpen(wire.wsUrl)
      await wire.native!.call("connectors_ws_send", { handleId: handle, binary: [0, 255, 128, 1] })
      await waitFor(() => bytes.length === 1, "native binary bytes")
      expect([...bytes[0]]).toEqual([0, 255, 128, 1])
      await expect(
        wire.native!.call("connectors_ws_send", { handleId: handle, data: "both", binary: [1] })
      ).rejects.toThrow("exactly one")
      await wire.native!.call("connectors_ws_send", {
        handleId: handle,
        data: JSON.stringify({ fence: true }),
      })
      await waitFor(() => wire.frames.length > 0, "native outbound FIFO fence")
      expect(bytes.map((value) => [...value])).toEqual([[0, 255, 128, 1]])
      expect(wire.frames.map((frame) => frame.body)).toEqual([{ fence: true }])
      await connectorsWsClose(handle)
    })
  })
  it("preserves HTTP status, headers and UTF-8 through actual native command serialization", async () => {
    await fixture(async (wire) => {
      wire.onHttp = (req) => ({
        status: 429,
        body: { echo: req.body.text, auth: req.headers.authorization },
      })
      const result = await connectorsHttpRequest({
        url: `${wire.origin}/message`,
        method: "POST",
        headers: { authorization: "Bearer synthetic" },
        body: JSON.stringify({ text: "原生桥 ✓" }),
      })
      expect(result.status).toBe(429)
      expect(JSON.parse(result.body)).toEqual({ echo: "原生桥 ✓", auth: "Bearer synthetic" })
      expect(result.headers["content-type"]).toContain("application/json")
      await expect(
        connectorsHttpRequest({ url: `${wire.origin}/message`, method: "NOT-HTTP" })
      ).rejects.toThrow("unsupported HTTP method")
      expect(wire.requests).toHaveLength(1)
      await expect(
        wire.native!.call("connectors_http_request", {
          req: { url: "http://127.0.0.1:1/message", method: "GET" },
        })
      ).rejects.toThrow("refused external")
    })
  })

  it("bounds a held native HTTP command without blocking another command", async () => {
    await fixture(async (wire) => {
      let release!: () => void
      wire.onHttp = async (req) => {
        if (req.url.pathname === "/held")
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return { body: {} }
      }
      const held = connectorsHttpRequest({
        url: `${wire.origin}/held`,
        method: "GET",
        timeoutMs: 50,
      })
      const rejected = expect(held).rejects.toThrow()
      try {
        await waitFor(() => wire.requests.length === 1, "held native request")
        expect(
          (await connectorsHttpRequest({ url: `${wire.origin}/message`, method: "GET" })).status
        ).toBe(200)
        await rejected
      } finally {
        release?.()
      }
    })
  })

  it("receives immediate WS text/binary frames and the exact remote close once", async () => {
    await fixture(async (wire, events) => {
      const handle = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
      const messages: string[] = []
      const unlisten = await connectorListen<string>(`connectors://ws/${handle}/message`, (event) =>
        messages.push(event.payload)
      )
      wire.onConnection = (socket) => socket.send(JSON.stringify({ early: true }))
      wire.onFrame = ({ socket }) => {
        socket.send(Buffer.from([0, 255, 3]))
        socket.close(4001, "native-close")
      }
      const opening = connectorsWsOpen(wire.wsUrl, undefined, handle)
      expect(await opening).toBe(handle)
      await waitFor(() => messages.length === 1, "preallocated handle first frame")
      expect(messages).toEqual([JSON.stringify({ early: true })])
      // Trigger the peer from the native writer rather than a JS WS client.
      await wire.native!.call("connectors_ws_send", { handleId: handle, data: "{}" })
      await waitFor(
        () => events.some((event) => event.topic === `connectors://ws/${handle}/close`),
        "native close event"
      )
      expect(
        events
          .filter((event) => event.topic === `connectors://ws/${handle}/binary`)
          .map((event) => event.payload)
      ).toEqual(["AP8D"])
      expect(
        events
          .filter((event) => event.topic === `connectors://ws/${handle}/close`)
          .map((event) => event.payload)
      ).toEqual([{ code: 4001, reason: "native-close" }])
      expect(wire.activeSocketCount).toBe(0)
      await expect(connectorsWsClose(handle)).rejects.toThrow("not found")
      unlisten()
    })
  })

  it("recovers unclaimed and claimed OA occurrences across two actual process crashes, then ACKs exactly", async () => {
    await fixture(async (wire, events) => {
      await register(wire, "oa", "wechat-oa", { token: "oa-token" })
      const callback = await post(wire, "oa", xml("persisted"), {}, oaQuery())
      expect(callback).toEqual({ status: 200, body: "success" })
      await waitFor(() => events.length === 1, "persisted native wakeup")
      const id = String(events[0].payload.ingressId)
      expect(id.length).toBeGreaterThan(0)
      expect(await connectorsWechatOaInboundList("oa")).toEqual([
        expect.objectContaining({ id, xml: xml("persisted"), admitted: false }),
      ])
      await wire.native!.stop(true)
      await wire.native!.start()
      expect(await connectorsWechatOaInboundList("oa")).toEqual([
        expect.objectContaining({ id, admitted: false }),
      ])
      await expect(connectorsWechatOaInboundClaim("other-account", id)).resolves.toBe(false)
      expect(await connectorsWechatOaInboundClaim("oa", id)).toBe(true)
      await wire.native!.stop(true)
      await wire.native!.start()
      expect(await connectorsWechatOaInboundList("oa")).toEqual([
        expect.objectContaining({ id, admitted: true }),
      ])
      await connectorsWechatOaInboundAck("other-account", id)
      expect(await connectorsWechatOaInboundList("oa")).toHaveLength(1)
      await connectorsWechatOaInboundAck("oa", id)
      expect(await connectorsWechatOaInboundList("oa")).toEqual([])
      await register(wire, "oa", "wechat-oa", {})
      expect((await post(wire, "oa", xml("persisted"), {}, oaQuery())).status).toBe(200)
      const next = (await connectorsWechatOaInboundList("oa"))[0]
      expect(next.id).not.toBe(id)
      await connectorsWechatOaInboundAck("oa", id)
      expect((await connectorsWechatOaInboundList("oa"))[0].id).toBe(next.id)
    })
  })

  it("runs signed OA HTTP → native journal → production adapter → native reply HTTP → exact ACK", async () => {
    await fixture(async (wire) => {
      await register(wire, "oa", "wechat-oa", { token: "oa-token" })
      wire.onHttp = () => ({ body: { errcode: 0 } })
      const adapter = createWechatOaAdapter({
        id: "oa",
        displayName: "Native",
        accessToken: async () => "synthetic-access",
        apiBase: wire.origin,
      })
      const accepted: NormalizedInboundEvent[] = []
      const errors: unknown[] = []
      try {
        await adapter.start(
          wire.context("oa", async (event) => {
            try {
              const retained = await connectorsWechatOaInboundList("oa")
              expect(retained).toEqual([expect.objectContaining({ admitted: true })])
              expect(
                (
                  await adapter.send({
                    conversationRef: event.conversationRef,
                    segments: [{ type: "text", text: "原生回复 ✓" }],
                    metadata: { idempotencyKey: "native-oa" },
                  })
                ).ok
              ).toBe(true)
              accepted.push(event)
            } catch (error) {
              errors.push(error)
              throw error
            }
          })
        )
        expect((await post(wire, "oa", xml("adapter"), {}, oaQuery())).status).toBe(200)
        await waitFor(() => accepted.length === 1 || errors.length > 0, "native OA adapter reply")
        expect(errors).toEqual([])
        await waitFor(
          () => wire.commands.some((call) => call.name === "connectors_wechat_oa_inbound_ack"),
          "native OA ACK"
        )
        // Await another native read after the ACK command, not a fixture counter.
        await waitFor(() => wire.native!.pendingCount === 0, "native ACK settlement")
        expect(await connectorsWechatOaInboundList("oa")).toEqual([])
        expect(accepted.map((event) => event.plainText)).toEqual(["hello-adapter"])
        expect(
          wire.requests.map((req) => ({ pathname: req.url.pathname, body: req.body }))
        ).toEqual([
          {
            pathname: "/cgi-bin/message/custom/send",
            body: { touser: "openid-A", msgtype: "text", text: { content: "原生回复 ✓" } },
          },
        ])
      } finally {
        await adapter.stop()
      }
    })
  })

  it("rejects wrong OA signatures and callbacks after credential revocation or rotation", async () => {
    await fixture(async (wire, events) => {
      await register(wire, "oa", "wechat-oa", { token: "oa-token" })
      expect((await post(wire, "oa", xml("bad"), {}, oaQuery("wrong"))).status).toBe(401)
      await wire.native!.call("connectors_keyring_delete", { adapterId: "oa", credential: "token" })
      expect((await post(wire, "oa", xml("removed"), {}, oaQuery())).status).toBe(401)
      await register(wire, "oa", "wechat-oa", { token: "rotated" })
      expect((await post(wire, "oa", xml("old"), {}, oaQuery())).status).toBe(401)
      expect((await post(wire, "oa", xml("good"), {}, oaQuery("rotated"))).status).toBe(200)
      await waitFor(() => events.length > 0, "accepted OA fence")
      expect(events.map((event) => event.payload.xml)).toEqual([xml("good")])
      expect((await connectorsWechatOaInboundList("oa")).map((row) => row.xml)).toEqual([
        xml("good"),
      ])
    })
  })

  it("retains an admitted native occurrence through held and rejected JS admission before ACK", async () => {
    await fixture(async (wire) => {
      await register(wire, "oa", "wechat-oa", { token: "oa-token" })
      const first = deferred<void>()
      const retry = deferred<void>()
      let attempts = 0
      const adapter = createWechatOaAdapter({
        id: "oa",
        displayName: "Native",
        accessToken: async () => "unused",
      })
      try {
        await adapter.start(
          wire.context("oa", async () => {
            attempts++
            await (attempts === 1 ? first.promise : retry.promise)
          })
        )
        expect((await post(wire, "oa", xml("held"), {}, oaQuery())).status).toBe(200)
        await waitFor(() => attempts === 1, "held native admission")
        const retained = await connectorsWechatOaInboundList("oa")
        expect(retained).toEqual([expect.objectContaining({ xml: xml("held"), admitted: true })])
        expect(
          wire.commands.filter((call) => call.name === "connectors_wechat_oa_inbound_ack")
        ).toEqual([])
        first.reject(new Error("Synthetic admission rejection"))
        await waitFor(() => attempts === 2, "admission retry after rejection")
        expect(await connectorsWechatOaInboundList("oa")).toEqual(retained)
        expect(
          wire.commands.filter((call) => call.name === "connectors_wechat_oa_inbound_ack")
        ).toEqual([])
        retry.resolve()
        await waitFor(
          () => wire.commands.some((call) => call.name === "connectors_wechat_oa_inbound_ack"),
          "accepted occurrence ACK"
        )
        await waitFor(() => wire.native!.pendingCount === 0, "native ACK completion")
        expect(await connectorsWechatOaInboundList("oa")).toEqual([])
        expect(
          wire.commands
            .filter((call) => call.name === "connectors_wechat_oa_inbound_ack")
            .map((call) => call.args?.id)
        ).toEqual([retained[0].id])
      } finally {
        first.resolve()
        retry.resolve()
        await adapter.stop()
      }
    })
  })

  it("answers the QQ URL challenge with a verifiable native signature without publishing a message", async () => {
    await fixture(async (wire, events) => {
      await register(wire, "qq", "qq-official", { clientSecret: "qq-secret" })
      const key = privateKey(Buffer.from("qq-secret".repeat(4).slice(0, 32)))
      const ts = timestamp()
      const body = JSON.stringify({ op: 13, d: { event_ts: "event-ts", plain_token: "challenge" } })
      const headers = (raw: string) => ({
        "X-Signature-Timestamp": ts,
        "X-Signature-Ed25519": sign(null, Buffer.from(ts + raw), key).toString("hex"),
      })
      expect((await post(wire, "qq", body)).status).toBe(401)
      expect((await post(wire, "qq", body + " ", headers(body))).status).toBe(401)
      const response = await post(wire, "qq", body, headers(body))
      expect(response.status).toBe(200)
      const result = JSON.parse(response.body)
      expect(result.plain_token).toBe("challenge")
      expect(
        verify(
          null,
          Buffer.from("event-tschallenge"),
          createPublicKey(key),
          Buffer.from(result.signature, "hex")
        )
      ).toBe(true)
      const dispatch = JSON.stringify({ op: 0, id: "fence", d: { content: "hello" } })
      expect((await post(wire, "qq", dispatch, headers(dispatch))).status).toBe(200)
      await waitFor(() => events.length > 0, "QQ dispatch fence")
      expect(events).toEqual([{ topic: "connectors://webhook/qq", payload: JSON.parse(dispatch) }])
    })
  })

  it.each(["telegram", "slack", "discord", "lark", "qq-official"])(
    "authenticates %s callbacks in Rust, rejects tampering, and isolates account credentials",
    async (kind) => {
      await fixture(async (wire, events) => {
        const key = privateKey(Buffer.alloc(32, 0x61))
        const publicHex = createPublicKey(key)
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("hex")
        const credentials: Record<string, Record<string, string>> = {
          telegram: { secretToken: "token" },
          slack: { signingSecret: "signing" },
          discord: { publicKey: publicHex },
          lark: { verificationToken: "token", encryptKey: "encrypt" },
          "qq-official": { clientSecret: "qq-secret" },
        }
        await register(wire, "account-A", kind, credentials[kind])
        await register(wire, "account-B", kind, {})
        const body = JSON.stringify(
          kind === "discord"
            ? { type: 2, id: "good" }
            : kind === "qq-official"
              ? { op: 0, t: "GROUP_AT_MESSAGE_CREATE", id: "good", d: { content: "hello" } }
              : kind === "lark"
                ? { header: { token: "token", event_id: "good" }, event: { text: "hello" } }
                : { type: "event_callback", update_id: 1, event: { text: "hello" } }
        )
        const ts = timestamp()
        let headers: Record<string, string> = {}
        if (kind === "telegram") headers = { "X-Telegram-Bot-Api-Secret-Token": "token" }
        if (kind === "slack")
          headers = {
            "X-Slack-Request-Timestamp": ts,
            "X-Slack-Signature": `v0=${createHmac("sha256", "signing").update(`v0:${ts}:${body}`).digest("hex")}`,
          }
        if (kind === "lark")
          headers = {
            "x-lark-request-timestamp": ts,
            "x-lark-request-nonce": "n",
            "x-lark-signature": createHash("sha256")
              .update(ts + "nencrypt" + body)
              .digest("hex"),
          }
        if (kind === "discord" || kind === "qq-official") {
          const signing =
            kind === "discord" ? key : privateKey(Buffer.from("qq-secret".repeat(4).slice(0, 32)))
          headers = {
            "X-Signature-Timestamp": ts,
            "X-Signature-Ed25519": sign(null, Buffer.from(ts + body), signing).toString("hex"),
          }
        }
        // Telegram authenticates its token rather than the body.
        const tampered =
          kind === "telegram" ? { ...headers, "X-Telegram-Bot-Api-Secret-Token": "wrong" } : headers
        expect(
          (await post(wire, "account-A", kind === "telegram" ? body : body + " ", tampered)).status
        ).toBe(401)
        expect((await post(wire, "account-B", body, headers)).status).toBe(401)
        const accepted = await post(wire, "account-A", body, headers)
        expect(accepted.status).toBe(200)
        if (kind === "discord")
          expect(JSON.parse(accepted.body)).toMatchObject({ type: 4, data: { flags: 64 } })
        if (kind === "qq-official") expect(JSON.parse(accepted.body)).toEqual({ op: 12, d: 0 })
        await waitFor(() => events.length > 0, "accepted native webhook fence")
        expect(events).toEqual([
          { topic: "connectors://webhook/account-A", payload: JSON.parse(body) },
        ])
      })
    }
  )

  it("keeps Lark replay identity scoped per adapter and rejects exact replay", async () => {
    await fixture(async (wire, events) => {
      for (const id of ["A", "B"]) await register(wire, id, "lark", { verificationToken: "token" })
      const body = JSON.stringify({ header: { token: "token", event_id: "shared" }, event: {} })
      expect((await post(wire, "A", body)).status).toBe(200)
      expect((await post(wire, "A", body)).status).toBe(401)
      expect((await post(wire, "B", body)).status).toBe(200)
      await waitFor(() => events.length === 2, "two account-scoped Lark callbacks")
      expect(events.map((event) => event.topic)).toEqual([
        "connectors://webhook/A",
        "connectors://webhook/B",
      ])
    })
  })

  it("verifies and decrypts OA safe-mode bytes with appId binding before journaling", async () => {
    await fixture(async (wire, events) => {
      const key = Buffer.alloc(32, 0x42)
      await register(wire, "oa", "wechat-oa", {
        token: "oa-token",
        encodingAesKey: key.toString("base64").slice(0, 43),
        appId: "wx-correct",
      })
      const encrypt = (appId: string) => {
        const content = Buffer.from(xml(appId))
        const length = Buffer.alloc(4)
        length.writeUInt32BE(content.length)
        const raw = Buffer.concat([Buffer.alloc(16), length, content, Buffer.from(appId)])
        const pad = 32 - (raw.length % 32)
        const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16))
        cipher.setAutoPadding(false)
        return Buffer.concat([
          cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])),
          cipher.final(),
        ]).toString("base64")
      }
      const signedBody = `<xml><Encrypt><![CDATA[${encrypt("wx-correct")}]]></Encrypt></xml>`
      for (const query of ["?timestamp=1&nonce=n", "?timestamp=1&nonce=n&msg_signature=wrong"]) {
        expect((await post(wire, "oa", signedBody, {}, query)).status).toBe(401)
        expect(await connectorsWechatOaInboundList("oa")).toEqual([])
      }
      for (const appId of ["wx-wrong", "wx-correct"]) {
        const encoded = encrypt(appId)
        const query = `?timestamp=1&nonce=n&msg_signature=${sha1("oa-token", "1", "n", encoded)}`
        expect(
          (
            await post(
              wire,
              "oa",
              `<xml><Encrypt><![CDATA[${encoded}]]></Encrypt></xml>`,
              {},
              query
            )
          ).status
        ).toBe(appId === "wx-correct" ? 200 : 401)
        if (appId === "wx-wrong") expect(await connectorsWechatOaInboundList("oa")).toEqual([])
      }
      await waitFor(() => events.length === 1, "decrypted callback fence")
      expect((await connectorsWechatOaInboundList("oa")).map((row) => row.xml)).toEqual([
        xml("wx-correct"),
      ])
      expect(events[0].payload.xml).toBe(xml("wx-correct"))
    })
  })

  it("authenticates actual OneBot reverse WS and routes events and RPC echoes separately", async () => {
    await fixture(async (wire, events) => {
      await register(wire, "onebot", "onebot", { onebotBearer: "bearer" })
      const url = wire.native!.origin.replace("http:", "ws:") + "/ws/onebot/onebot"
      const bad = new WebSocket(url, { headers: { authorization: "Bearer wrong" } })
      const badError = once(bad, "error")
      await expect(badError).resolves.toEqual([
        expect.objectContaining({ message: expect.stringContaining("401") }),
      ])
      const socket = new WebSocket(url, { headers: { authorization: "Bearer bearer" } })
      try {
        await once(socket, "open")
        socket.send(JSON.stringify({ post_type: "message", message_id: 1 }))
        socket.send("invalid-json")
        const call = once(socket, "message")
        await wire.native!.call("connectors_onebot_send", {
          adapterId: "onebot",
          callJson: JSON.stringify({ action: "send_private_msg", echo: "exact-echo" }),
        })
        expect(JSON.parse((await call)[0].toString())).toEqual({
          action: "send_private_msg",
          echo: "exact-echo",
        })
        socket.send(
          JSON.stringify({ echo: "exact-echo", status: "ok", retcode: 0, data: { message_id: 2 } })
        )
        await waitFor(
          () => events.some((event) => event.topic.endsWith("/response")),
          "native OneBot response fence"
        )
        expect(
          events.filter((event) => event.topic.endsWith("/event")).map((event) => event.payload)
        ).toEqual([JSON.stringify({ post_type: "message", message_id: 1 })])
        expect(
          events.filter((event) => event.topic.endsWith("/response")).map((event) => event.payload)
        ).toEqual([
          JSON.stringify({ echo: "exact-echo", status: "ok", retcode: 0, data: { message_id: 2 } }),
        ])
      } finally {
        const closed = once(socket, "close")
        socket.close()
        await closed
      }
      await waitFor(() => events.some((event) => event.topic.endsWith("/close")), "OneBot close")
      await expect(
        wire.native!.call("connectors_onebot_send", { adapterId: "onebot", callJson: "{}" })
      ).rejects.toThrow("no connected client")
    })
  })
})
