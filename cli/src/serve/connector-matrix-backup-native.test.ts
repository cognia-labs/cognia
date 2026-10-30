import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { persistMatrixPendingEncryptedEvent } from "@/lib/db/matrix-pending-events"
import { createMatrixAdapter } from "@/lib/connectors/adapters/matrix"
import {
  connectorsMatrixCryptoBackup as backup,
  connectorsMatrixCryptoDecryptEvent as decrypt,
} from "@/lib/connectors/tauri/commands"
import {
  withRunningMatrix,
  encryptedTimeline,
  type RunningMatrix,
} from "@/cli/src/test-support/matrix-adapter-native"
import { room, identity } from "@/cli/src/test-support/matrix-native"
import { deferred, waitFor, type WireResponse } from "@/cli/src/test-support/connector-loopback"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

jest.mock("@/lib/connectors/at-gate", () => ({ gateInboundEvent: jest.fn(async () => true) }))
const nativeOnly = process.env.COGNIA_IM_NATIVE === "1" ? describe : describe.skip
const db = createDbTestFixture({ seeded: false })
type Json = Record<string, unknown>

function server(state: RunningMatrix) {
  const original = state.wire.onHttp
  const saved = {
    info: undefined as Json | undefined,
    rooms: {} as Json,
    creates: 0,
    versionReads: 0,
    uploads: 0,
    failCreate: false,
    hideVersion: false,
    holdUpload: undefined as Promise<WireResponse> | undefined,
  }
  state.wire.onHttp = async (request) => {
    if (request.url.pathname.includes("/room_keys/version")) {
      if (request.method === "POST") {
        saved.creates++
        saved.info = { ...request.body, version: "v1", count: 0, etag: "native-version" }
        if (saved.failCreate) return { status: 503, body: { errcode: "lost-create-response" } }
        return { body: { version: "v1" } }
      }
      saved.versionReads++
      return saved.info && !saved.hideVersion
        ? { body: saved.info }
        : { status: 404, body: { errcode: "M_NOT_FOUND" } }
    }
    if (request.url.pathname.endsWith("/room_keys/keys")) {
      expect(request.url.searchParams.get("version")).toBe("v1")
      if (request.method === "PUT") {
        saved.uploads++
        saved.rooms = request.body.rooms as Json
        return saved.holdUpload ?? { body: { count: 1, etag: "native-etag" } }
      }
      return { body: { rooms: saved.rooms } }
    }
    return original(request)
  }
  return saved
}

