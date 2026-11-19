// SHA-256 helper, self-contained so `lib/share` has no dependency on the backup
// crypto module (whose `./types` drags in app-wide types). Keeping the share
// subsystem a clean leaf lets the standalone viewer import it without pulling
// the rest of the app into its bundle / type graph. Web Crypto only.

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error("Web Crypto API (crypto.subtle) is required but not available in this runtime")
  }
  return subtle
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes) as BufferSource
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await getSubtle().digest(
    "SHA-256",
    toBufferSource(new TextEncoder().encode(value))
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * A UUID that names `value`: its SHA-256 laid out as an RFC 9562 version-8
 * UUID (variant `10`). The same input always gives the same id, so it serves
 * as a stable idempotency or transport key wherever a UUID is required.
 */
export async function sha256Uuid(value: string): Promise<string> {
  const hex = await sha256Hex(value)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
