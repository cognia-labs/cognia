import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { withRunningMatrix, encryptedTimeline } from "@/cli/src/test-support/matrix-adapter-native"
import { identity, room } from "@/cli/src/test-support/matrix-native"
import { deferred, waitFor } from "@/cli/src/test-support/connector-loopback"
import {
  connectorsMatrixCryptoReceiveSyncChanges,
  connectorsMatrixCryptoDecryptEvent,
} from "@/lib/connectors/tauri/commands"

jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))
const nativeOnly = process.env.COGNIA_IM_NATIVE === "1" ? describe : describe.skip
const db = createDbTestFixture({ seeded: false })
nativeOnly("production Matrix adapter sync over real native crypto/HTTP", () => {
  beforeAll(db.initialize)
  beforeEach(db.restore)
  afterAll(db.dispose)

  it("decrypts sync input, sends an encrypted reply and persists the resume cursor on stop", async () => {
    await withRunningMatrix(async ({ wire, adapter, events, reply, since, relay }) => {
      expect(
        wire.requests
          .find((req) => req.url.pathname.endsWith("/sync"))
          ?.url.searchParams.get("since")
      ).toBe("seed")
      reply({
        next_batch: "accepted",
        rooms: {
          join: { [room]: { timeline: { events: [await encryptedTimeline("sync message")] } } },
        },
      })
      await waitFor(() => events.length === 1, "normalized native sync event")
      expect(events[0].plainText).toBe("sync message")
      expect(
        (
          await adapter.send({
            conversationRef: events[0].conversationRef,
            segments: [{ type: "text", text: "encrypted adapter reply" }],
            metadata: { idempotencyKey: "native-reply" },
          })
        ).ok
      ).toBe(true)
      const sent = wire.requests.find((req) =>
        req.url.pathname.includes("/send/m.room.encrypted/")
      )!
      expect(JSON.stringify(sent.body)).not.toContain("encrypted adapter reply")
      await connectorsMatrixCryptoReceiveSyncChanges({
        adapterId: "alice",
        toDeviceEvents: relay.inbox.get(identity("alice").userId) ?? [],
      })
      const decrypted = await connectorsMatrixCryptoDecryptEvent({
        adapterId: "alice",
        roomId: room,
        event: {
          type: "m.room.encrypted",
          event_id: "$reply",
          sender: identity("bob").userId,
          origin_server_ts: Date.now(),
          content: sent.body,
        },
      })
      expect((decrypted.event as { event: { content: { body: string } } }).event.content.body).toBe(
        "encrypted adapter reply"
      )
      await waitFor(
        () => wire.requests.filter((req) => req.url.pathname.endsWith("/sync")).length >= 2,
        "next sync cursor"
      )
      await adapter.stop()
      expect(await since()).toBe("accepted")
      expect((await getDb().adapterInstances.get("bob"))?.settings.preserve).toBe("settings")
    })
  }, 30000)

  it("retains missing-key input through production pending DB, then recovers it on to-device sync", async () => {
    await withRunningMatrix(
      async ({ wire, reply, events, relay, adapter }) => {
        reply({
          next_batch: "pending",
          rooms: {
            join: { [room]: { timeline: { events: [await encryptedTimeline("late key")] } } },
          },
        })
        await waitFor(
          () => wire.requests.filter((req) => req.url.pathname.endsWith("/sync")).length >= 2,
          "retained missing-key batch"
        )
        expect(events).toEqual([])
        expect(
          await getDb().matrixPendingEncryptedEvents.where("adapterId").equals("bob").count()
        ).toBe(1)
        reply({
          next_batch: "keys-recovered",
          to_device: { events: relay.inbox.get(identity("bob").userId) ?? [] },
          rooms: { join: {} },
        })
        await waitFor(() => events.length === 1, "real late-key recovery")
        expect(events[0].plainText).toBe("late key")
        await waitFor(
          () => wire.requests.filter((req) => req.url.pathname.endsWith("/sync")).length >= 3,
          "recovery batch completed"
        )
        expect(await getDb().matrixPendingEncryptedEvents.count()).toBe(0)
        await adapter.stop()
      },
      { holdRoomKeys: true }
    )
  }, 30000)

  it("does not checkpoint a rejected durable admission", async () => {
    const attempted = deferred<void>()
    await withRunningMatrix(
      async ({ reply, adapter, since, wire }) => {
        reply({
          next_batch: "must-not-commit",
          rooms: {
            join: { [room]: { timeline: { events: [await encryptedTimeline("rejected")] } } },
          },
        })
        await attempted.promise
        await waitFor(
          () =>
            adapter.health().state === "degraded" ||
            wire.requests.filter((req) => req.url.pathname.endsWith("/sync")).length >= 2,
          "admission failure fence"
        )
        await adapter.stop()
        expect(await since()).toBe("seed")
      },
      {
        emit: async () => {
          attempted.resolve()
          throw new Error("Synthetic durable admission failure")
        },
      }
    )
  }, 30000)

  it("stops the actual sync session when its owning runtime aborts", async () => {
    await withRunningMatrix(async ({ controller, adapter, wire, reply, events }) => {
      controller.abort()
      await waitFor(() => adapter.health().state === "down", "owning runtime cancellation")
      reply({
        next_batch: "late",
        rooms: {
          join: { [room]: { timeline: { events: [await encryptedTimeline("too late")] } } },
        },
      })
      expect(events).toEqual([])
      expect(wire.errors).toEqual([])
    })
  }, 30000)

  it("awaits initializing native acquisition before closing and restarting", async () => {
    await withRunningMatrix(async ({ adapter, wire, restart }) => {
      await adapter.stop()
      const acquired = deferred<void>()
      const release = deferred<void>()
      let held = false
      wire.onCommand = async (name, args) => {
        const result = await wire.native!.call(name, args)
        if (name === "connectors_matrix_crypto_init" && !held) {
          held = true
          acquired.resolve()
          await release.promise
        }
        return result
      }
      const starting = restart()
      await acquired.promise
      let stopped = false
      const stopping = adapter.stop().then(() => {
        stopped = true
      })
      try {
        await wire.native!.call("connectors_matrix_crypto_outgoing_requests", { adapterId: "bob" })
        expect(stopped).toBe(false)
      } finally {
        release.resolve()
        await Promise.all([starting, stopping])
        wire.onCommand = undefined
      }
      await restart()
      expect(adapter.health().state).toBe("running")
      await expect(
        wire.native!.call("connectors_matrix_crypto_outgoing_requests", { adapterId: "bob" })
      ).resolves.toEqual(expect.any(Array))
    })
  }, 30000)

  it("retains pending recovery if cancellation overtakes decrypt, then admits after restart", async () => {
    await withRunningMatrix(
      async ({ adapter, wire, relay, reply, events, restart }) => {
        reply({
          next_batch: "pending",
          rooms: {
            join: {
              [room]: { timeline: { events: [await encryptedTimeline("cancelled recovery")] } },
            },
          },
        })
        await waitFor(
          () => wire.requests.filter((req) => req.url.pathname.endsWith("/sync")).length >= 2,
          "pending event retained"
        )
        const decrypted = deferred<void>()
        const release = deferred<void>()
        let held = false
        wire.onCommand = async (name, args) => {
          const result = await wire.native!.call(name, args)
          if (name === "connectors_matrix_crypto_decrypt_event" && !held) {
            held = true
            decrypted.resolve()
            await release.promise
          }
          return result
        }
        reply({
          next_batch: "recover",
          to_device: { events: relay.inbox.get(identity("bob").userId) ?? [] },
          rooms: { join: {} },
        })
        await decrypted.promise
        const stopping = adapter.stop()
        release.resolve()
        await stopping
        wire.onCommand = undefined
        expect(events).toEqual([])
        expect(
          await getDb().matrixPendingEncryptedEvents.where("adapterId").equals("bob").count()
        ).toBe(1)
        await restart()
        expect(events.map((event) => event.plainText)).toEqual(["cancelled recovery"])
        expect(await getDb().matrixPendingEncryptedEvents.count()).toBe(0)
      },
      { holdRoomKeys: true }
    )
  }, 30000)

  it("backfills real encrypted downtime events oldest-first through multiple HTTP pages", async () => {
    await withRunningMatrix(async ({ wire, reply, events, adapter, since }) => {
      const gap1 = await encryptedTimeline("native gap one", "$gap-one")
      const gap2 = await encryptedTimeline("native gap two", "$gap-two")
      const live = await encryptedTimeline("native live", "$gap-live")
      const original = wire.onHttp
      wire.onHttp = (request) => {
        if (request.url.pathname.endsWith("/messages")) {
          expect(request.url.searchParams.get("to")).toBe("seed")
          const from = request.url.searchParams.get("from")
          if (from === "page-one") return { body: { chunk: [gap2], end: "empty-page" } }
          if (from === "empty-page") return { body: { chunk: [], end: "page-two" } }
          expect(from).toBe("page-two")
          return { body: { chunk: [gap1] } }
        }
        return original(request)
      }
      reply({
        next_batch: "gap-completed",
        rooms: {
          join: { [room]: { timeline: { events: [live], limited: true, prev_batch: "page-one" } } },
        },
      })
      await waitFor(() => events.length === 3, "native multi-page backfill delivery")
      expect(events.map((event) => event.plainText)).toEqual([
        "native gap one",
        "native gap two",
        "native live",
      ])
      expect(events.map((event) => event.messageId)).toEqual(
        ["$gap-one", "$gap-two", "$gap-live"].map((id) => `${room}|${id}`)
      )
      const pages = wire.requests.filter((request) => request.url.pathname.endsWith("/messages"))
      expect(pages.map((request) => request.url.searchParams.get("from"))).toEqual([
        "page-one",
        "empty-page",
        "page-two",
      ])
      await adapter.stop()
      expect(await since()).toBe("gap-completed")
    })
  }, 30000)

  it("retries failed native gap recovery from the original cursor without skipping downtime", async () => {
    await withRunningMatrix(async ({ wire, reply, events, adapter, since }) => {
      const olderGap = await encryptedTimeline("native older recovered gap", "$retry-older")
      const gap = await encryptedTimeline("native recovered gap", "$retry-gap")
      const live = await encryptedTimeline("native recovered live", "$retry-live")
      const original = wire.onHttp
      let attempts = 0
      let failed = false
      wire.onHttp = (request) => {
        if (request.url.pathname.endsWith("/messages")) {
          attempts++
          expect(request.url.searchParams.get("to")).toBe("seed")
          if (request.url.searchParams.get("from") === "gap-retry-page")
            return { body: { chunk: [gap], end: "older-page" } }
          expect(request.url.searchParams.get("from")).toBe("older-page")
          if (!failed) {
            failed = true
            return { status: 503, body: { errcode: "M_UNAVAILABLE" } }
          }
          return { body: { chunk: [olderGap] } }
        }
        return original(request)
      }
      const batch = {
        next_batch: "gap-retried",
        rooms: {
          join: {
            [room]: { timeline: { events: [live], limited: true, prev_batch: "gap-retry-page" } },
          },
        },
      }
      reply(batch)
      await waitFor(
        () => wire.requests.filter((request) => request.url.pathname.endsWith("/sync")).length >= 2,
        "retry poll after real backfill rejection"
      )
      expect(events).toEqual([])
      expect(await since()).toBe("seed")
      expect(
        wire.requests
          .filter((request) => request.url.pathname.endsWith("/sync"))
          .map((request) => request.url.searchParams.get("since"))
      ).toEqual(["seed", "seed"])
      reply(batch)
      await waitFor(() => events.length === 3, "retried native gap and live delivery")
      expect(events.map((event) => event.plainText)).toEqual([
        "native older recovered gap",
        "native recovered gap",
        "native recovered live",
      ])
      expect(attempts).toBe(4)
      await adapter.stop()
      expect(await since()).toBe("gap-retried")
    })
  }, 30000)

  it("does not deliver or checkpoint a late native backfill response after stop", async () => {
    await withRunningMatrix(async ({ wire, reply, events, adapter, since, restart }) => {
      const gap = await encryptedTimeline("late gap", "$late-gap")
      const live = await encryptedTimeline("live after restart", "$late-live")
      const reached = deferred<void>()
      const release = deferred<void>()
      const original = wire.onHttp
      let hold = true
      wire.onHttp = async (request) => {
        if (request.url.pathname.endsWith("/messages")) {
          expect(request.url.searchParams.get("to")).toBe("seed")
          if (hold) {
            reached.resolve()
            await release.promise
          }
          return { body: { chunk: [gap] } }
        }
        return original(request)
      }
      const batch = {
        next_batch: "late-gap-completed",
        rooms: {
          join: {
            [room]: { timeline: { events: [live], limited: true, prev_batch: "late-page" } },
          },
        },
      }
      try {
        reply(batch)
        await reached.promise
        await adapter.stop()
        hold = false
        release.resolve()
        await waitFor(() => wire.native!.pendingCount === 0, "abandoned native backfill drained")
        expect(events).toEqual([])
        expect(await since()).toBe("seed")
        const offset = wire.requests.length
        await restart()
        await waitFor(
          () =>
            wire.requests.slice(offset).some((request) => request.url.pathname.endsWith("/sync")),
          "restarted gap request"
        )
        expect(
          wire.requests
            .slice(offset)
            .find((request) => request.url.pathname.endsWith("/sync"))!
            .url.searchParams.get("since")
        ).toBe("seed")
        reply(batch)
        await waitFor(() => events.length === 2, "restart recovers cancelled gap")
        expect(events.map((event) => event.plainText)).toEqual(["late gap", "live after restart"])
        expect(events.map((event) => event.messageId)).toEqual([
          `${room}|$late-gap`,
          `${room}|$late-live`,
        ])
        await adapter.stop()
        expect(await since()).toBe("late-gap-completed")
      } finally {
        hold = false
        release.resolve()
      }
    })
  }, 30000)
})
