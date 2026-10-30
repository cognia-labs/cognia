import { createWechatPersonalAdapter } from "@/lib/connectors/adapters/wechat-personal"
import { createWechatOaAdapter } from "@/lib/connectors/adapters/wechat-oa"
import { getAdapterInstance, commitWechatPersonalCheckpoint } from "@/lib/db/adapter-instances"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import { createHash } from "node:crypto"
import {
  ConnectorLoopback,
  deferred,
  waitFor,
  type WireRequest,
  type WireResponse,
} from "@/cli/src/test-support/connector-loopback"

jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))
// These stores are fixtures; this suite proves network/adaptor ordering, not
// native journal/checkpoint persistence or platform signature validation.
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  commitWechatPersonalCheckpoint: jest.fn(),
}))
const getInstance = getAdapterInstance as jest.Mock
const commitCheckpoint = commitWechatPersonalCheckpoint as jest.Mock
const textRequest = (event: NormalizedInboundEvent, text = "回复中文 ✓") => ({
  conversationRef: event.conversationRef,
  segments: [{ type: "text" as const, text }],
  metadata: { idempotencyKey: "wire-key" },
})
const personalMessage = (user: string) => ({
  message_id: `msg-${user}`,
  from_user_id: user,
  to_user_id: "bot",
  message_type: 1,
  context_token: `context-${user}`,
  item_list: [{ type: 1, text_item: { text: `hello-${user}` } }],
})

async function withPersonal(
  run: (
    wire: ConnectorLoopback,
    adapter: PlatformAdapter,
    row: { settings: Record<string, unknown> },
    credential: { value: string; revision: string }
  ) => Promise<void>,
  respond: (req: WireRequest, poll: number) => WireResponse | Promise<WireResponse>,
  emit: (event: NormalizedInboundEvent) => Promise<void>,
  options: { cleanup?: () => void; checkpoint?: (origin: string) => Record<string, unknown> } = {}
) {
  const wire = await new ConnectorLoopback().open()
  const idle = deferred<WireResponse>()
  const row = {
    id: "wire-personal",
    type: "wechat-personal",
    enabled: true,
    createdAt: 1,
    settings: { accountId: "account-A", baseUrl: wire.origin } as Record<string, unknown>,
  }
  if (options.checkpoint) row.settings.ilinkCheckpoint = options.checkpoint(wire.origin)
  getInstance.mockReset().mockImplementation(async () => structuredClone(row))
  commitCheckpoint.mockReset().mockImplementation(async (_id, expected, next, isCurrent) => {
    if (!isCurrent() || JSON.stringify(row.settings) !== JSON.stringify(expected.settings))
      return false
    row.settings.ilinkCheckpoint = next
    return true
  })
  let polls = 0
  wire.onHttp = (req) => {
    if (req.url.pathname.endsWith("/getupdates"))
      return ++polls < 4 ? respond(req, polls) : idle.promise
    if (req.url.pathname.endsWith("/sendmessage")) return { body: { ret: 0 } }
    return { status: 404, body: {} }
  }
  const credential = { value: "synthetic-token-A", revision: "revision-A" }
  const adapter = createWechatPersonalAdapter({
    id: row.id,
    displayName: "Wire",
    token: async () => credential.value,
    tokenSnapshot: async () => ({ ...credential }),
    baseUrl: async () => wire.origin,
    _backoffBaseMs: 1,
  })
  try {
    await adapter.start(wire.context(adapter.id, emit))
    await run(wire, adapter, row, credential)
    expect(wire.errors).toEqual([])
  } finally {
    await adapter.stop()
    options.cleanup?.()
    idle.resolve({ body: { ret: 0, msgs: [] } })
    await wire.close()
    await waitFor(() => wire.httpInFlight === 0, "personal poll completion")
  }
}

