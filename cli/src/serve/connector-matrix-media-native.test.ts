import { createHash } from "node:crypto"
import { ConnectorLoopback } from "@/cli/src/test-support/connector-loopback"
import {
  connectorsMatrixEncryptedMediaUpload as upload,
  connectorsMatrixEncryptedMediaFetch as fetchMedia,
  connectorsAttachmentRead as read,
} from "@/lib/connectors/tauri/commands"

const nativeOnly = process.env.COGNIA_IM_NATIVE === "1" ? describe : describe.skip
const plaintext = Buffer.from("private Matrix image bytes ✓\0\xff".repeat(8))

async function fixture(
  run: (
    wire: ConnectorLoopback,
    file: Awaited<ReturnType<typeof upload>>["file"],
    ciphertext: Buffer
  ) => Promise<void>
) {
  const wire = await new ConnectorLoopback().open()
  let ciphertext: Buffer = Buffer.alloc(0)
  wire.onHttp = (request) => {
    if (request.url.pathname === "/source") return { body: null, rawBytes: plaintext }
    if (request.url.pathname === "/_matrix/media/v3/upload") {
      ciphertext = request.bytes
      return { body: { content_uri: "mxc://fixture.test/encrypted" } }
    }
    if (request.url.pathname === "/download") return { body: null, rawBytes: ciphertext }
    return { status: 404, body: {} }
  }
  try {
    const response = await upload({
      sourceUrl: wire.origin + "/source",
      uploadUrl: wire.origin + "/_matrix/media/v3/upload",
      contentType: "application/octet-stream",
      headers: { authorization: "Bearer fixture" },
    })
    expect(response.contentUri).toBe("mxc://fixture.test/encrypted")
    expect(ciphertext.length).toBe(plaintext.length)
    expect(ciphertext.equals(plaintext)).toBe(false)
    expect(response.file.hashes.sha256).toBe(
      createHash("sha256").update(ciphertext).digest("base64").replace(/=+$/, "")
    )
    expect(
      wire.requests.find((req) => req.url.pathname.endsWith("/upload"))!.headers.authorization
    ).toBe("Bearer fixture")
    await run(wire, response.file, ciphertext)
    expect(wire.errors).toEqual([])
  } finally {
    await wire.close()
  }
}

const probe = (wire: ConnectorLoopback) =>
  wire.native!.call<{ files: number; containsPlaintext: boolean; unexpectedFiles: number }>(
    "fixture_cache_probe",
    {
      plaintextBase64: plaintext.toString("base64"),
    }
  )

nativeOnly("real Matrix encrypted media upload/download/cache", () => {
  it("verifies ciphertext hash, decrypts exact bytes and persists only encrypted cache", async () => {
    await fixture(async (wire, file) => {
      const req = {
        adapterId: "media-A",
        remoteRef: file.url,
        sourceUrl: wire.origin + "/download",
        file,
      }
      const first = await fetchMedia(req)
      expect(first).toMatchObject({ sizeBytes: plaintext.length, cached: false })
      expect(await read("media-A", file.url, plaintext.length)).toBe(plaintext.toString("base64"))
      expect(await read("media-A", file.url, plaintext.length - 1)).toBeNull()
      expect(await read("other-account", file.url, plaintext.length)).toBeNull()
      expect(await probe(wire)).toEqual({ files: 1, containsPlaintext: false, unexpectedFiles: 0 })
      expect((await fetchMedia(req)).cached).toBe(true)
      expect(wire.requests.filter((req) => req.url.pathname === "/download")).toHaveLength(1)
    })
  }, 20000)

  it("retains decrypt-on-read cache and its secret key across real process restart", async () => {
    await fixture(async (wire, file) => {
      await fetchMedia({
        adapterId: "media-A",
        remoteRef: file.url,
        sourceUrl: wire.origin + "/download",
        file,
      })
      await wire.native!.stop(true)
      await wire.native!.start()
      expect(await read("media-A", file.url, plaintext.length)).toBe(plaintext.toString("base64"))
      expect(await probe(wire)).toEqual({ files: 1, containsPlaintext: false, unexpectedFiles: 0 })
    })
  }, 20000)

  it("rejects tampered ciphertext/hash before caching, then accepts intact media", async () => {
    await fixture(async (wire, file, encrypted) => {
      const altered = Buffer.from(encrypted)
      altered[0] ^= 1
      wire.onHttp = () => ({ body: null, rawBytes: altered })
      const req = {
        adapterId: "media-A",
        remoteRef: file.url,
        sourceUrl: wire.origin + "/download",
        file,
      }
      await expect(fetchMedia(req)).rejects.toThrow()
      expect(await read("media-A", file.url, plaintext.length)).toBeNull()
      expect(await probe(wire)).toEqual({ files: 0, containsPlaintext: false, unexpectedFiles: 0 })
      wire.onHttp = () => ({ body: null, rawBytes: encrypted })
      const badHash = structuredClone(file)
      badHash.hashes.sha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      await expect(fetchMedia({ ...req, file: badHash })).rejects.toThrow()
      expect(await probe(wire)).toEqual({ files: 0, containsPlaintext: false, unexpectedFiles: 0 })
      await fetchMedia(req)
      expect(await read("media-A", file.url, plaintext.length)).toBe(plaintext.toString("base64"))
    })
  }, 20000)
})
