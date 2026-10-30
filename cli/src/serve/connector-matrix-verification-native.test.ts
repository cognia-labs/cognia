import { withMatrixNative, identity } from "../test-support/matrix-native"
import {
  connectorsMatrixCryptoVerification as verify,
  connectorsMatrixCryptoCrossSigning as crossSigning,
  connectorsMatrixCryptoOutgoingRequests as outgoing,
  connectorsMatrixCryptoMarkRequestSent as mark,
  connectorsMatrixCryptoReceiveSyncChanges as sync,
  connectorsHttpRequest,
  connectorsMatrixCryptoInit as init,
  type MatrixVerificationInput,
  type MatrixCryptoOutgoingRequest,
} from "@/lib/connectors/tauri/commands"
import type { ConnectorLoopback } from "../test-support/connector-loopback"
import type { MatrixRelay } from "../test-support/matrix-native"
import { setTimeout as wait } from "node:timers/promises"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { withRunningMatrix } from "../test-support/matrix-adapter-native"

async function send(wire: ConnectorLoopback, id: string, request: MatrixCryptoOutgoingRequest) {
  const dispatch = () =>
    connectorsHttpRequest({
      url: wire.origin + request.path,
      method: request.method,
      headers: { "content-type": "application/json", authorization: `Bearer fixture-${id}` },
      body: JSON.stringify(request.body),
    })
  const response = await dispatch().catch(async (error: Error) => {
    const retry = /^rate limit exceeded for host: 127\.0\.0\.1; retry after ~(\d+)ms$/.exec(
      error.message
    )
    if (!retry) throw error
    await wait(Number(retry[1]) + 1)
    return dispatch()
  })
  expect(response.status).toBe(200)
  await mark({
    adapterId: id,
    requestId: request.requestId,
    kind: request.kind,
    response: JSON.parse(response.body),
  })
}

async function withVerification(
  run: (f: {
    wire: ConnectorLoopback
    act: (id: string, input: Omit<MatrixVerificationInput, "userId">) => ReturnType<typeof verify>
    pump: () => Promise<void>
    bootstrap: () => Promise<void>
  }) => Promise<void>
) {
  await withMatrixNative(async (wire, exchange, relay: MatrixRelay) => {
    await exchange()
    relay.inbox.clear()
    const refreshed = new Set<string>()
    const pump = async () => {
      for (let round = 0; round < 20; round++) {
        let count = 0
        for (const id of ["alice", "bob"]) {
          const user = identity(id).userId
          const events = relay.inbox.get(user) ?? []
          relay.inbox.delete(user)
          if (events.length) {
            await sync({ adapterId: id, toDeviceEvents: events })
            count += events.length
          }
          for (const request of await outgoing(id)) {
            await send(wire, id, request)
            count++
          }
        }
        if (!count) return
      }
      throw new Error("Verification protocol did not settle")
    }
    const act = async (id: string, input: Omit<MatrixVerificationInput, "userId">) => {
      const state = await verify({
        adapterId: id,
        userId: identity(id === "alice" ? "bob" : "alice").userId,
        ...input,
      })
      for (const request of state.requests) await send(wire, id, request)
      await pump()
      const current = await verify({
        adapterId: id,
        userId: identity(id === "alice" ? "bob" : "alice").userId,
        action: "status",
        flowId: state.flowId,
      })
      if (current.state === "done" && !refreshed.has(`${id}:${state.flowId}`)) {
        for (const peer of ["alice", "bob"])
          await sync({
            adapterId: peer,
            changedDevices: [identity("alice").userId, identity("bob").userId],
          })
        await pump()
        refreshed.add(`${id}:${state.flowId}`)
        return verify({
          adapterId: id,
          userId: identity(id === "alice" ? "bob" : "alice").userId,
          action: "status",
          flowId: state.flowId,
        })
      }
      return state
    }
    const bootstrap = async () => {
      for (const id of ["alice", "bob"]) {
        const prepared = await crossSigning({
          adapterId: id,
          action: "prepare",
          serverMasterKey: null,
        })
        for (const request of prepared.requests) await send(wire, id, request)
      }
      for (const id of ["alice", "bob"])
        await sync({
          adapterId: id,
          changedDevices: [identity("alice").userId, identity("bob").userId],
        })
      await pump()
    }
    await run({ wire, act, pump, bootstrap })
  })
}

