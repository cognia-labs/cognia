import {
  bytesToBase64,
  bytesToDataUrl,
  decodeDataUrl,
  isImageMimeType,
  isPdfMimeType,
} from "./image-bytes"

describe("image-bytes", () => {
  it("round-trips bytes through base64 and a data URL", () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(bytesToBase64(bytes)).toBe("AQID")
    const url = bytesToDataUrl(bytes, "image/png")
    expect(url).toBe("data:image/png;base64,AQID")
    const decoded = decodeDataUrl(url)
    expect(decoded?.mimeType).toBe("image/png")
    expect(Array.from(decoded?.bytes ?? [])).toEqual([1, 2, 3])
  })

  it("refuses what is not a data URL", () => {
    expect(decodeDataUrl("https://example.com/a.png")).toBeNull()
  })

  it("tells images and PDFs by MIME type", () => {
    expect(isImageMimeType("image/jpeg")).toBe(true)
    expect(isImageMimeType("application/pdf")).toBe(false)
    expect(isPdfMimeType("application/pdf")).toBe(true)
  })
})
