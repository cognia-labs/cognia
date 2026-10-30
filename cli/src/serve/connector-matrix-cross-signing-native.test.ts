import { randomUUID } from "node:crypto"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { withMatrixNative, identity } from "../test-support/matrix-native"
import { deferred } from "../test-support/connector-loopback"
import { withRunningMatrix } from "../test-support/matrix-adapter-native"
import {
  connectorsMatrixCryptoCrossSigning as crossSigning,
  connectorsMatrixCryptoInit as init,
  connectorsMatrixCryptoReceiveSyncChanges as sync,
  connectorsMatrixCryptoOutgoingRequests as outgoing,
  connectorsMatrixCryptoMarkRequestSent as mark,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import { createMatrixAdapter } from "@/lib/connectors/adapters/matrix"

async function queryPeer(wire: { origin: string }, adapterId: string, userId: string) {
  await sync({ adapterId, changedDevices: [userId] })
  const requests = (await outgoing(adapterId)).filter((request) => request.kind === "keysQuery")
  expect(requests.length).toBeGreaterThan(0)
  for (const request of requests) {
    const response = await connectorsHttpRequest({
      url: wire.origin + request.path,
      method: request.method,
      headers: { "content-type": "application/json", authorization: `Bearer fixture-${adapterId}` },
      body: JSON.stringify(request.body),
    })
    expect(response.status).toBe(200)
    await mark({
      adapterId,
      requestId: request.requestId,
      kind: request.kind,
      response: JSON.parse(response.body),
    })
  }
}

const db = createDbTestFixture({ seeded: false })
const nativeOnly = process.env.COGNIA_IM_NATIVE === "1" ? describe : describe.skip
nativeOnly("Matrix cross-signing over real native storage", () => {
  beforeAll(db.initialize)
  beforeEach(db.restore)
  afterAll(db.dispose)
  test("prepares signed public requests without exporting private seeds", async () => {
    await withMatrixNative(async (wire, exchange) => {
      await exchange()
      const result = await wire.native!.call<{
        requests: Array<{ kind: string; body: Record<string, unknown> }>
      }>("connectors_matrix_crypto_cross_signing", {
        req: { adapterId: "bob", action: "prepare", serverMasterKey: null },
      })
      const kinds = result.requests.map((request) => request.kind)
      expect(kinds.slice(-2)).toEqual(["signingKeysUpload", "signatureUpload"])
      if (kinds.length === 3) expect(kinds[0]).toBe("keysUpload")
      const body = result.requests.find((request) => request.kind === "signingKeysUpload")!
        .body as Record<string, { usage: string[]; keys: object; signatures: object }>
      expect(body.master_key.usage).toEqual(["master"])
      expect(body.self_signing_key.usage).toEqual(["self_signing"])
      expect(Object.keys(body.self_signing_key.signatures)).toEqual([identity("bob").userId])
      expect(JSON.stringify(result)).not.toMatch(/private_key|seed|recoveryKey|storePassphrase/)
    })
  })

  test("valid cross-signatures do not automatically trust a peer; forged signatures are rejected", async () => {
    await withRunningMatrix(async (state) => {
      const own = await state.adapter.crossSigning!.bootstrap()
      expect(own).toMatchObject({
        hasMaster: true,
        hasSelfSigning: true,
        hasUserSigning: true,
        identityVerified: true,
        deviceCrossSigned: true,
        deviceTrusted: true,
      })
      expect(own.masterKey).toEqual(expect.any(String))
      const published = state.relay.crossSigning.get(identity("bob").userId)!
      const valid = structuredClone(published.self_signing_key)
      const key = published.self_signing_key as {
        signatures: Record<string, Record<string, string>>
      }
      const signatures = key.signatures[identity("bob").userId]
      const name = Object.keys(signatures)[0]
      const bytes = Buffer.from(signatures[name], "base64")
      bytes[0] ^= 1
      signatures[name] = bytes.toString("base64").replace(/=+$/, "")
      await queryPeer(state.wire, "alice", identity("bob").userId)
      const forged = await crossSigning({
        adapterId: "alice",
        action: "status",
        userId: identity("bob").userId,
        deviceId: identity("bob").deviceId,
      })
      expect(forged.deviceCrossSigned).toBe(false)
      expect(forged.deviceTrusted).toBe(false)
      published.self_signing_key = valid
      await queryPeer(state.wire, "alice", identity("bob").userId)
      expect(
        await crossSigning({
          adapterId: "alice",
          action: "status",
          userId: identity("bob").userId,
          deviceId: identity("bob").deviceId,
        })
      ).toMatchObject({
        masterKey: own.masterKey,
        deviceCrossSigned: true,
        identityVerified: false,
        deviceTrusted: false,
      })
    })
  })

  test("retains the same private identity and trust observations across SIGKILL", async () => {
    await withRunningMatrix(async (state) => {
      const before = await state.adapter.crossSigning!.bootstrap()
      const publicBefore = structuredClone(state.relay.crossSigning.get(identity("bob").userId))
      await state.wire.native!.stop(true)
      await expect(state.adapter.stop()).rejects.toThrow("stopped")
      await state.wire.native!.start()
      await state.restart()
      expect(await state.adapter.crossSigning!.status()).toEqual(before)
      expect(await state.adapter.crossSigning!.bootstrap()).toEqual(before)
      expect(state.relay.crossSigning.get(identity("bob").userId)).toEqual(publicBefore)
    })
  })

  test("does not replace an existing server identity on a fresh device without its secrets", async () => {
    await withRunningMatrix(async (state) => {
      const original = await state.adapter.crossSigning!.bootstrap()
      const before = state.wire.requests.filter((request) =>
        request.url.pathname.endsWith("/keys/device_signing/upload")
      ).length
      await init({ adapterId: "fresh", userId: identity("bob").userId, deviceId: "FRESH_DEVICE" })
      const fresh = createMatrixAdapter({
        id: "fresh",
        displayName: "Fresh",
        homeserver: state.wire.origin,
        accessToken: async () => "fixture-fresh",
        selfId: identity("bob").userId,
        deviceId: "FRESH_DEVICE",
      })
      try {
        await fresh.start(state.wire.context("fresh", async () => undefined))
        await expect(fresh.crossSigning!.bootstrap()).rejects.toThrow(/identity|private keys/)
        expect(
          state.wire.requests.filter((request) =>
            request.url.pathname.endsWith("/keys/device_signing/upload")
          )
        ).toHaveLength(before)
        expect((await state.adapter.crossSigning!.status()).masterKey).toBe(original.masterKey)
      } finally {
        await fresh.stop()
      }
    })
  })

  test("UIA rejection leaves uploads incomplete and explicit retry reuses the saved public identity", async () => {
    await withRunningMatrix(async (state) => {
      const original = state.wire.onHttp
      let reject = true
      const challengeSession = randomUUID()
      state.wire.onHttp = (request) =>
        request.url.pathname.endsWith("/keys/device_signing/upload") && reject
          ? {
              status: 401,
              body: { session: challengeSession, flows: [{ stages: ["m.login.password"] }] },
            }
          : original(request)
      const failed = (await state.adapter
        .crossSigning!.bootstrap()
        .catch((error: unknown) => error)) as { status: number; authChallenge: { session: string } }
      expect(failed).toMatchObject({ status: 401, authChallenge: { session: challengeSession } })
      expect(
        state.wire.requests.filter((request) =>
          request.url.pathname.endsWith("/keys/signatures/upload")
        )
      ).toHaveLength(0)
      const saved = await state.adapter.crossSigning!.status()
      reject = false
      expect(
        (
          await state.adapter.crossSigning!.bootstrap({
            session: failed.authChallenge.session,
            type: "m.login.password",
          })
        ).masterKey
      ).toBe(saved.masterKey)
      const acceptedUpload = state.wire.requests
        .filter((request) => request.url.pathname.endsWith("/keys/device_signing/upload"))
        .at(-1)!
      expect((acceptedUpload.body as { auth: { session: string } }).auth.session).toBe(
        challengeSession
      )
      const uploads = state.wire.requests.filter((request) =>
        request.url.pathname.endsWith("/keys/device_signing/upload")
      )
      expect((uploads[0].body as Record<string, unknown>).master_key).toEqual(
        (uploads[1].body as Record<string, unknown>).master_key
      )
    })
  })

  test("200 signature failures cannot produce successful bootstrap", async () => {
    await withRunningMatrix(async (state) => {
      const original = state.wire.onHttp
      state.wire.onHttp = (request) =>
        request.url.pathname.endsWith("/keys/signatures/upload")
          ? {
              body: {
                failures: {
                  [identity("bob").userId]: { DEVICE_bob: { errcode: "M_INVALID_SIGNATURE" } },
                },
              },
            }
          : original(request)
      await expect(state.adapter.crossSigning!.bootstrap()).rejects.toThrow(
        "signatures were rejected"
      )
    })
  })
  test("a stopped bootstrap cannot wake a replacement runtime after a held native refresh", async () => {
    await withRunningMatrix(async (state) => {
      const reached = deferred<void>()
      const release = deferred<void>()
      let hold = true
      state.wire.onCommand = async (name, args) => {
        const result = await state.wire.native!.call(name, args)
        if (
          hold &&
          name === "connectors_matrix_crypto_receive_sync_changes" &&
          (args?.req as { changedDevices?: string[] } | undefined)?.changedDevices?.includes(
            identity("bob").userId
          )
        ) {
          reached.resolve()
          await release.promise
        }
        return result
      }
      const operation = state.adapter.crossSigning!.bootstrap().then(
        () => "unexpected success",
        (error: Error) => error.message
      )
      try {
        await reached.promise
        await state.adapter.stop()
        hold = false
        await state.restart()
        const before = state.wire.commands.filter(
          (command) => command.name === "connectors_matrix_crypto_outgoing_requests"
        ).length
        release.resolve()
        expect(await operation).toContain("not active")
        expect(
          state.wire.commands.filter(
            (command) => command.name === "connectors_matrix_crypto_outgoing_requests"
          )
        ).toHaveLength(before)
      } finally {
        hold = false
        release.resolve()
        await operation
      }
    })
  })
})
