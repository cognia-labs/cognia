/** @jest-environment jsdom */
import { decodeMatrixVerificationFile, decodeMatrixVerificationPixels } from "./verification-qr"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QRCodeSVG } from "qrcode.react"

// An independent encoder supplies pixels to the real decoder. Protocol/key
// validity is exercised separately with native SDK images in browser E2E.
function qrPixels() {
  const svg = renderToStaticMarkup(
    createElement(QRCodeSVG, { value: "MATRIX-qr-test", marginSize: 4 })
  )
  const size = 29 * 5
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  const path = svg.match(/fill="#000000" d="([^"]+)"/)![1]
  for (const match of path.matchAll(/M(\d+)[ ,](\d+)\s*h(\d+)v1H\d+z/g)) {
    const [, x, y, width] = match.map(Number)
    for (let row = y * 5; row < (y + 1) * 5; row++)
      for (let column = x * 5; column < (x + width) * 5; column++)
        data.fill(0, (row * size + column) * 4, (row * size + column) * 4 + 3)
  }
  return { data, size }
}

test("preserves decoded binary bytes from an independent QR encoder", () => {
  const { data, size } = qrPixels()
  expect(decodeMatrixVerificationPixels(data, size, size)).toEqual([
    ...Buffer.from("MATRIX-qr-test"),
  ])
})

test.each(["success", "decode failure", "oversized", "missing canvas"])(
  "file decoder revokes its object URL after %s",
  async (scenario) => {
    const { data, size } = qrPixels()
    const image = {
      naturalWidth: scenario === "oversized" ? 2049 : size,
      naturalHeight: size,
      src: "",
      decode: jest.fn(async () => {
        if (scenario === "decode failure") throw new Error("bad image")
      }),
    }
    const oldImage = globalThis.Image
    const oldCreate = URL.createObjectURL,
      oldRevoke = URL.revokeObjectURL
    const revoke = jest.fn()
    URL.createObjectURL = jest.fn(() => "blob:private-matrix-image")
    URL.revokeObjectURL = revoke
    globalThis.Image = jest.fn(() => image) as never
    const context = jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(
        scenario === "missing canvas"
          ? null
          : ({ drawImage: jest.fn(), getImageData: () => ({ data }) } as never)
      )
    try {
      const work = decodeMatrixVerificationFile(
        new File(["image"], "matrix.png", { type: "image/png" })
      )
      if (scenario === "success")
        await expect(work).resolves.toEqual([...Buffer.from("MATRIX-qr-test")])
      else await expect(work).rejects.toThrow()
      expect(revoke).toHaveBeenCalledWith("blob:private-matrix-image")
    } finally {
      context.mockRestore()
      globalThis.Image = oldImage
      URL.createObjectURL = oldCreate
      URL.revokeObjectURL = oldRevoke
    }
  }
)
test("rejects invalid dimensions and non-QR pixels through the real decoder", () => {
  expect(() => decodeMatrixVerificationPixels(new Uint8ClampedArray(4), 2049, 1)).toThrow(
    "dimensions"
  )
  expect(() => decodeMatrixVerificationPixels(new Uint8ClampedArray(4), 1.1, 1)).toThrow(
    "dimensions"
  )
  expect(() =>
    decodeMatrixVerificationPixels(new Uint8ClampedArray(1600).fill(255), 20, 20)
  ).toThrow("Invalid Matrix")
})
test("file limits are checked before allocating a decoded image", async () => {
  await expect(
    decodeMatrixVerificationFile(new File(["text"], "code.svg", { type: "image/svg+xml" }))
  ).rejects.toThrow("Unsupported")
  await expect(
    decodeMatrixVerificationFile(
      new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })
    )
  ).rejects.toThrow("Unsupported")
})
