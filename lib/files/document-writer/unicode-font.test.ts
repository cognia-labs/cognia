/** @jest-environment jsdom */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  loadPdfUnicodeFont,
  PDF_UNICODE_FONT,
  PdfFontUnavailableError,
  toBinaryString,
} from "./unicode-font"

const fetchMock = jest.fn()

beforeEach(() => {
  fetchMock.mockReset()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

/** A fetch response carrying `bytes`. */
function respond(bytes: Uint8Array, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

const TRUETYPE = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x10])

describe("loadPdfUnicodeFont", () => {
  it("reads the bundled font as a same-origin asset, cached by the browser", async () => {
    fetchMock.mockResolvedValueOnce(respond(TRUETYPE))
    await expect(loadPdfUnicodeFont()).resolves.toBe("\x00\x01\x00\x00\x00\x10")
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(PDF_UNICODE_FONT.path, window.location.href).toString(),
      { cache: "force-cache" }
    )
  })

  it("reads it again on the next export instead of holding 10 MB in memory", async () => {
    fetchMock.mockResolvedValue(respond(TRUETYPE))
    await loadPdfUnicodeFont()
    await loadPdfUnicodeFont()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("reports a missing asset", async () => {
    fetchMock.mockResolvedValueOnce(respond(new Uint8Array(), 404))
    const error = await loadPdfUnicodeFont().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PdfFontUnavailableError)
    expect((error as Error).cause).toEqual(new Error("HTTP 404"))
  })

  it("reports a failed request, keeping its cause", async () => {
    const cause = new TypeError("Failed to fetch")
    fetchMock.mockRejectedValueOnce(cause)
    const error = await loadPdfUnicodeFont().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PdfFontUnavailableError)
    expect((error as Error).cause).toBe(cause)
  })

  it("refuses a file that is not a TrueType font, which jsPDF cannot read", async () => {
    // A WOFF2 web font, say: jsPDF reads TrueType outlines only.
    fetchMock.mockResolvedValueOnce(respond(new TextEncoder().encode("wOF2....")))
    await expect(loadPdfUnicodeFont()).rejects.toBeInstanceOf(PdfFontUnavailableError)
  })
})

describe("toBinaryString", () => {
  it("keeps every byte across chunk boundaries", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256)
    const binary = toBinaryString(bytes)
    expect(binary).toHaveLength(70_000)
    expect(binary.charCodeAt(0x8000)).toBe(0x8000 % 256)
    expect(binary.charCodeAt(69_999)).toBe(69_999 % 256)
  })
})

describe("the bundled asset", () => {
  it("is shipped at the path the loader reads, as a TrueType font", () => {
    const file = readFileSync(join(process.cwd(), "public", PDF_UNICODE_FONT.path))
    expect([...file.subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00])
  })
})