describe("WeChat Personal production adapter over actual loopback HTTP", () => {
  it("normalizes two peers, checkpoints accepted input and replies with each peer's context token", async () => {
    const events: NormalizedInboundEvent[] = []
    const parked = deferred<WireResponse>()
    try {
      await withPersonal(
        async (wire, adapter, row) => {
          await waitFor(
            () =>
              wire.requests.filter((req) => req.url.pathname.endsWith("/getupdates")).length === 2,
            "checkpointed next poll"
          )
          expect(events.map((event) => event.plainText)).toEqual(["hello-A", "hello-B"])
          expect(row.settings.ilinkCheckpoint).toMatchObject({ cursor: "next-cursor" })
          expect(wire.requests[1].body.get_updates_buf).toBe("next-cursor")
          expect((await adapter.send(textRequest(events[0]))).ok).toBe(true)
          expect((await adapter.send(textRequest(events[1]))).ok).toBe(true)
          const sends = wire.requests.filter((req) => req.url.pathname.endsWith("/sendmessage"))
          expect(sends.map((req) => req.body.msg)).toEqual([
            expect.objectContaining({
              to_user_id: "A",
              context_token: "context-A",
              item_list: [{ type: 1, text_item: { text: "回复中文 ✓" } }],
            }),
            expect.objectContaining({
              to_user_id: "B",
              context_token: "context-B",
              item_list: [{ type: 1, text_item: { text: "回复中文 ✓" } }],
            }),
          ])
          expect(
            sends.every((req) => req.headers.authorization === "Bearer synthetic-token-A")
          ).toBe(true)
          parked.resolve({ body: { ret: -14 } })
        },
        (_req, poll) =>
          poll === 1
            ? {
                body: {
                  ret: 0,
                  msgs: [personalMessage("A"), personalMessage("B")],
                  get_updates_buf: "next-cursor",
                },
              }
            : parked.promise,
        async (event) => {
          events.push(event)
        },
        { cleanup: () => parked.resolve({ body: { ret: -14 } }) }
      )
    } finally {
      parked.resolve({ body: { ret: -14 } })
    }
  })

  it("retries unaccepted input from the original HTTP cursor before committing progress", async () => {
    let attempts = 0
    const parked = deferred<WireResponse>()
    try {
      await withPersonal(
        async (wire, _adapter, row) => {
          await waitFor(() => wire.requests.length === 3, "retry and next poll")
          expect(wire.requests.map((req) => req.body.get_updates_buf)).toEqual(["", "", "accepted"])
          expect(attempts).toBe(2)
          expect(commitCheckpoint).toHaveBeenCalledTimes(1)
          expect(row.settings.ilinkCheckpoint).toMatchObject({ cursor: "accepted" })
          parked.resolve({ body: { ret: -14 } })
        },
        (_req, poll) =>
          poll <= 2
            ? { body: { ret: 0, msgs: [personalMessage("A")], get_updates_buf: "accepted" } }
            : parked.promise,
        async () => {
          if (++attempts === 1) throw new Error("acceptance rejected")
        },
        { cleanup: () => parked.resolve({ body: { ret: -14 } }) }
      )
    } finally {
      parked.resolve({ body: { ret: -14 } })
    }
  })

  it("ignores a real HTTP response arriving after stop", async () => {
    const held = deferred<WireResponse>(),
      events: NormalizedInboundEvent[] = []
    try {
      await withPersonal(
        async (wire, adapter, row) => {
          await waitFor(() => wire.requests.length === 1, "held HTTP poll")
          await adapter.stop()
          held.resolve({
            body: { ret: 0, msgs: [personalMessage("old")], get_updates_buf: "stale" },
          })
          await waitFor(() => wire.httpInFlight === 0, "late response completion")
          expect(events).toEqual([])
          expect(row.settings.ilinkCheckpoint).toBeUndefined()
          expect(commitCheckpoint).not.toHaveBeenCalled()
        },
        () => held.promise,
        async (event) => {
          events.push(event)
        },
        { cleanup: () => held.resolve({ body: { ret: -14 } }) }
      )
    } finally {
      held.resolve({ body: { ret: -14 } })
    }
  })

  it.each(["token-and-revision", "revision-only"])(
    "does not reuse a held old-login response after %s rotation",
    async (mode) => {
      const held = deferred<WireResponse>(),
        parked = deferred<WireResponse>(),
        events: NormalizedInboundEvent[] = []
      try {
        await withPersonal(
          async (wire, _adapter, row, credential) => {
            await waitFor(() => wire.requests.length === 1, "old login poll")
            if (mode === "token-and-revision") credential.value = "synthetic-token-B"
            credential.revision = "revision-B"
            held.resolve({
              body: { ret: 0, msgs: [personalMessage("old")], get_updates_buf: "stale" },
            })
            await waitFor(() => wire.requests.length === 2, "new login poll")
            expect(wire.requests[1].headers.authorization).toBe(
              `Bearer ${mode === "token-and-revision" ? "synthetic-token-B" : "synthetic-token-A"}`
            )
            expect(wire.requests[1].body.get_updates_buf).toBe("")
            expect(events).toEqual([])
            expect(row.settings.ilinkCheckpoint).toBeUndefined()
            parked.resolve({ body: { ret: -14 } })
          },
          (_req, poll) => (poll === 1 ? held.promise : parked.promise),
          async (event) => {
            events.push(event)
          },
          {
            cleanup: () => {
              held.resolve({ body: { ret: -14 } })
              parked.resolve({ body: { ret: -14 } })
            },
          }
        )
      } finally {
        held.resolve({ body: { ret: -14 } })
        parked.resolve({ body: { ret: -14 } })
      }
    }
  )

  it.each(["matching", "baseUrl", "credentialHash", "credentialRevision", "accountId"])(
    "restores only a checkpoint whose %s ownership matches the current login",
    async (field) => {
      await withPersonal(
        async (wire) => {
          await waitFor(() => wire.requests.length === 1, "first restored poll")
          expect(wire.requests[0].body.get_updates_buf).toBe(field === "matching" ? "saved" : "")
        },
        () => ({ body: { ret: -14 } }),
        async () => {},
        {
          checkpoint: (origin) => ({
            baseUrl: origin,
            credentialHash: createHash("sha256").update("synthetic-token-A").digest("hex"),
            credentialRevision: "revision-A",
            accountId: "account-A",
            cursor: "saved",
            ...(field === "matching" ? {} : { [field]: "foreign-owner" }),
          }),
        }
      )
    }
  )
})

