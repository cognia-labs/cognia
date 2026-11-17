import { test } from "node:test"
import assert from "node:assert/strict"

import { imagePixelSize } from "./image-size.ts"
import { encodeRgbPng } from "../../context/optical/png.ts"

const b64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString("base64")

test("reads a real PNG's size, from base64 and from a data URL", () => {
  const png = encodeRgbPng(new Uint8Array(37 * 21 * 3), 37, 21).toString("base64")
  assert.deepEqual(imagePixelSize(png), { width: 37, height: 21 })
  assert.deepEqual(imagePixelSize(`data:image/png;base64,${png}`), { width: 37, height: 21 })
})

test("reads GIF, WebP (VP8X) and JPEG headers", () => {
  const gif = [...Buffer.from("GIF89a"), 0x40, 0x01, 0xf0, 0x00, ...new Array(20).fill(0)]
  assert.deepEqual(imagePixelSize(b64(gif)), { width: 320, height: 240 })

  const webp = [
    ...Buffer.from("RIFF"),
    0,
    0,
    0,
    0,
    ...Buffer.from("WEBPVP8X"),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    // canvas 1920×1080, stored minus one, 24-bit little-endian
    0x7f,
    0x07,
    0x00,
    0x37,
    0x04,
    0x00,
  ]
  assert.deepEqual(imagePixelSize(b64(webp)), { width: 1920, height: 1080 })

  const jpeg = [
    0xff,
    0xd8,
    // APP0 segment of 16 bytes to skip
    0xff,
    0xe0,
    0x00,
    0x10,
    ...new Array(14).fill(0),
    // SOF0: length, precision, height 600, width 800
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x02,
    0x58,
    0x03,
    0x20,
    ...new Array(12).fill(0),
  ]
  assert.deepEqual(imagePixelSize(b64(jpeg)), { width: 800, height: 600 })

  // An EXIF segment (with its thumbnail) pushes the frame header past the
  // first short scan; the longer one still finds it.
  const exif = 9_000
  const behindExif = [
    0xff,
    0xd8,
    0xff,
    0xe1,
    (exif + 2) >> 8,
    (exif + 2) & 0xff,
    ...new Array(exif).fill(0),
    ...jpeg.slice(2 + 18),
  ]
  assert.deepEqual(imagePixelSize(b64(behindExif)), { width: 800, height: 600 })
})

test("returns null for data that is not a known image header", () => {
  assert.equal(imagePixelSize(""), null)
  assert.equal(imagePixelSize(b64(Buffer.from("%PDF-1.7 not an image at all, really"))), null)
  assert.equal(imagePixelSize("https://example.com/a.png"), null)
})
