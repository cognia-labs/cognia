import { DOCUMENT_PROCESSING_VERSION, parseConfigHash, parseIdentityKey } from "./parse-identity"
import type { DocumentParseIdentity } from "./types"

const identity: DocumentParseIdentity = {
  parser: "pdfjs",
  processingVersion: DOCUMENT_PROCESSING_VERSION,
  configHash: "cfg",
  strategy: "native",
  startedAt: 1,
  completedAt: 2,
}

describe("parseConfigHash", () => {
  it("hashes equal options equally whatever their key order, and skips undefined", () => {
    expect(parseConfigHash({ type: "pdf", extractPdfOutline: true })).toBe(
      parseConfigHash({ extractPdfOutline: true, type: "pdf", anyDoc: undefined })
    )
    expect(parseConfigHash({ type: "pdf", extractPdfOutline: false })).not.toBe(
      parseConfigHash({ type: "pdf", extractPdfOutline: true })
    )
    expect(parseConfigHash({ nested: { b: 1, a: [2, { d: 3, c: 4 }] } })).toBe(
      parseConfigHash({ nested: { a: [2, { c: 4, d: 3 }], b: 1 } })
    )
  })
})

describe("parseIdentityKey", () => {
  it("leaves the timestamps out: the same reading later is the same parse", () => {
    expect(parseIdentityKey({ ...identity, startedAt: 100, completedAt: 200 })).toBe(
      parseIdentityKey(identity)
    )
  })

  it("changes with the reader, its version, the processing version, options and OCR", () => {
    const key = parseIdentityKey(identity)
    for (const changed of [
      { ...identity, parser: "native-pdf" },
      { ...identity, parserVersion: "0.2.0" },
      { ...identity, processingVersion: identity.processingVersion + 1 },
      { ...identity, configHash: "other" },
      { ...identity, strategy: "ocr" as const, ocrProvider: "tesseract" },
      { ...identity, strategy: "ocr" as const, ocrProvider: "tesseract", languages: ["zh"] },
    ]) {
      expect(parseIdentityKey(changed)).not.toBe(key)
    }
  })
})