const oaXml = (id: string) =>
  `<xml><ToUserName>gh_bot</ToUserName><FromUserName>openid-A</FromUserName><CreateTime>1</CreateTime><MsgType>text</MsgType><Content><![CDATA[hello-${id}]]></Content><MsgId>${id}</MsgId></xml>`
type JournalRow = { id: string; xml: string; admitted?: boolean }

async function withOa(
  run: (
    wire: ConnectorLoopback,
    adapter: PlatformAdapter,
    journal: Map<string, JournalRow>,
    controller: AbortController
  ) => Promise<void>,
  emit: (event: NormalizedInboundEvent, adapter: PlatformAdapter) => Promise<void>,
  options: { ackFailure?: boolean; seeded?: boolean } = {}
) {
  const wire = await new ConnectorLoopback().open()
  const journal = new Map<string, JournalRow>()
  if (options.seeded)
    journal.set("occurrence-seeded", { id: "occurrence-seeded", xml: oaXml("seeded") })
  let occurrence = 0
  const emissionsBeforeClaim: string[] = []
  let failedAck = false
  wire.onCommand = async (name, args) => {
    if (args?.adapterId !== "wire-oa") throw new Error("wrong journal owner")
    if (name === "connectors_wechat_oa_inbound_list")
      return [...journal.values()].map((row) => ({ ...row }))
    if (name === "connectors_wechat_oa_inbound_claim") {
      const row = journal.get(String(args.id))
      if (row) row.admitted = true
      return Boolean(row)
    }
    if (name === "connectors_wechat_oa_inbound_ack") {
      if (options.ackFailure && !failedAck) {
        failedAck = true
        throw new Error("ACK write failed")
      }
      journal.delete(String(args.id))
      return
    }
    throw new Error(`unexpected native journal command ${name}`)
  }
  wire.onHttp = (req) => {
    if (req.url.pathname === "/inbound") {
      const id = `occurrence-${++occurrence}`
      journal.set(id, { id, xml: req.raw })
      wire.emit("connectors://webhook/wire-oa", { xml: req.raw, ingressId: id })
      return { body: { accepted: true } }
    }
    if (req.url.pathname === "/cgi-bin/message/custom/send") return { body: { errcode: 0 } }
    return { status: 404, body: {} }
  }
  const adapter = createWechatOaAdapter({
    id: "wire-oa",
    displayName: "Wire",
    accessToken: async () => "synthetic-oa-token",
    apiBase: wire.origin,
  })
  const controller = new AbortController()
  try {
    await adapter.start(
      wire.context(
        adapter.id,
        (event) => {
          if (
            ![...journal.values()].some(
              (row) => row.admitted && row.xml.includes(`<MsgId>${event.messageId}</MsgId>`)
            )
          )
            emissionsBeforeClaim.push(event.messageId)
          return emit(event, adapter)
        },
        controller.signal
      )
    )
    await waitFor(() => wire.listeners.size === 1, "OA webhook subscription")
    await run(wire, adapter, journal, controller)
    expect(emissionsBeforeClaim).toEqual([])
    expect(wire.errors).toEqual([])
  } finally {
    try {
      await adapter.stop()
      await waitFor(() => wire.listeners.size === 0, "OA listener closure")
    } finally {
      await wire.close()
    }
  }
}

