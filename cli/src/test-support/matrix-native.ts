/** Shared local homeserver delivery only; all crypto commands execute in Rust. */
import { ConnectorLoopback, type WireRequest, type WireResponse } from "./connector-loopback"
import {
  connectorsHttpRequest,
  connectorsMatrixCryptoInit as init,
  connectorsMatrixCryptoOutgoingRequests as outgoing,
  connectorsMatrixCryptoMarkRequestSent as mark,
  connectorsMatrixCryptoUpdateTrackedUsers as track,
  connectorsMatrixCryptoGetMissingSessions as missing,
  connectorsMatrixCryptoShareRoomKey as share,
  connectorsMatrixCryptoReceiveSyncChanges as sync,
} from "@/lib/connectors/tauri/commands"
export const room = "!private:fixture.test"
export const identity = (adapterId: string) => ({
  adapterId,
  userId: `@${adapterId}:fixture.test`,
  deviceId: `DEVICE_${adapterId}`,
})
type Request = Awaited<ReturnType<typeof outgoing>>[number]
type Json = Record<string, unknown>
export interface UploadedKeys {
  device_keys: { user_id: string; device_id: string; keys: Record<string, string> }
  one_time_keys: Record<string, unknown>
}

export interface MatrixRelay {
  respond: (request: WireRequest) => WireResponse | undefined
  inbox: Map<string, Record<string, unknown>[]>
  uploads: Map<string, UploadedKeys>
  crossSigning: Map<string, Json>
}
export async function withMatrixNative(
  run: (
    wire: ConnectorLoopback,
    exchange: (holdBobUploadAck?: boolean, holdBobRoomKeys?: boolean) => Promise<void>,
    relay: MatrixRelay
  ) => Promise<void>
) {
  const wire = await new ConnectorLoopback().open()
  const relay = createMatrixRelay()
  const { uploads, inbox, respond } = relay
  wire.onHttp = (request) => respond(request) ?? { status: 404, body: {} }
  const deliver = async (adapterId: string, request: Request, acknowledge = true) => {
    const response = await connectorsHttpRequest({
      url: wire.origin + request.path,
      method: request.method,
      headers: { "content-type": "application/json", authorization: `Bearer fixture-${adapterId}` },
      body: JSON.stringify(request.body),
    })
    expect(response.status).toBe(200)
    if (acknowledge)
      await mark({
        adapterId,
        requestId: request.requestId,
        kind: request.kind,
        response: JSON.parse(response.body),
      })
  }
  const exchange = async (holdBobUploadAck = false, holdBobRoomKeys = false) => {
    for (const id of ["alice", "bob"]) await init(identity(id))
    for (const id of ["alice", "bob"])
      for (const req of await outgoing(id))
        if (req.kind === "keysUpload") await deliver(id, req, !(holdBobUploadAck && id === "bob"))
    expect(uploads.size).toBe(2)
    for (const id of ["alice", "bob"])
      await track({ adapterId: id, userIds: [identity(id === "alice" ? "bob" : "alice").userId] })
    for (const id of ["alice", "bob"])
      for (const req of await outgoing(id)) if (req.kind === "keysQuery") await deliver(id, req)
    const claims = await missing({ adapterId: "alice", userIds: [identity("bob").userId] })
    expect(claims.map((req) => req.kind)).toEqual(["keysClaim"])
    for (const req of claims) await deliver("alice", req)
    const keys = await share({
      adapterId: "alice",
      roomId: room,
      userIds: [identity("bob").userId],
    })
    expect(keys.length).toBeGreaterThan(0)
    for (const req of keys) {
      expect(req.path).toContain("/sendToDevice/m.room.encrypted/")
      expect(JSON.stringify(req.body)).not.toContain("m.room_key")
      await deliver("alice", req)
    }
    const events = inbox.get(identity("bob").userId) ?? []
    expect(events.length).toBeGreaterThan(0)
    if (!holdBobRoomKeys)
      await sync({ adapterId: "bob", toDeviceEvents: events, nextBatchToken: "native-sync-1" })
  }
  try {
    await run(wire, exchange, relay)
    expect(wire.errors).toEqual([])
  } finally {
    await wire.close()
  }
}

