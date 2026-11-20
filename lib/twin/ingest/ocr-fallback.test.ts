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
  maybeTwinPdfOcrWithProvenance,
  runTwinPdfOcrWithProvenance,
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

describe("maybeTwinPdfOcrWithProvenance", () => {
  it("returns null for non-PDF formats", async () => {
    const ex = jest.fn()
    expect(
      await maybeTwinPdfOcrWithProvenance(
        raw({ format: "docx" }),
        parsed(""),
        deps({ extractPdf: ex })
      )
    ).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("returns null when there is no binary", async () => {
    expect(
      await maybeTwinPdfOcrWithProvenance(raw({ binary: undefined }), parsed(""), deps())
    ).toBeNull()
  })

  it("returns null when the text layer already has enough text", async () => {
    const ex = jest.fn()
    const text = "x".repeat(TWIN_OCR_MIN_TEXT_CHARS + 5)
    expect(
      await maybeTwinPdfOcrWithProvenance(raw(), parsed(text), deps({ extractPdf: ex }))
    ).toBeNull()
    expect(ex).not.toHaveBeenCalled()
  })

  it("OCRs a low-text PDF and returns the extracted text", async () => {
    const ex = jest.fn(async () => ocrResult("SCANNED CONTENT"))
    const out = await maybeTwinPdfOcrWithProvenance(
      raw(),
      parsed("  \n "),
      deps({ extractPdf: ex })
    )
    expect(out?.originalText).toBe("SCANNED CONTENT")
    expect(ex).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array) }, expect.anything())
  })

  it("returns null (non-fatal) when extractPdf throws", async () => {
    const ex = jest.fn(async () => {
      throw new Error("pdf boom")
    })
    expect(
      await maybeTwinPdfOcrWithProvenance(raw(), parsed(""), deps({ extractPdf: ex }))
    ).toBeNull()
  })

  it("records a page OCR found blank, instead of discarding the run (G2)", async () => {
    const ex = jest.fn(async () => ocrResult("   "))
    const out = await maybeTwinPdfOcrWithProvenance(raw(), parsed(""), deps({ extractPdf: ex }))
    expect(out?.originalText).toBe("")
    expect(out?.structure?.pages).toEqual([
      expect.objectContaining({ pageNumber: 1, status: "blank" }),
    ])
  })

  it("hands the router the job's signal and stops with its reason (G5)", async () => {
    const controller = new AbortController()
    const reason = new Error("job cancelled")
    const ex = jest.fn(async (_input: unknown, routerDeps: { signal?: AbortSignal }) => {
      expect(routerDeps.signal).toBe(controller.signal)
      controller.abort(reason)
      // The router reports a cancelled run as its own error.
      throw new Error("PDF OCR cancelled.")
    })
    await expect(
      maybeTwinPdfOcrWithProvenance(raw(), parsed(""), deps({ extractPdf: ex }), {
        signal: controller.signal,
      })
    ).rejects.toBe(reason)
  })

  it("does not start for a job already stopped", async () => {
    const controller = new AbortController()
    controller.abort(new Error("paused"))
    const ex = jest.fn()
    await expect(
      maybeTwinPdfOcrWithProvenance(raw(), parsed(""), deps({ extractPdf: ex }), {
        signal: controller.signal,
      })
    ).rejects.toThrow("paused")
    expect(ex).not.toHaveBeenCalled()
  })
})

describe("runTwinPdfOcrWithProvenance (production wrapper)", () => {
  beforeEach(() => {
    extractPdfMock.mockReset().mockResolvedValue(ocrResult("FROM SETTINGS"))
    loadSettingsMock.mockReset().mockResolvedValue({ defaultProviderId: "auto" })
    pdfDepsMock.mockClear()
    mockOcrPort = providingOcrPort
  })

  it("runs the OCR fallback for a low-text PDF", async () => {
    const out = await runTwinPdfOcrWithProvenance(raw(), parsed(""))
    expect(out?.originalText).toBe("FROM SETTINGS")
    expect(extractPdfMock).toHaveBeenCalledTimes(1)
    expect(pdfDepsMock).toHaveBeenCalledWith({ settings: { defaultProviderId: "auto" } })
  })

  it("passes the signal through to the router", async () => {
    const controller = new AbortController()
    await runTwinPdfOcrWithProvenance(raw(), parsed(""), { signal: controller.signal })
    expect(extractPdfMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal })
    )
  })

  it("keeps the text layer where no module provides OCR", async () => {
    mockOcrPort = null
    const out = await runTwinPdfOcrWithProvenance(raw(), parsed(""))
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
          status: "text",
        },
        {
          pageNumber: 2,
          charStart: 52,
          charEnd: 52,
          lineStart: 3,
          lineEnd: 3,
          status: "text",
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
    expect(result?.structure?.pages[1].status).toBe("ocr")
    expect(result?.structure?.pages[0].status).toBe("text")
  })
})

