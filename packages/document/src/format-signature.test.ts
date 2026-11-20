import { checkContainer, containerSignature, DocumentFormatMismatchError } from "./format-signature"

const bytes = (...values: (number | string)[]) =>
  Uint8Array.from(
    values.flatMap((value) =>
      typeof value === "string" ? Array.from(value, (char) => char.charCodeAt(0)) : [value]
    )
  )
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0)
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)

describe("containerSignature", () => {
  it("reads the container from the leading bytes", () => {
    expect(containerSignature(ZIP)).toBe("zip")
    expect(containerSignature(bytes(0x50, 0x4b, 0x05, 0x06))).toBe("zip")
    expect(containerSignature(OLE)).toBe("ole")
    expect(containerSignature(bytes("%PDF-1.7\n"))).toBe("pdf")
    expect(containerSignature(bytes(0xef, 0xbb, 0xbf, " \r\n{\\rtf1"))).toBe("rtf")
    expect(containerSignature(new TextEncoder().encode("姓名,城市\n王芳,上海"))).toBe("text")
    expect(containerSignature(bytes(0, 1, 2, 3, 0xff))).toBe("binary")
    expect(containerSignature(new Uint8Array())).toBe("empty")
  })

  it("finds a PDF header within the first 1024 bytes, as the spec allows, and not past them", () => {
    const junk = (length: number) => new Uint8Array(length).fill(0x20)
    const at = (offset: number) => Uint8Array.from([...junk(offset), ...bytes("%PDF-2.0")])
    // `%PDF-` must lie wholly inside the first 1024 bytes: it may start at 1019.
    expect(containerSignature(at(1019))).toBe("pdf")
    expect(containerSignature(at(1020))).not.toBe("pdf")
  })

  it("does not take a multi-byte character cut at the sample's end for binary", () => {
    const text = new TextEncoder().encode("a".repeat(4095) + "中")
    expect(containerSignature(text)).toBe("text")
  })
})

describe("checkContainer", () => {
  it("passes bytes that are the container the extension claims", () => {
    expect(checkContainer("docx", ZIP)).toBeUndefined()
    expect(checkContainer("XLSX", ZIP)).toBeUndefined()
    expect(checkContainer("epub", ZIP)).toBeUndefined()
    expect(checkContainer("doc", OLE)).toBeUndefined()
    // A legacy name over its OOXML successor still reads.
    expect(checkContainer("ppt", ZIP)).toBeUndefined()
    expect(checkContainer("pdf", bytes("%PDF-1.4"))).toBeUndefined()
  })

  it("refuses a strict format whose bytes are something else, with a typed diagnostic", () => {
    let thrown: unknown
    try {
      checkContainer("xlsx", new TextEncoder().encode("plain words"))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DocumentFormatMismatchError)
    expect(thrown).toMatchObject({
      extension: "xlsx",
      detected: "text",
      diagnostic: { code: "format_mismatch", severity: "error" },
    })
    expect((thrown as Error).message).toContain("plain text")
    expect(() => checkContainer("odt", OLE)).toThrow(DocumentFormatMismatchError)
    expect(() => checkContainer("pdf", ZIP)).toThrow(/ZIP package/)
  })

  it("only warns for the formats real files bend, but refuses them empty", () => {
    expect(checkContainer("xls", new TextEncoder().encode("<table></table>"))).toMatchObject({
      code: "format_mismatch",
      severity: "warning",
    })
    expect(checkContainer("rtf", new TextEncoder().encode("plain letter"))).toMatchObject({
      severity: "warning",
    })
    expect(() => checkContainer("xls", new Uint8Array())).toThrow(/empty/)
  })

  it("leaves formats without a container signature alone", () => {
    expect(checkContainer("csv", new Uint8Array([0xff]))).toBeUndefined()
    expect(checkContainer("html", new Uint8Array())).toBeUndefined()
  })
})
