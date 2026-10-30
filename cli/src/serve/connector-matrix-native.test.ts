/** Actual Rust Olm/Megolm and encrypted SQLite; only homeserver delivery is local. */
import {
  withMatrixNative as fixture,
  room,
  identity,
  type UploadedKeys,
} from "@/cli/src/test-support/matrix-native"
import {
  connectorsMatrixCryptoInit as init,
  connectorsMatrixCryptoClose as close,
  connectorsMatrixCryptoOutgoingRequests as outgoing,
  connectorsMatrixCryptoMarkRequestSent as mark,
  connectorsMatrixCryptoEncryptEvent as encrypt,
  connectorsMatrixCryptoDecryptEvent as decrypt,
} from "@/lib/connectors/tauri/commands"

type Json = Record<string, unknown>
const nativeOnly = process.env.COGNIA_IM_NATIVE === "1" ? describe : describe.skip
async function encryptedEvent() {
  const { content: encryptedContent } = await encrypt({
    adapterId: "alice",
    roomId: room,
    eventType: "m.room.message",
    content: { msgtype: "m.text", body: "private native message ✓" },
  })
  const content = encryptedContent as Json
  expect(content.algorithm).toBe("m.megolm.v1.aes-sha2")
  expect(typeof content.ciphertext).toBe("string")
  expect(JSON.stringify(content)).not.toContain("private native message")
  return {
    type: "m.room.encrypted",
    event_id: "$native-event",
    sender: identity("alice").userId,
    origin_server_ts: Date.now(),
    content,
  }
}
const messageContent = (result: Awaited<ReturnType<typeof decrypt>>) =>
  (result.event as { event: { content: unknown } }).event.content

nativeOnly("Matrix E2EE over actual native commands and encrypted disk stores", () => {
  it("exchanges signed device keys and encrypted room keys, then decrypts cross-device", async () => {
    await fixture(async (_wire, exchange) => {
      await exchange()
      expect(
        messageContent(
          await decrypt({ adapterId: "bob", roomId: room, event: await encryptedEvent() })
        )
      ).toEqual({ msgtype: "m.text", body: "private native message ✓" })
    })
  }, 20000)

  it("retains Megolm keys and identity after real SIGKILL and process restart", async () => {
    await fixture(async (wire, exchange) => {
      await exchange(true)
      const beforeKeys = (await outgoing("bob")).find((req) => req.kind === "keysUpload")!
        .body as unknown as UploadedKeys
      expect(Object.keys(beforeKeys.device_keys.keys).sort()).toEqual([
        "curve25519:DEVICE_bob",
        "ed25519:DEVICE_bob",
      ])
      for (const value of Object.values(beforeKeys.device_keys.keys)) {
        expect(typeof value).toBe("string")
        expect(value.length).toBeGreaterThan(0)
      }
      const event = await encryptedEvent()
      await wire.native!.stop(true)
      await wire.native!.start()
      for (const id of ["alice", "bob"]) await init(identity(id))
      const afterKeys = (await outgoing("bob")).find((req) => req.kind === "keysUpload")!
        .body as unknown as UploadedKeys
      expect(afterKeys.device_keys.keys).toEqual(beforeKeys.device_keys.keys)
      expect(
        messageContent(await decrypt({ adapterId: "bob", roomId: room, event }))
      ).toMatchObject({ body: "private native message ✓" })
      expect(
        messageContent(
          await decrypt({ adapterId: "bob", roomId: room, event: await encryptedEvent() })
        )
      ).toMatchObject({ body: "private native message ✓" })
    })
  }, 20000)

  it("fails closed for unshared accounts, wrong rooms and corrupted ciphertext, then accepts a valid event", async () => {
    await fixture(async (_wire, exchange) => {
      await exchange()
      await init(identity("outsider"))
      const event = await encryptedEvent()
      await expect(decrypt({ adapterId: "outsider", roomId: room, event })).rejects.toThrow()
      await expect(
        decrypt({ adapterId: "bob", roomId: "!other:fixture.test", event })
      ).rejects.toThrow()
      const corrupt = structuredClone(event)
      const corruptedBytes = Buffer.from(String(corrupt.content.ciphertext), "base64")
      corruptedBytes[corruptedBytes.length - 1] ^= 1
      corrupt.content.ciphertext = corruptedBytes.toString("base64").replace(/=+$/, "")
      await expect(decrypt({ adapterId: "bob", roomId: room, event: corrupt })).rejects.toThrow()
      expect(
        messageContent(await decrypt({ adapterId: "bob", roomId: room, event }))
      ).toMatchObject({ body: "private native message ✓" })
    })
  }, 20000)

  it("validates identity, close/reopen, unsupported ACK and test-profile ownership", async () => {
    await fixture(async (wire) => {
      await init(identity("alice"))
      await expect(init({ ...identity("alice"), deviceId: "OTHER" })).rejects.toThrow(
        "different Matrix identity"
      )
      await expect(
        wire.native!.call("connectors_matrix_crypto_init", {
          req: { ...identity("bad"), storeDir: "/tmp/unowned" },
        })
      ).rejects.toThrow("fixture owns")
      await expect(
        mark({ adapterId: "alice", requestId: "invalid", kind: "unsupported", response: {} })
      ).rejects.toThrow("unsupported")
      const before = (await outgoing("alice")).find((request) => request.kind === "keysUpload")!
        .body as unknown as UploadedKeys
      await close("alice")
      await expect(outgoing("alice")).rejects.toThrow("not initialized")
      await expect(
        wire.native!.call("fixture_matrix_wrong_passphrase", { req: identity("alice") })
      ).rejects.toThrow("open Matrix crypto store failed")
      await init(identity("alice"))
      const after = (await outgoing("alice")).find((request) => request.kind === "keysUpload")!
        .body as unknown as UploadedKeys
      expect(after.device_keys.keys).toEqual(before.device_keys.keys)
    })
  }, 20000)
})