nativeOnly("formal Matrix key backup through production adapter and native crypto", () => {
  beforeAll(db.initialize)
  beforeEach(db.restore)
  afterAll(db.dispose)

  it("cancels a persisted claim when POST is provably not dispatched and allows a later create", async () => {
    let hold = false
    let saved: ReturnType<typeof server> | undefined
    const entered = deferred<void>()
    const release = deferred<void>()
    await withRunningMatrix(
      async (state) => {
        saved = server(state)
        hold = true
        const creating = state.adapter.keyBackup!.create()
        const rejected = expect(creating).rejects.toThrow("owner stopped before dispatch")
        try {
          await entered.promise
          await state.adapter.stop()
        } finally {
          hold = false
          release.resolve()
        }
        await rejected
        expect(saved.creates).toBe(0)
        await state.restart()
        expect((await state.adapter.keyBackup!.create()).version).toBe("v1")
        expect(saved.creates).toBe(1)
      },
      {
        token: async () => {
          if (hold && saved && saved.versionReads > 0) {
            entered.resolve()
            await release.promise
          }
          return "fixture-bob"
        },
      }
    )
  }, 30000)

  it("atomically claims creation and preserves an unresolved key against foreign restore", async () => {
    await withRunningMatrix(async (_state) => {
      const prepared = await backup({ adapterId: "bob", action: "prepare" })
      const begin = {
        adapterId: "bob",
        action: "beginCreate" as const,
        backupInfo: prepared.backupInfo,
      }
      const claims = await Promise.allSettled([
        backup({ ...begin, createClaim: crypto.randomUUID() }),
        backup({ ...begin, createClaim: crypto.randomUUID() }),
      ])
      expect(claims.filter((value) => value.status === "fulfilled")).toHaveLength(1)
      expect(claims.filter((value) => value.status === "rejected")).toHaveLength(1)
      const other = await backup({ adapterId: "alice", action: "prepare" })
      await expect(
        backup({
          adapterId: "bob",
          action: "restore",
          recoveryKey: other.recoveryKey,
          backupInfo: { ...other.backupInfo, version: "old" },
          version: "old",
          rooms: {},
        })
      ).rejects.toThrow("Unresolved Matrix backup creation")
      const retained = await backup({ adapterId: "bob", action: "prepare" })
      expect(retained.createPending).toBe(true)
      expect(retained.recoveryKey === prepared.recoveryKey).toBe(true)
    })
  }, 30000)

  it("does not dispatch backup after ownership stops during token acquisition", async () => {
    let hold = false
    const entered = deferred<void>()
    const release = deferred<void>()
    await withRunningMatrix(
      async (state) => {
        const saved = server(state)
        hold = true
        const creating = state.adapter.keyBackup!.create()
        const rejected = expect(creating).rejects.toThrow(
          /not active|owner stopped before dispatch/
        )
        try {
          await entered.promise
          await state.adapter.stop()
        } finally {
          release.resolve()
        }
        await rejected
        expect(saved.creates).toBe(0)
        expect(
          state.wire.requests.filter((request) => request.url.pathname.includes("/room_keys/"))
        ).toEqual([])
      },
      {
        token: async () => {
          if (hold) {
            entered.resolve()
            await release.promise
          }
          return "fixture-bob"
        },
      }
    )
  }, 30000)

  it("marks keys backed up only after the actual encrypted upload ACK", async () => {
    await withRunningMatrix(async (state) => {
      const saved = server(state)
      const ack = deferred<WireResponse>()
      saved.holdUpload = ack.promise
      const created = state.adapter.keyBackup!.create()
      try {
        await waitFor(() => saved.uploads === 1, "pending encrypted backup upload")
        const before = await backup({ adapterId: "bob", action: "status" })
        expect(before.enabled).toBe(true)
        expect(before.total).toBeGreaterThan(0)
        expect(before.backedUp).toBe(0)
        expect(JSON.stringify(saved.rooms).includes("session_key")).toBe(false)
        ack.resolve({ body: { count: 1, etag: "native-etag" } })
        const result = await created
        expect(result.version).toBe("v1")
        expect(
          JSON.stringify(state.wire.requests.map((request) => request.body)).includes(
            result.recoveryKey
          )
        ).toBe(false)
        const after = await backup({ adapterId: "bob", action: "status" })
        expect(after.backedUp).toBe(after.total)
      } finally {
        ack.resolve({ body: { count: 1, etag: "native-etag" } })
        await created.catch(() => undefined)
      }
    })
  }, 30000)

  it("restores a fresh device, rejects wrong keys/session IDs, and recovers actual pending adapter input", async () => {
    await withRunningMatrix(async (state) => {
      const saved = server(state)
      const created = await state.adapter.keyBackup!.create()
      const event = await encryptedTimeline("recovered from cloud backup")
      const fresh = createMatrixAdapter({
        id: "restored",
        displayName: "Restored",
        homeserver: state.wire.origin,
        accessToken: async () => "fixture-restored",
        selfId: identity("bob").userId,
        deviceId: "RESTORED",
      })
      const admitted: NormalizedInboundEvent[] = []
      try {
        await fresh.start(
          state.wire.context("restored", async (value) => {
            admitted.push(value)
          })
        )
        await expect(decrypt({ adapterId: "restored", roomId: room, event })).rejects.toThrow()
        await persistMatrixPendingEncryptedEvent({ adapterId: "restored", roomId: room, event })
        const foreign = await backup({ adapterId: "alice", action: "prepare" })
        await expect(fresh.keyBackup!.restore(foreign.recoveryKey!, "v1")).rejects.toThrow(
          "public key mismatch"
        )
        expect(
          await getDb().matrixPendingEncryptedEvents.where("adapterId").equals("restored").count()
        ).toBe(1)
        const altered = structuredClone(saved.rooms)
        const sessions = (altered[room] as { sessions: Json }).sessions
        const sessionId = Object.keys(sessions)[0]
        sessions["forged-session-id"] = sessions[sessionId]
        delete sessions[sessionId]
        await expect(
          backup({
            adapterId: "restored",
            action: "restore",
            version: "v1",
            backupInfo: saved.info,
            recoveryKey: created.recoveryKey,
            rooms: altered,
          })
        ).rejects.toThrow("session identity mismatch")
        await expect(decrypt({ adapterId: "restored", roomId: room, event })).rejects.toThrow()
        const restored = await fresh.keyBackup!.restore(created.recoveryKey, "v1")
        expect(restored.imported).toBeGreaterThan(0)
        expect(admitted.map((value) => value.plainText)).toEqual(["recovered from cloud backup"])
        expect(
          await getDb().matrixPendingEncryptedEvents.where("adapterId").equals("restored").count()
        ).toBe(0)
      } finally {
        await fresh.stop()
      }
    })
  }, 30000)

  it("persists unknown create outcome across SIGKILL and reconciles without a second POST", async () => {
    await withRunningMatrix(async (state) => {
      const saved = server(state)
      saved.failCreate = true
      await expect(state.adapter.keyBackup!.create()).rejects.toThrow("lost-create-response")
      await state.adapter.stop()
      await state.wire.native!.stop(true)
      await state.wire.native!.start()
      await state.restart()
      saved.hideVersion = true
      await expect(state.adapter.keyBackup!.create()).rejects.toThrow("outcome is unknown")
      expect(saved.creates).toBe(1)
      saved.hideVersion = false
      expect((await state.adapter.keyBackup!.create()).version).toBe("v1")
      expect(saved.creates).toBe(1)
      expect((await backup({ adapterId: "bob", action: "status" })).backedUp).toBeGreaterThan(0)
    })
  }, 30000)
})