export function createMatrixRelay(): MatrixRelay {
  const uploads = new Map<string, UploadedKeys>()
  const inbox = new Map<string, Json[]>()
  const crossSigning = new Map<string, Json>()
  let activeSender = ""
  const respond = (request: WireRequest): WireResponse | undefined => {
    const auth = String(request.headers.authorization ?? "")
    if (auth.startsWith("Bearer fixture-")) activeSender = auth.slice("Bearer fixture-".length)
    const body = request.body as Json
    if (request.url.pathname.endsWith("/keys/upload")) {
      const previous = uploads.get(activeSender)
      const deviceKeys = (body.device_keys ?? previous?.device_keys) as
        UploadedKeys["device_keys"] | undefined
      if (!deviceKeys) throw new Error("Initial Matrix key upload has no device identity")
      uploads.set(activeSender, {
        device_keys: deviceKeys,
        one_time_keys: {
          ...previous?.one_time_keys,
          ...(body.one_time_keys as Record<string, unknown> | undefined),
        },
      })
      return {
        body: {
          one_time_key_counts: {
            signed_curve25519: Object.keys(uploads.get(activeSender)!.one_time_keys).length,
          },
        },
      }
    }
    if (request.url.pathname.endsWith("/keys/device_signing/upload")) {
      const user = uploads.get(activeSender)?.device_keys.user_id ?? identity(activeSender).userId
      crossSigning.set(user, body)
      return { body: {} }
    }
    if (request.url.pathname.endsWith("/keys/signatures/upload")) {
      for (const [user, signed] of Object.entries(body))
        for (const [keyId, key] of Object.entries(signed as Json)) {
          const device = [...uploads.values()].find(
            (upload) =>
              upload.device_keys.user_id === user && upload.device_keys.device_id === keyId
          )
          if (device) {
            const previous = device.device_keys as unknown as Json
            const update = key as Json
            const oldSignatures = previous.signatures as Record<string, Json> | undefined
            const newSignatures = update.signatures as Record<string, Json> | undefined
            device.device_keys = {
              ...previous,
              ...update,
              signatures: Object.fromEntries(
                [
                  ...new Set([
                    ...Object.keys(oldSignatures ?? {}),
                    ...Object.keys(newSignatures ?? {}),
                  ]),
                ].map((signer) => [
                  signer,
                  { ...oldSignatures?.[signer], ...newSignatures?.[signer] },
                ])
              ),
            } as unknown as UploadedKeys["device_keys"]
          } else {
            const keys = crossSigning.get(user)
            if (keys)
              for (const name of ["master_key", "self_signing_key", "user_signing_key"])
                if (Object.values((keys[name] as { keys: Json })?.keys ?? {}).includes(keyId))
                  keys[name] = key
          }
        }
      return { body: { failures: {} } }
    }
    if (request.url.pathname.endsWith("/keys/query"))
      return {
        body: {
          master_keys: Object.fromEntries(
            [...crossSigning].map(([user, keys]) => [user, keys.master_key])
          ),
          self_signing_keys: Object.fromEntries(
            [...crossSigning].map(([user, keys]) => [user, keys.self_signing_key])
          ),
          user_signing_keys: Object.fromEntries(
            [...crossSigning]
              .filter(
                ([user]) =>
                  user ===
                  (uploads.get(activeSender)?.device_keys.user_id ?? identity(activeSender).userId)
              )
              .map(([user, keys]) => [user, keys.user_signing_key])
          ),
          device_keys: [...uploads.values()].reduce<Record<string, Record<string, unknown>>>(
            (result, upload) => {
              const user = upload.device_keys.user_id
              const device = upload.device_keys.device_id
              result[user] ??= {}
              result[user][device] = upload.device_keys
              return result
            },
            {}
          ),
        },
      }
    if (request.url.pathname.endsWith("/keys/claim"))
      return {
        body: {
          one_time_keys: Object.fromEntries(
            Object.entries(body.one_time_keys as Json).map(([user, devices]) => [
              user,
              Object.fromEntries(
                Object.keys(devices as Json).map((device) => {
                  const upload = [...uploads.values()].find(
                    (value) =>
                      value.device_keys.user_id === user && value.device_keys.device_id === device
                  )!
                  const key = Object.entries(upload.one_time_keys).find(([name]) =>
                    name.startsWith("signed_curve25519:")
                  )!
                  delete upload.one_time_keys[key[0]]
                  return [device, { [key[0]]: key[1] }]
                })
              ),
            ])
          ),
        },
      }
    if (request.url.pathname.includes("/sendToDevice/")) {
      const type = decodeURIComponent(request.url.pathname.split("/")[5])
      for (const [user, devices] of Object.entries(body.messages as Json))
        for (const content of Object.values(devices as Json)) {
          const list = inbox.get(user) ?? []
          list.push({
            sender: uploads.get(activeSender)?.device_keys.user_id ?? identity(activeSender).userId,
            type,
            content,
          })
          inbox.set(user, list)
        }
      return { body: {} }
    }
    return undefined
  }
  return { respond, inbox, uploads, crossSigning }
}
