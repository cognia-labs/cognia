const extractPdfMock = jest.fn()
let mockOcrPort: Record<string, unknown> | null = null
const pdfDepsMock = jest.fn((options: unknown) => ({ loadPdf: jest.fn(), built: options }))
const loadSettingsMock = jest.fn()
const providingOcrPort = {
  extractPdf: (...args: unknown[]) => extractPdfMock(...args),
  pdfDeps: (options: unknown) => pdfDepsMock(options),
  loadSettings: () => loadSettingsMock(),
}
jest.mock("@/lib/modules/ports", () => ({
  loadPort: async (id: string) => (id === "ocr" ? mockOcrPort : null),
}))

import {
  maybeTwinPdfOcr,
  runTwinPdfOcr,
  TWIN_OCR_MIN_TEXT_CHARS,
  type TwinOcrFallbackDeps,
} from "./ocr-fallback"
import type { RawSource, ParsedSource } from "./parse"
import type { OcrResult } from "@/types/ocr"

function ocrResult(text: string): OcrResult {
  return {
    providerId: "ocrs",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: text,
    combinedText: text,
    languages: ["en"],
    durationMs: 1,
    cached: false,
  }
}

function raw(over: Partial<RawSource> = {}): RawSource {
  return {
    id: "s1",
    filename: "scan.pdf",
    format: "pdf",
    binary: new Uint8Array([1, 2, 3]),
    ...over,
  }
}

function parsed(text: string): ParsedSource {
  return {
    id: "s1",
    kind: "document",
    format: "pdf",
    title: "scan.pdf",
    originalText: text,
    embeddableText: text,
    baseMetadata: {},
    bytes: 3,
  }
}

function deps(over: Partial<TwinOcrFallbackDeps> = {}): TwinOcrFallbackDeps {
  return {
    extractPdf: jest.fn(async () => ocrResult("OCR TEXT")),
    buildPdfRouterDeps: () => ({}) as ReturnType<TwinOcrFallbackDeps["buildPdfRouterDeps"]>,
    ...over,
  }
}

describe("maybeTwinPdfOcr", () => {
  it("returns null for non-PDF formats", async () => {
    const ex = jest.fn()
    expect(
      await maybeTwinPdfOcr(raw({ format: "docx" }), parsed(""), deps({ extractPdf: ex }))
    ).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("returns null when there is no binary", async () => {
    expect(await maybeTwinPdfOcr(raw({ binary: undefined }), parsed(""), deps())).toBeNull()
  })

  it("returns null when the text layer already has enough text", async () => {
    const ex = jest.fn()
    const text = "x".repeat(TWIN_OCR_MIN_TEXT_CHARS + 5)
    expect(await maybeTwinPdfOcr(raw(), parsed(text), deps({ extractPdf: ex }))).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("OCRs a low-text PDF and returns the extracted text", async () => {
    const ex = jest.fn(async () => ocrResult("SCANNED CONTENT"))
    const out = await maybeTwinPdfOcr(raw(), parsed("  \n "), deps({ extractPdf: ex }))
    expect(out).toBe("SCANNED CONTENT")
    expect(ex).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array) }, expect.anything())
  })

  it("returns null (non-fatal) when extractPdf throws", async () => {
    const ex = jest.fn(async () => {
      throw new Error("pdf boom")
    })
    expect(await maybeTwinPdfOcr(raw(), parsed(""), deps({ extractPdf: ex }))).toBeNull()
  })

  it("returns null when OCR yields blank text", async () => {
    const ex = jest.fn(async () => ocrResult("   "))
    expect(await maybeTwinPdfOcr(raw(), parsed(""), deps({ extractPdf: ex }))).toBeNull()
  })
})

describe("runTwinPdfOcr (production wrapper)", () => {
  beforeEach(() => {
    extractPdfMock.mockReset().mockResolvedValue(ocrResult("FROM SETTINGS"))
    loadSettingsMock.mockReset().mockResolvedValue({ defaultProviderId: "auto" })
    pdfDepsMock.mockClear()
    mockOcrPort = providingOcrPort
  })

  it("runs the OCR fallback for a low-text PDF", async () => {
    const out = await runTwinPdfOcr(raw(), parsed(""))
    expect(out).toBe("FROM SETTINGS")
    expect(extractPdfMock).toHaveBeenCalledTimes(1)
    expect(pdfDepsMock).toHaveBeenCalledWith({ settings: { defaultProviderId: "auto" } })
  })

  it("keeps the text layer where no module provides OCR", async () => {
    mockOcrPort = null
    const out = await runTwinPdfOcr(raw(), parsed(""))
    expect(out).toBeNull()
    expect(extractPdfMock).not.toHaveBeenCalled()
  })
})

describe("OCR provenance", () => {
  it("routes mixed PDFs and replaces stale native offsets with per-page original ranges", async () => {
    const { maybeTwinPdfOcrWithProvenance } = await import("./ocr-fallback")
    const source = parsed("A substantial digital text layer on the first page.\n\n")
    source.structure = {
      version: 1,
      contentHash: "old",
      textLength: source.originalText.length,
      nodes: [],
      pages: [
        {
          pageNumber: 1,
          charStart: 0,
          charEnd: 50,
          lineStart: 1,
          lineEnd: 1,
          provenance: "text-layer",
        },
        {
          pageNumber: 2,
          charStart: 52,
          charEnd: 52,
          lineStart: 3,
          lineEnd: 3,
          provenance: "text-layer",
        },
      ],
    }
    const extractPdf = jest.fn(async () => ({
      ...ocrResult("ignored"),
      pages: [
        { pageNumber: 1, text: "Digital page", markdown: "Digital page", fromTextLayer: true },
        { pageNumber: 2, text: "Scanned answer", markdown: "Scanned answer", fromTextLayer: false },
      ],
    }))
    const result = await maybeTwinPdfOcrWithProvenance(raw(), source, deps({ extractPdf }))
    expect(extractPdf).toHaveBeenCalledTimes(1)
    expect(result?.originalText).toBe("Digital page\n\nScanned answer")
    expect(result?.pageMap?.[1]).toMatchObject({ pageNumber: 2, charStart: 14, charEnd: 28 })
    expect(result?.structure?.pages[1].provenance).toBe("ocr")
    expect(result?.structure?.pages[0].provenance).toBe("text-layer")
  })
})