const injectOa = (wire: ConnectorLoopback, providerId = "live") =>
  wire.http({
    url: `${wire.origin}/inbound`,
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: oaXml(providerId),
  })

describe("WeChat OA production adapter over actual loopback HTTP and journal fixture", () => {
  it("claims actual XML input, emits a normalized event, sends UTF-8 output and ACKs the exact occurrence", async () => {
    const events: NormalizedInboundEvent[] = []
    await withOa(
      async (wire, _adapter, journal) => {
        await injectOa(wire)
        await waitFor(
          () =>
            wire.commands.some((command) => command.name === "connectors_wechat_oa_inbound_ack"),
          "journal ACK"
        )
        expect(journal.size).toBe(0)
        expect(events.map((event) => event.plainText)).toEqual(["hello-live"])
        const send = wire.requests.find(
          (req) => req.url.pathname === "/cgi-bin/message/custom/send"
        )!
        expect(send.url.searchParams.get("access_token")).toBe("synthetic-oa-token")
        expect(send.body).toEqual({
          touser: "openid-A",
          msgtype: "text",
          text: { content: "回复中文 ✓" },
        })
        expect(
          wire.commands
            .filter((command) => command.name.endsWith("_claim") || command.name.endsWith("_ack"))
            .map((command) => [command.name, command.args?.id])
        ).toEqual([
          ["connectors_wechat_oa_inbound_claim", "occurrence-1"],
          ["connectors_wechat_oa_inbound_ack", "occurrence-1"],
        ])
      },
      async (event, adapter) => {
        events.push(event)
        expect((await adapter.send(textRequest(event))).ok).toBe(true)
      }
    )
  })

  it("retries only a failed journal ACK without re-emitting or repeating its real outbound HTTP", async () => {
    let emits = 0
    await withOa(
      async (wire, _adapter, journal) => {
        await injectOa(wire)
        await waitFor(() => journal.size === 0, "retried ACK")
        expect(emits).toBe(1)
        expect(
          wire.requests.filter((req) => req.url.pathname === "/cgi-bin/message/custom/send")
        ).toHaveLength(1)
        expect(wire.commands.filter((command) => command.name.endsWith("_claim"))).toHaveLength(1)
        expect(wire.commands.filter((command) => command.name.endsWith("_ack"))).toHaveLength(2)
      },
      async (event, adapter) => {
        emits++
        expect((await adapter.send(textRequest(event))).ok).toBe(true)
      },
      { ackFailure: true }
    )
  })

  it("recovers an unnotified journal occurrence at startup", async () => {
    const events: NormalizedInboundEvent[] = []
    await withOa(
      async (_wire, _adapter, journal) => {
        await waitFor(() => journal.size === 0, "startup recovery")
        expect(events.map((event) => event.plainText)).toEqual(["hello-seeded"])
      },
      async (event) => {
        events.push(event)
      },
      { seeded: true }
    )
  })

  it("runtime abort retires the listener before another occurrence can be admitted", async () => {
    const events: NormalizedInboundEvent[] = []
    await withOa(
      async (wire, adapter, journal, controller) => {
        controller.abort()
        await injectOa(wire)
        expect(wire.listeners.size).toBe(0)
        expect(adapter.health().state).toBe("down")
        expect(events).toEqual([])
        expect(journal.has("occurrence-1")).toBe(true)
        expect(wire.commands.some((command) => command.name.endsWith("_claim"))).toBe(false)
      },
      async (event) => {
        events.push(event)
      }
    )
  })

  it("a held or rejected native claim cannot publish the event or acknowledge it", async () => {
    const entered = deferred<void>(),
      release = deferred<boolean>()
    const events: NormalizedInboundEvent[] = []
    try {
      await withOa(
        async (wire, _adapter, journal) => {
          const native = wire.onCommand!
          wire.onCommand = async (name, args) => {
            if (name.endsWith("_claim")) {
              entered.resolve()
              return release.promise
            }
            return native(name, args)
          }
          await injectOa(wire)
          await entered.promise
          expect(events).toEqual([])
          expect(wire.commands.some((command) => command.name.endsWith("_ack"))).toBe(false)
          journal.delete("occurrence-1")
          release.resolve(false)
          wire.onCommand = native
          await injectOa(wire, "accepted")
          await waitFor(() => journal.size === 0, "subsequent valid occurrence completion")
          expect(events.map((event) => event.plainText)).toEqual(["hello-accepted"])
          expect(
            wire.commands
              .filter((command) => command.name.endsWith("_ack"))
              .map((command) => command.args?.id)
          ).toEqual(["occurrence-2"])
        },
        async (event) => {
          events.push(event)
        }
      )
    } finally {
      release.resolve(false)
    }
  })

  it("ACKs distinct native occurrences independently even when their provider MsgId is identical", async () => {
    const first = deferred<void>(),
      second = deferred<void>()
    let emits = 0
    try {
      await withOa(
        async (wire, _adapter, journal) => {
          await injectOa(wire)
          await waitFor(() => emits === 1, "first occurrence acceptance")
          await injectOa(wire)
          expect(journal.size).toBe(2)
          first.resolve()
          await waitFor(() => emits === 2, "second occurrence acceptance")
          expect(journal.has("occurrence-1")).toBe(false)
          expect(journal.has("occurrence-2")).toBe(true)
          second.resolve()
          await waitFor(() => journal.size === 0, "independent occurrence ACKs")
          expect(
            wire.commands
              .filter((command) => command.name.endsWith("_ack"))
              .map((command) => command.args?.id)
          ).toEqual(["occurrence-1", "occurrence-2"])
        },
        async () => {
          if (++emits === 1) await first.promise
          else await second.promise
        }
      )
    } finally {
      first.resolve()
      second.resolve()
    }
  })
})