describe("page status, confidence and tables (G2)", () => {
  /** A parse whose text layer has `texts[i]` on page i + 1. */
  function textLayer(texts: string[]): ParsedSource {
    const source = parsed(texts.join("\n\n"))
    let cursor = 0
    source.structure = {
      version: 1,
      contentHash: "layer",
      textLength: source.originalText.length,
      nodes: [],
      pages: texts.map((text, index) => {
        const page = {
          pageNumber: index + 1,
          charStart: cursor,
          charEnd: cursor + text.length,
          lineStart: 1,
          lineEnd: 1,
          status: text.trim() ? ("text" as const) : ("no-text-layer" as const),
        }
        cursor += text.length + 2
        return page
      }),
    }
    source.pageMap = [
      { pageNumber: 3, charStart: 0, charEnd: 0, bboxUnion: { x: 1, y: 2, width: 3, height: 4 } },
    ]
    return source
  }

  it("keeps the pages around one OCR cannot read, that one with its text-layer text", async () => {
    const extractPdf = jest.fn(
      async (
        _input: unknown,
        routerDeps: {
          continueOnPageError?: boolean
          onPageError?: (error: unknown, page: number, done: number, total: number) => void
        }
      ) => {
        // The router skips a failed page only when told to.
        expect(routerDeps.continueOnPageError).toBe(true)
        routerDeps.onPageError?.(new Error("provider timeout"), 3, 3, 3)
        return {
          ...ocrResult("ignored"),
          pages: [
            { pageNumber: 1, text: "Digital page text", markdown: "", fromTextLayer: true },
            {
              pageNumber: 2,
              text: "Scanned words",
              markdown: "Scanned words",
              fromTextLayer: false,
            },
          ],
        }
      }
    )
    const out = await maybeTwinPdfOcrWithProvenance(
      raw(),
      textLayer(["Digital page text", "", "pg 3"]),
      deps({ extractPdf })
    )
    expect(out?.originalText).toBe("Digital page text\n\nScanned words\n\npg 3")
    expect(out?.structure?.pages.map((page) => [page.pageNumber, page.status])).toEqual([
      [1, "text"],
      [2, "ocr"],
      [3, "ocr-failed"],
    ])
    // The failed page's text is the text layer's, so its native box still holds.
    expect(out?.structure?.pages[2].bboxUnion).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it("keeps what the text layer had when OCR finds nothing on a page", async () => {
    const extractPdf = jest.fn(async () => ({
      ...ocrResult("ignored"),
      pages: [{ pageNumber: 1, text: " ", markdown: " ", fromTextLayer: false }],
    }))
    const out = await maybeTwinPdfOcrWithProvenance(raw(), textLayer(["12"]), deps({ extractPdf }))
    expect(out?.originalText).toBe("12")
    expect(out?.structure?.pages[0].status).toBe("text")
  })

  it("gives a page the mean of its blocks' confidences, and none when no block has one", async () => {
    const extractPdf = jest.fn(async () => ({
      ...ocrResult("ignored"),
      pages: [
        {
          pageNumber: 1,
          text: "Scored",
          markdown: "Scored",
          blocks: [{ text: "a", confidence: 0.9 }, { text: "b", confidence: 0.5 }, { text: "c" }],
        },
        { pageNumber: 2, text: "Unscored", markdown: "Unscored", blocks: [{ text: "d" }] },
      ],
    }))
    const out = await maybeTwinPdfOcrWithProvenance(raw(), parsed(""), deps({ extractPdf }))
    expect(out?.structure?.pages[0].confidence).toBeCloseTo(0.7)
    expect(out?.structure?.pages[1]).not.toHaveProperty("confidence")
  })

  it("keeps the tables the provider wrote on its pages, located by page", async () => {
    const azure =
      "Intro\n<table><tr><th>Region</th><th>Q1</th></tr>" +
      "<tr><td rowspan='2'>North</td><td>1</td></tr><tr><td>2</td></tr></table>"
    const pipe = "| Item | Cost |\n| --- | --- |\n| Pen | 3 |"
    const extractPdf = jest.fn(async () => ({
      ...ocrResult("ignored"),
      pages: [
        { pageNumber: 1, text: "Intro Region Q1 North 1 2", markdown: azure },
        { pageNumber: 2, text: "Item Cost Pen 3", markdown: pipe },
      ],
    }))
    const out = await maybeTwinPdfOcrWithProvenance(raw(), parsed(""), deps({ extractPdf }))
    const tables = out?.structure?.tables ?? []
    expect(tables.map((table) => [table.index, table.locator])).toEqual([
      [1, { type: "page", page: 1 }],
      [2, { type: "page", page: 2 }],
    ])
    expect(tables[0].cells).toContainEqual(
      expect.objectContaining({ row: 1, column: 0, rowSpan: 2, text: "North" })
    )
    expect(tables[0].cells).toContainEqual(
      expect.objectContaining({ row: 2, column: 1, text: "2" })
    )
    expect(tables[1]).toMatchObject({ rowCount: 2, columnCount: 2, headerRowCount: 1 })
  })
})

describe("parse identity after OCR (G1)", () => {
  it("keeps the reader's identity and records OCR, its provider and languages", async () => {
    const source = parsed("")
    source.structure = {
      version: 1,
      contentHash: "layer",
      textLength: 0,
      nodes: [],
      pages: [],
      parse: {
        parser: "pdfjs",
        processingVersion: 1,
        configHash: "cfg",
        strategy: "native",
        startedAt: 10,
        completedAt: 20,
      },
    }
    const extractPdf = jest.fn(async () => ({ ...ocrResult("Scanned"), providerId: "tesseract" }))
    const out = await maybeTwinPdfOcrWithProvenance(raw(), source, deps({ extractPdf }))
    expect(out?.structure?.parse).toEqual({
      parser: "pdfjs",
      processingVersion: 1,
      configHash: "cfg",
      strategy: "ocr",
      ocrProvider: "tesseract",
      languages: ["en"],
      startedAt: 10,
      completedAt: expect.any(Number),
    })
    expect(out?.structure?.parse?.completedAt).toBeGreaterThanOrEqual(20)
  })
})
