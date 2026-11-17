// Pixel size of an inline image, read from its header.
//
// Providers bill an image by its pixel size, so a token estimate that only
// knows "this is an image" has to assume the largest one. The header of a PNG,
// GIF, WebP or JPEG states the size within its first bytes; reading those is
// enough to price a small screenshot or an optical frame at what it costs.
// Only the base64 prefix the header needs is decoded, never the whole image:
// the estimate runs several times a leg over every image in the conversation.

/** Decoded bytes that hold a PNG, GIF or WebP size (WebP's sits at byte 29). */
const HEADER_BYTES = 64

/** A JPEG's frame header follows its EXIF/ICC segments: a short scan, then a long one. */
const JPEG_SCAN_BYTES = [4 * 1024, 192 * 1024] as const

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
/** Char code → sextet, -1 for anything else; `-`/`_` cover the URL-safe alphabet. */
const BASE64_INDEX = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i
  table["-".charCodeAt(0)] = 62
  table["_".charCodeAt(0)] = 63
  return table
})()
const PAD = "=".charCodeAt(0)

/** Decode at most `maxBytes` bytes from the start of a base64 string. */
function decodePrefix(base64: string, maxBytes: number): Uint8Array {
  const chars = Math.min(base64.length, Math.ceil(maxBytes / 3) * 4)
  const out = new Uint8Array(Math.floor((chars * 3) / 4))
  let length = 0
  let buffer = 0
  let bits = 0
  for (let i = 0; i < chars; i++) {
    const code = base64.charCodeAt(i)
    const value = code < 128 ? BASE64_INDEX[code]! : -1
    if (value < 0) {
      if (code === PAD) break
      continue
    }
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[length++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, length)
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    // SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
      }
    }
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!)
  }
  return null
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = String.fromCharCode(...bytes.subarray(12, 16))
  if (chunk === "VP8 " && bytes.length >= 30)
    return {
      width: ((bytes[27]! << 8) | bytes[26]!) & 0x3fff,
      height: ((bytes[29]! << 8) | bytes[28]!) & 0x3fff,
    }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const b = bytes
    return {
      width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
      height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)),
    }
  }
  if (chunk === "VP8X" && bytes.length >= 30)
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    }
  return null
}

/**
 * Width and height of a base64 (or `data:` URL) PNG, GIF, WebP or JPEG, or
 * null when the header is absent or not one of those formats.
 */
export function imagePixelSize(data: string): { width: number; height: number } | null {
  const base64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data
  if (!base64) return null
  const bytes = decodePrefix(base64, HEADER_BYTES)
  if (bytes.length < 24) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) }
  }
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return webpSize(bytes)
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (const scan of JPEG_SCAN_BYTES) {
      const size = jpegSize(decodePrefix(base64, scan))
      if (size) return size
    }
  }
  return null
}