const nativeOnly = process.env.COGNIA_IM_NATIVE === "1" ? describe : describe.skip
nativeOnly("Matrix interactive verification through the native bridge", () => {
  const db = createDbTestFixture({ seeded: false })
  beforeAll(db.initialize)
  beforeEach(db.restore)
  afterAll(db.dispose)

  test("running adapter discovers a real sync request and retries the same acceptance transaction", async () => {
    await withRunningMatrix(async (state) => {
      state.relay.inbox.clear()
      const request = await verify({
        adapterId: "alice",
        action: "request",
        userId: identity("bob").userId,
        deviceId: identity("bob").deviceId,
      })
      for (const outgoing of request.requests) await send(state.wire, "alice", outgoing)
      state.reply({
        next_batch: "verification-sync",
        to_device: { events: state.relay.inbox.get(identity("bob").userId) },
        rooms: { join: {} },
      })
      const api = state.adapter.verification!
      const deadline = Date.now() + 4000
      while ((await api.pending(identity("alice").userId)).length !== 1) {
        if (Date.now() >= deadline)
          throw new Error("Incoming verification request did not arrive through sync")
        await wait(5)
      }
      expect(await api.pending(identity("alice").userId)).toMatchObject([
        { flowId: request.flowId, deviceId: identity("alice").deviceId, deviceVerified: false },
      ])
      const previous = state.wire.onHttp
      let failed = false
      state.wire.onHttp = (wireRequest) => {
        if (
          !failed &&
          wireRequest.url.pathname.includes("/sendToDevice/m.key.verification.ready/")
        ) {
          failed = true
          return { status: 503, body: { errcode: "M_UNAVAILABLE" } }
        }
        return previous(wireRequest)
      }
      const input = {
        action: "accept" as const,
        userId: identity("alice").userId,
        flowId: request.flowId,
      }
      await expect(api.interact(input)).rejects.toThrow()
      expect(await api.interact(input)).toMatchObject({
        flowId: request.flowId,
        state: "ready",
        deviceVerified: false,
      })
      const transmissions = state.wire.requests.filter((entry) =>
        entry.url.pathname.includes("/sendToDevice/m.key.verification.ready/")
      )
      expect(transmissions).toHaveLength(2)
      expect(transmissions[1].url.pathname).toBe(transmissions[0].url.pathname)
      expect(transmissions[1].body).toEqual(transmissions[0].body)
      const accepted = state.wire.onHttp
      let cancelFailed = false
      state.wire.onHttp = (request) => {
        if (
          !cancelFailed &&
          request.url.pathname.includes("/sendToDevice/m.key.verification.cancel/")
        ) {
          cancelFailed = true
          return { status: 503, body: { errcode: "M_UNAVAILABLE" } }
        }
        return accepted(request)
      }
      const cancel = {
        action: "cancel",
        userId: identity("alice").userId,
        flowId: request.flowId,
      } as const
      await expect(api.interact(cancel)).rejects.toThrow()
      await expect(api.interact(cancel)).resolves.toMatchObject({ state: "cancelled" })
      const cancellations = state.wire.requests.filter((entry) =>
        entry.url.pathname.includes("/sendToDevice/m.key.verification.cancel/")
      )
      expect(cancellations).toHaveLength(2)
      expect(cancellations[1].url.pathname).toBe(cancellations[0].url.pathname)
      expect(
        state.wire.commands.filter(
          (entry) =>
            entry.name === "connectors_matrix_crypto_verification" &&
            (entry.args?.req as { action?: string })?.action === "cancel"
        )
      ).toHaveLength(1)
      await state.adapter.stop()
      await expect(api.pending(identity("alice").userId)).rejects.toThrow("not active")
    })
  })
  test("rejects unknown verification flows without changing peer trust", async () => {
    await withMatrixNative(async (wire, exchange) => {
      await exchange()
      await expect(
        wire.native!.call("connectors_matrix_crypto_verification", {
          req: {
            adapterId: "alice",
            action: "status",
            userId: identity("bob").userId,
            flowId: "missing",
          },
        })
      ).rejects.toThrow("verification flow unavailable")
    })
  })

  test("real SAS agrees on both peers and persists trust only after mutual confirmation", async () => {
    await withVerification(async ({ act, wire }) => {
      const { flowId } = await act("alice", {
        action: "request",
        deviceId: identity("bob").deviceId,
      })
      await expect(act("alice", { action: "confirmSas", flowId })).rejects.toThrow(
        "method unavailable"
      )
      await act("bob", { action: "accept", flowId })
      await act("alice", { action: "startSas", flowId })
      await act("bob", { action: "acceptSas", flowId })
      const a = await act("alice", { action: "status", flowId })
      const b = await act("bob", { action: "status", flowId })
      expect(a.decimals).toHaveLength(3)
      expect(a.emojiIndices).toHaveLength(7)
      expect(b.decimals).toEqual(a.decimals)
      expect(b.emojiIndices).toEqual(a.emojiIndices)
      expect(a.deviceVerified).toBe(false)
      expect(b.deviceVerified).toBe(false)
      await act("alice", { action: "confirmSas", flowId })
      expect((await act("alice", { action: "status", flowId })).deviceVerified).toBe(false)
      await act("bob", { action: "confirmSas", flowId })
      for (const id of ["alice", "bob"])
        expect(await act(id, { action: "status", flowId })).toMatchObject({
          state: "done",
          deviceVerified: true,
        })
      await wire.native!.stop(true)
      await wire.native!.start()
      for (const id of ["alice", "bob"]) await init(identity(id))
      await expect(act("alice", { action: "status", flowId })).rejects.toThrow("flow unavailable")
      // Interactive flows are in-memory; the verified device trust is durable.
      const fresh = await act("alice", { action: "request", deviceId: identity("bob").deviceId })
      expect(fresh.deviceVerified).toBe(true)
    })
  })

  test("SAS refusal cancels both peers without granting trust or accepting later confirmation", async () => {
    await withVerification(async ({ act }) => {
      const { flowId } = await act("alice", {
        action: "request",
        deviceId: identity("bob").deviceId,
      })
      await act("bob", { action: "accept", flowId })
      await act("alice", { action: "startSas", flowId })
      await act("bob", { action: "acceptSas", flowId })
      await act("bob", { action: "cancel", flowId })
      for (const id of ["alice", "bob"]) {
        expect(await act(id, { action: "status", flowId })).toMatchObject({
          state: "cancelled",
          deviceVerified: false,
        })
        await expect(act(id, { action: "confirmSas", flowId })).rejects.toThrow("terminal")
      }
    })
  })

  test("a valid-base64 tampered SAS MAC cancels verification instead of granting trust", async () => {
    await withVerification(async ({ act, wire }) => {
      const { flowId } = await act("alice", {
        action: "request",
        deviceId: identity("bob").deviceId,
      })
      await expect(
        act("alice", { action: "status", flowId, deviceId: "OTHER_DEVICE" })
      ).rejects.toThrow("device mismatch")
      await act("bob", { action: "accept", flowId })
      await act("alice", { action: "startSas", flowId })
      await act("bob", { action: "acceptSas", flowId })
      const previous = wire.onHttp
      let tampered = false
      wire.onHttp = (request) => {
        if (request.url.pathname.includes("/sendToDevice/m.key.verification.mac/")) {
          const body = request.body as {
            messages: Record<string, Record<string, { mac: Record<string, string> }>>
          }
          const content = Object.values(Object.values(body.messages)[0])[0]
          const key = Object.keys(content.mac)[0]
          const bytes = Buffer.from(content.mac[key], "base64")
          bytes[0] ^= 1
          content.mac[key] = bytes.toString("base64").replace(/=+$/, "")
          tampered = true
        }
        return previous(request)
      }
      await act("alice", { action: "confirmSas", flowId })
      expect(tampered).toBe(true)
      for (const id of ["alice", "bob"])
        expect(await act(id, { action: "status", flowId })).toMatchObject({
          state: "cancelled",
          deviceVerified: false,
        })
      await expect(act("bob", { action: "confirmSas", flowId })).rejects.toThrow("terminal")
    })
  })

  test("background SAS signature rejection retains the SDK request until a successful server ACK", async () => {
    await withVerification(async ({ act, wire, bootstrap, pump }) => {
      await bootstrap()
      const { flowId } = await act("alice", {
        action: "request",
        deviceId: identity("bob").deviceId,
      })
      await act("bob", { action: "accept", flowId })
      await act("alice", { action: "startSas", flowId })
      await act("bob", { action: "acceptSas", flowId })
      await act("alice", { action: "confirmSas", flowId })
      const previous = wire.onHttp
      wire.onHttp = (request) =>
        request.url.pathname.endsWith("/keys/signatures/upload")
          ? {
              body: {
                failures: {
                  [identity("alice").userId]: {
                    key: { errcode: "M_FORBIDDEN", error: "fixture rejection" },
                  },
                },
              },
            }
          : previous(request)
      await expect(act("bob", { action: "confirmSas", flowId })).rejects.toThrow(
        "signature upload was rejected"
      )
      const pending = (await outgoing("alice")).filter(
        (request) => request.kind === "signatureUpload"
      )
      expect(pending.length).toBeGreaterThan(0)
      wire.onHttp = previous
      await pump()
      expect(
        (await outgoing("alice")).filter((request) => request.kind === "signatureUpload")
      ).toEqual([])
    })
  })

  test("real QR verification binds master keys and requires explicit scan acknowledgement", async () => {
    await withVerification(async ({ act, bootstrap }) => {
      await bootstrap()
      const { flowId } = await act("alice", {
        action: "request",
        deviceId: identity("bob").deviceId,
      })
      await act("bob", { action: "accept", flowId })
      const qr = await act("alice", { action: "generateQr", flowId })
      expect(Buffer.from(qr.qrBytes!).subarray(0, 6).toString()).toBe("MATRIX")
      await expect(act("alice", { action: "confirmQr", flowId })).rejects.toThrow(
        "not been scanned"
      )
      await act("bob", { action: "scanQr", flowId, qrBytes: qr.qrBytes })
      expect(await act("alice", { action: "status", flowId })).toMatchObject({
        scanned: true,
        deviceVerified: false,
      })
      await act("alice", { action: "confirmQr", flowId })
      for (const id of ["alice", "bob"])
        expect(await act(id, { action: "status", flowId })).toMatchObject({
          state: "done",
          deviceVerified: true,
        })
    })
  })

  test("malformed, wrong-flow and key-tampered QR data never verifies a peer", async () => {
    await withVerification(async ({ act, bootstrap }) => {
      await bootstrap()
      const { flowId } = await act("alice", {
        action: "request",
        deviceId: identity("bob").deviceId,
      })
      await act("bob", { action: "accept", flowId })
      const qr = (await act("alice", { action: "generateQr", flowId })).qrBytes!
      await expect(act("bob", { action: "scanQr", flowId, qrBytes: [1, 2, 3] })).rejects.toThrow(
        "Invalid Matrix QR"
      )
      const wrongFlow = [...qr]
      wrongFlow[10] ^= 1
      await expect(act("bob", { action: "scanQr", flowId, qrBytes: wrongFlow })).rejects.toThrow(
        /QR/
      )
      const tampered = [...qr]
      tampered[tampered.length - 40] ^= 1
      await expect(act("bob", { action: "scanQr", flowId, qrBytes: tampered })).rejects.toThrow(
        /QR/
      )
      for (const id of ["alice", "bob"])
        expect((await act(id, { action: "status", flowId })).deviceVerified).toBe(false)
      await act("alice", { action: "cancel", flowId })
      expect(await act("bob", { action: "status", flowId })).toMatchObject({
        state: "cancelled",
        deviceVerified: false,
      })
    })
  })
})
