/** Production adapter + native crypto/HTTP + actual DB APIs over Node IndexedDB. */
import { withMatrixNative, identity, room, type MatrixRelay } from "./matrix-native"
import { deferred, waitFor, type ConnectorLoopback, type WireResponse } from "./connector-loopback"
import { createMatrixAdapter } from "@/lib/connectors/adapters/matrix"
import { createAdapterInstance, getAdapterInstance } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import { connectorsMatrixCryptoEncryptEvent } from "@/lib/connectors/tauri/commands"
import type { MatrixTimelineEvent } from "@/lib/connectors/adapters/matrix/parse"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

export interface RunningMatrix {
  wire: ConnectorLoopback
  adapter: ReturnType<typeof createMatrixAdapter>
  relay: MatrixRelay
  events: NormalizedInboundEvent[]
  controller: AbortController
  reply: (body: Record<string, unknown>) => void
  since: () => Promise<unknown>
  restart: () => Promise<void>
}

export async function encryptedTimeline(
  text: string,
  id = "$inbound"
): Promise<MatrixTimelineEvent> {
  const { content } = await connectorsMatrixCryptoEncryptEvent({
    adapterId: "alice",
    roomId: room,
    eventType: "m.room.message",
    content: { msgtype: "m.text", body: text },
  })
  return {
    type: "m.room.encrypted",
    event_id: id,
    sender: identity("alice").userId,
    origin_server_ts: Date.now(),
    content: content as MatrixTimelineEvent["content"],
  }
}

export async function withRunningMatrix(
  run: (state: RunningMatrix) => Promise<void>,
  options: {
    holdRoomKeys?: boolean
    initialSince?: string | null
    token?: () => Promise<string>
    emit?: (event: NormalizedInboundEvent) => Promise<void>
  } = {}
) {
  await withMatrixNative(async (wire, exchange, relay) => {
    await exchange(false, options.holdRoomKeys)
    const row = await createAdapterInstance({
      type: "matrix",
      displayName: "Native Matrix",
      enabled: true,
      transportMode: "longpoll",
      settings: {},
      credentialsRef: { keyringService: "fixture", accounts: [] },
      trigger: {
        rules: [{ kind: "private-default" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
    })
    await getDb().adapterInstances.put({
      ...row,
      id: "bob",
      settings: {
        homeserver: wire.origin,
        preserve: "settings",
        ...(options.initialSince === null
          ? {}
          : { syncSinceToken: options.initialSince ?? "seed" }),
      },
    })
    const pending: ReturnType<typeof deferred<WireResponse>>[] = []
    const queue: WireResponse[] = []
    let stopped = false
    wire.onHttp = async (request) => {
      const crypto = relay.respond(request)
      if (crypto) return crypto
      const path = request.url.pathname
      if (path.endsWith("/sync")) {
        if (stopped) return { status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } }
        if (queue.length) return queue.shift()!
        const next = deferred<WireResponse>()
        pending.push(next)
        return next.promise
      }
      if (path.endsWith("/joined_members"))
        return {
          body: { joined: { [identity("alice").userId]: {}, [identity("bob").userId]: {} } },
        }
      if (path.endsWith("/state/m.room.encryption"))
        return { body: { algorithm: "m.megolm.v1.aes-sha2" } }
      if (path.includes("/send/m.room.encrypted/")) return { body: { event_id: "$sent-native" } }
      return { status: 404, body: { errcode: "M_NOT_FOUND" } }
    }
    const controller = new AbortController()
    const adapter = createMatrixAdapter({
      id: "bob",
      displayName: "Native",
      homeserver: wire.origin,
      accessToken: options.token ?? (async () => "fixture-bob"),
      selfId: identity("bob").userId,
      deviceId: identity("bob").deviceId,
    })
    const events: NormalizedInboundEvent[] = []
    const ctx = wire.context(
      "bob",
      async (event) => {
        await options.emit?.(event)
        events.push(event)
      },
      controller.signal
    )
    const state: RunningMatrix = {
      wire,
      adapter,
      relay,
      events,
      controller,
      reply: (body) => {
        const next = pending.shift()
        const response = { body }
        if (next) next.resolve(response)
        else queue.push(response)
      },
      restart: async () => {
        await adapter.start(ctx)
      },
      since: async () => (await getAdapterInstance("bob"))?.settings.syncSinceToken,
    }
    try {
      await adapter.start(ctx)
      await waitFor(
        () => wire.requests.some((request) => request.url.pathname.endsWith("/sync")),
        "first native sync request"
      )
      await run(state)
    } finally {
      stopped = true
      for (const next of pending.splice(0))
        next.resolve({ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } })
      await adapter.stop()
    }
  })
}
