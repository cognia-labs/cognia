/**
 * Tests for Document Processor
 */

import {
  detectDocumentType,
  processDocument,
  processDocumentAsync,
  getFileExtension,
  estimateTokenCount,
  detectEncoding,
} from "./document-processor"
import { parseWord, parseExcel } from "./parsers/office-parser"
import { parsePDF } from "./parsers/pdf-parser"
import { DOCUMENT_PROCESSING_VERSION } from "./parse-identity"
import { parsePresentation } from "./parsers/presentation-parser"
import {
  parseOpenDocumentText,
  parseOpenDocumentSpreadsheet,
  parseOpenDocumentPresentation,
} from "./parsers/open-document-parser"
import { AnyDocParseError, parseLegacyOfficeWithAnyDoc } from "./parsers/anydoc-parser"

/**
 * Eight bytes that open the way a real file of `filename`'s format does, for
 * the mocked parsers: the processor checks the container signature first.
 */
function fileBytes(filename: string): ArrayBuffer {
  const extension = filename.split(".").pop()!.toLowerCase()
  const head = ["doc", "xls", "ppt"].includes(extension)
    ? [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    : extension === "pdf"
      ? Array.from("%PDF-1.7", (char) => char.charCodeAt(0))
      : [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]
  return Uint8Array.from(head).buffer
}

jest.mock("./parsers/anydoc-parser", () => ({
  ...jest.requireActual<typeof import("./parsers/anydoc-parser")>("./parsers/anydoc-parser"),
  parseLegacyOfficeWithAnyDoc: jest.fn(),
}))

const mockParseLegacyOfficeWithAnyDoc = jest.mocked(parseLegacyOfficeWithAnyDoc)

jest.mock("@cognia/provider-embedding/chunking", () => ({
  chunkDocument: jest.fn((content: string) => {
    const chunks =
      content.length > 100
        ? [
            { id: "chunk-0", content: "chunk-0", index: 0, startOffset: 0, endOffset: 7 },
            { id: "chunk-1", content: "chunk-1", index: 1, startOffset: 7, endOffset: 14 },
          ]
        : [{ id: "chunk-0", content: "chunk-0", index: 0, startOffset: 0, endOffset: 7 }]

    return {
      chunks,
      totalChunks: chunks.length,
      originalLength: content.length,
      strategy: "fixed",
    }
  }),
  chunkDocumentAsync: jest.fn(async (content: string, options: unknown, id?: string) =>
    Promise.resolve(
      (
        jest.requireActual(
          "@cognia/provider-embedding/chunking"
        ) as typeof import("@cognia/provider-embedding/chunking")
      ).chunkDocument(
        content,
        options as Parameters<
          typeof import("@cognia/provider-embedding/chunking").chunkDocument
        >[1],
        id
      )
    )
  ),
}))

jest.mock("./parsers/presentation-parser", () => ({
  parsePresentation: jest.fn(async () => ({
    text: "Slide 1 content\nSlide 2 content",
    slideCount: 2,
    slides: [
      { slideNumber: 1, title: "Slide 1", text: "Slide 1 content" },
      { slideNumber: 2, title: "Slide 2", text: "Slide 2 content" },
    ],
    metadata: { title: "Demo Deck", author: "Tester" },
  })),
  extractPresentationEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/office-parser", () => ({
  parseWord: jest.fn(async () => ({
    text: "Parsed Word content",
    html: "<p>Parsed Word content</p>",
    messages: [{ type: "warning", message: "Some comments were skipped" }],
    images: [],
    metadata: { title: "Word Title", author: "Tester" },
    headings: [{ level: 1, text: "Overview" }],
  })),
  extractWordEmbeddableContent: jest.fn((result: { text: string }) => result.text),
  parseExcel: jest.fn(async () => ({
    text: "## Sheet: Sheet1\nValue",
    sheets: [{ name: "Sheet1", data: [["Value"]], rowCount: 1, columnCount: 1 }],
    sheetNames: ["Sheet1"],
  })),
  extractExcelEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/open-document-parser", () => ({
  parseOpenDocumentText: jest.fn(async () => ({
    text: "Parsed ODT content",
    html: "<p>Parsed ODT content</p>",
    messages: [],
    images: [],
    metadata: { title: "OpenDocument Text", author: "Tester" },
    headings: [{ level: 1, text: "ODT Heading" }],
  })),
  parseOpenDocumentSpreadsheet: jest.fn(async () => ({
    text: "## Sheet: ODS Sheet\nValue",
    sheets: [{ name: "ODS Sheet", data: [["Value"]], rowCount: 1, columnCount: 1 }],
    sheetNames: ["ODS Sheet"],
  })),
  parseOpenDocumentPresentation: jest.fn(async () => ({
    text: "## Slide 1\nParsed ODP slide",
    slideCount: 1,
    slides: [{ slideNumber: 1, title: "Parsed ODP slide", text: "Parsed ODP slide" }],
    metadata: { title: "ODP Deck", author: "Tester" },
  })),
}))

jest.mock("./parsers/pdf-parser", () => ({
  parsePDF: jest.fn(async () => ({
    text: "PDF page one\nPDF page two",
    pageCount: 2,
    metadata: { title: "PDF Title", author: "PDF Author" },
    pages: [
      { pageNumber: 1, text: "PDF page one" },
      { pageNumber: 2, text: "PDF page two" },
    ],
    diagnostics: [{ code: "parser_warning", severity: "warning", message: "PDF warning" }],
  })),
  extractPDFEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/rtf-parser", () => ({
  parseRTF: jest.fn((content: string) => ({
    text: content.includes("rtf") ? "Parsed RTF content" : "Parsed content",
    metadata: { charset: "windows-1252", controlWordCount: 4 },
  })),
  extractRTFEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

jest.mock("./parsers/epub-parser", () => ({
  parseEPUB: jest.fn(async () => ({
    text: "Chapter 1 text\nChapter 2 text",
    chapterCount: 2,
    chapters: [
      { id: "c1", href: "c1.xhtml", title: "C1", text: "Chapter 1 text" },
      { id: "c2", href: "c2.xhtml", title: "C2", text: "Chapter 2 text" },
    ],
    metadata: { title: "Book Title", author: "Book Author" },
  })),
  extractEPUBEmbeddableContent: jest.fn((result: { text: string }) => result.text),
}))

describe("detectDocumentType", () => {
  describe("markdown files", () => {
    it("detects .md files", () => {
      expect(detectDocumentType("readme.md")).toBe("markdown")
    })

    it("detects .markdown files", () => {
      expect(detectDocumentType("doc.markdown")).toBe("markdown")
    })

    it("detects .mdx files", () => {
      expect(detectDocumentType("component.mdx")).toBe("markdown")
    })
  })

  describe("code files", () => {
    it("detects JavaScript files", () => {
      expect(detectDocumentType("app.js")).toBe("code")
      expect(detectDocumentType("app.jsx")).toBe("code")
    })

    it("detects TypeScript files", () => {
      expect(detectDocumentType("app.ts")).toBe("code")
      expect(detectDocumentType("app.tsx")).toBe("code")
    })

    it("detects Python files", () => {
      expect(detectDocumentType("script.py")).toBe("code")
    })

    it("detects Go files", () => {
      expect(detectDocumentType("main.go")).toBe("code")
    })

    it("detects Rust files", () => {
      expect(detectDocumentType("lib.rs")).toBe("code")
    })

    it("detects C/C++ files", () => {
      expect(detectDocumentType("main.c")).toBe("code")
      expect(detectDocumentType("main.cpp")).toBe("code")
      expect(detectDocumentType("header.h")).toBe("code")
      expect(detectDocumentType("header.hpp")).toBe("code")
    })

    it("detects Java files", () => {
      expect(detectDocumentType("Main.java")).toBe("code")
    })

    it("detects shell scripts", () => {
      expect(detectDocumentType("script.sh")).toBe("code")
      expect(detectDocumentType("script.bash")).toBe("code")
    })

    it("detects CSS/SCSS files", () => {
      expect(detectDocumentType("style.css")).toBe("code")
      expect(detectDocumentType("style.scss")).toBe("code")
    })

    it("detects XML files", () => {
      expect(detectDocumentType("config.xml")).toBe("code")
    })

    it("detects YAML files", () => {
      expect(detectDocumentType("config.yaml")).toBe("code")
      expect(detectDocumentType("config.yml")).toBe("code")
    })

    it("detects SQL files", () => {
      expect(detectDocumentType("query.sql")).toBe("code")
    })
  })

  describe("JSON files", () => {
    it("detects JSON files", () => {
      expect(detectDocumentType("package.json")).toBe("json")
    })
  })

  describe("text files", () => {
    it("detects .txt files", () => {
      expect(detectDocumentType("notes.txt")).toBe("text")
    })
  })

  describe("HTML files", () => {
    it("detects .html files", () => {
      expect(detectDocumentType("index.html")).toBe("html")
    })

    it("detects .htm files", () => {
      expect(detectDocumentType("page.htm")).toBe("html")
    })

    it("detects .xhtml files", () => {
      expect(detectDocumentType("doc.xhtml")).toBe("html")
    })
  })

  describe("PDF files", () => {
    it("detects .pdf files", () => {
      expect(detectDocumentType("document.pdf")).toBe("pdf")
    })
  })

  describe("Word documents", () => {
    it("detects .docx files", () => {
      expect(detectDocumentType("document.docx")).toBe("word")
    })

    it("detects .doc files", () => {
      expect(detectDocumentType("document.doc")).toBe("word")
    })
  })

  describe("Excel files", () => {
    it("detects .xlsx files", () => {
      expect(detectDocumentType("spreadsheet.xlsx")).toBe("excel")
    })

    it("detects .xls files", () => {
      expect(detectDocumentType("spreadsheet.xls")).toBe("excel")
    })
  })

  describe("CSV files", () => {
    it("detects .csv files", () => {
      expect(detectDocumentType("data.csv")).toBe("csv")
    })

    it("detects .tsv files", () => {
      expect(detectDocumentType("data.tsv")).toBe("csv")
    })
  })

  describe("unknown files", () => {
    it("returns unknown for unrecognized extensions", () => {
      expect(detectDocumentType("file.xyz")).toBe("unknown")
    })

    it("returns unknown for files without extension", () => {
      expect(detectDocumentType("Dockerfile")).toBe("unknown")
    })
  })
})

describe("processDocument", () => {
  it("processes markdown document", () => {
    const result = processDocument("doc-1", "readme.md", "# Title\n\nContent here")

    expect(result.id).toBe("doc-1")
    expect(result.filename).toBe("readme.md")
    expect(result.type).toBe("markdown")
    expect(result.metadata.language).toBe("markdown")
    expect(result.parseSummary).toMatchObject({
      parser: "markdown",
      structure: expect.objectContaining({
        sectionCount: 1,
      }),
    })
    expect(result.metadata.parseSummary).toEqual(result.parseSummary)
  })

  it("processes code document", () => {
    const result = processDocument("doc-2", "app.ts", 'function hello() { return "world"; }')

    expect(result.type).toBe("code")
    expect(result.metadata.language).toBe("typescript")
  })

  it("processes JSON document", () => {
    const result = processDocument("doc-3", "config.json", '{"key": "value", "array": [1, 2, 3]}')

    expect(result.type).toBe("json")
    expect(result.metadata.language).toBe("json")
    expect(result.metadata.isArray).toBe(false)
    expect(result.metadata.keyCount).toBe(2)
  })

  it("handles JSON arrays", () => {
    const result = processDocument("doc-4", "data.json", "[1, 2, 3]")

    expect(result.metadata.isArray).toBe(true)
  })

  it("handles invalid JSON gracefully", () => {
    const result = processDocument("doc-5", "bad.json", "{invalid json}")

    expect(result.type).toBe("json")
    expect(result.metadata.keyCount).toBeUndefined()
  })

  it("handles primitive JSON values with zero object keys", () => {
    const result = processDocument("doc-json-primitive", "answer.json", "42")

    expect(result.type).toBe("json")
    expect(result.metadata.keyCount).toBe(0)
    expect(result.metadata.isArray).toBe(false)
  })

  it("calculates correct metadata", () => {
    const content = "Line 1\nLine 2\nLine 3"
    const result = processDocument("doc-6", "file.txt", content)

    expect(result.metadata.size).toBe(content.length)
    expect(result.metadata.lineCount).toBe(3)
    expect(result.metadata.wordCount).toBe(6)
  })

  it("extracts embeddable content when enabled", () => {
    const result = processDocument("doc-7", "readme.md", "# Title\n\nContent", {
      extractEmbeddable: true,
    })

    expect(result.embeddableContent).toBeDefined()
  })

  it("generates chunks when requested", () => {
    const longContent = "word ".repeat(500)
    const result = processDocument("doc-8", "large.md", longContent, {
      generateChunks: true,
      chunkingOptions: { chunkSize: 100 },
    })

    expect(result.chunks).toBeDefined()
    expect(result.chunks!.length).toBeGreaterThan(1)
  })

  it("skips chunk generation by default", () => {
    const result = processDocument("doc-9", "file.txt", "content")

    expect(result.chunks).toBeUndefined()
  })

  it("preserves source content when markdown and code embeddable extraction is disabled", () => {
    const markdown = "# Title\n\nBody"
    const code = "export function hello() { return 'world' }"

    expect(
      processDocument("doc-no-md-extract", "readme.md", markdown, {
        extractEmbeddable: false,
      }).embeddableContent
    ).toBe(markdown)
    expect(
      processDocument("doc-no-code-extract", "hello.ts", code, {
        extractEmbeddable: false,
      }).embeddableContent
    ).toBe(code)
  })

  it("extracts frontmatter tags into markdown metadata", () => {
    const result = processDocument(
      "doc-frontmatter",
      "notes.md",
      "---\ntags:\n  - alpha\n  - beta\n---\n# Notes\n\nBody"
    )

    expect(result.metadata.tags).toEqual(["alpha", "beta"])
  })
})

describe("processDocumentAsync", () => {
  beforeEach(() => {
    mockParseLegacyOfficeWithAnyDoc.mockReset()
    jest.mocked(parseWord).mockClear()
    jest.mocked(parseExcel).mockClear()
    jest.mocked(parsePresentation).mockClear()
    jest.mocked(parseOpenDocumentText).mockClear()
    jest.mocked(parseOpenDocumentSpreadsheet).mockClear()
    jest.mocked(parseOpenDocumentPresentation).mockClear()
  })

  it("processes legacy Word documents as Markdown through AnyDoc", async () => {
    const input = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer
    mockParseLegacyOfficeWithAnyDoc.mockResolvedValueOnce({
      markdown: "# Legacy Word\n\nReadable body",
      format: "doc",
      engineVersion: "0.1.9",
    })

    const result = await processDocumentAsync("legacy-word", "legacy.doc", input, {
      anyDoc: { enabled: true },
    })

    expect(mockParseLegacyOfficeWithAnyDoc).toHaveBeenCalledWith(input, "doc", {
      signal: undefined,
      timeoutMs: undefined,
    })
    expect(result).toMatchObject({
      type: "word",
      content: "# Legacy Word\n\nReadable body",
      embeddableContent: "# Legacy Word\n\nReadable body",
      metadata: {
        parseEngine: "anydoc",
        parseEngineVersion: "0.1.9",
        parseMode: "markdown-only",
      },
      parseSummary: {
        parser: "word",
        structure: { segmentCount: 1 },
        quality: { status: "partial" },
      },
      parseDiagnostics: [expect.objectContaining({ code: "parser_info", severity: "info" })],
    })
    expect(result.parseResult).toBeUndefined()
  })

  it("keeps the existing rich Word parser for a DOCX file mislabeled as .doc", async () => {
    mockParseLegacyOfficeWithAnyDoc.mockRejectedValueOnce(
      new AnyDocParseError("The file is actually docx", "formatMismatch", "docx")
    )

    const result = await processDocumentAsync(
      "mislabeled-word",
      "modern.doc",
      fileBytes("modern.doc"),
      {
        anyDoc: { enabled: true },
      }
    )

    expect(parseWord).toHaveBeenCalled()
    expect(result.content).toContain("Parsed Word content")
    expect(result.parseResult).toBeDefined()
    expect(result.metadata.parseEngine).toBeUndefined()
  })

  it("does not guess a parser when legacy Word content has an unrelated signature", async () => {
    const mismatch = new AnyDocParseError(
      "The file is actually a presentation",
      "formatMismatch",
      "ppt"
    )
    mockParseLegacyOfficeWithAnyDoc.mockRejectedValueOnce(mismatch)

    await expect(
      processDocumentAsync("wrong-word", "wrong.doc", fileBytes("wrong.doc"), {
        anyDoc: { enabled: true },
      })
    ).rejects.toBe(mismatch)
    expect(parseWord).not.toHaveBeenCalled()
  })

  it("forwards AbortSignal and preserves user cancellation", async () => {
    const controller = new AbortController()
    const cancellation = new DOMException("cancelled", "AbortError")
    mockParseLegacyOfficeWithAnyDoc.mockRejectedValueOnce(cancellation)

    await expect(
      processDocumentAsync("cancelled-word", "cancelled.doc", fileBytes("cancelled.doc"), {
        anyDoc: { enabled: true, signal: controller.signal, timeoutMs: 15_000 },
      })
    ).rejects.toBe(cancellation)
    expect(mockParseLegacyOfficeWithAnyDoc).toHaveBeenCalledWith(expect.any(ArrayBuffer), "doc", {
      signal: controller.signal,
      timeoutMs: 15_000,
    })
  })

  it("keeps the AnyDoc rollout gate disabled by default", async () => {
    const word = await processDocumentAsync("gated-word", "legacy.doc", fileBytes("legacy.doc"))

    expect(word.parseResult).toBeDefined()
    expect(mockParseLegacyOfficeWithAnyDoc).not.toHaveBeenCalled()
    await expect(
      processDocumentAsync("gated-presentation", "legacy.ppt", fileBytes("legacy.ppt"))
    ).rejects.toThrow("convert to .pptx")
    expect(mockParseLegacyOfficeWithAnyDoc).not.toHaveBeenCalled()
  })

  it("processes macro-enabled word files via office parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-word",
      "template.docm",
      fileBytes("template.docm")
    )

    expect(parseWord).toHaveBeenCalled()
    expect(result.type).toBe("word")
    expect(result.content).toContain("Parsed Word content")
    expect(result.parseSummary).toMatchObject({
      parser: "word",
      structure: expect.objectContaining({
        headingCount: 1,
      }),
    })
    expect(result.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "parser_warning",
        severity: "warning",
      }),
    ])
  })

  it("processes pdf string data through the async parser and generates chunks", async () => {
    const result = await processDocumentAsync("doc-async-pdf", "report.pdf", "%PDF-1.7 body", {
      generateChunks: true,
    })

    expect(result.type).toBe("pdf")
    expect(result.content).toContain("PDF page one")
    expect(result.metadata.pageCount).toBe(2)
    expect(result.metadata.author).toBe("PDF Author")
    expect(result.parseDiagnostics).toEqual([
      expect.objectContaining({
        code: "parser_warning",
        severity: "warning",
      }),
    ])
    expect(result.chunks).toBeDefined()
  })

  it("uses raw PDF content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync("doc-async-pdf-raw", "report.pdf", "%PDF-1.7 body", {
      extractEmbeddable: false,
    })

    expect(result.type).toBe("pdf")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes macro-enabled excel files via office parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-excel",
      "financials.xlsm",
      fileBytes("financials.xlsm")
    )

    expect(parseExcel).toHaveBeenCalled()
    expect(result.type).toBe("excel")
    expect(result.content).toContain("Sheet1")
  })

  it("uses raw rich parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-word-extract",
      "notes.docx",
      fileBytes("notes.docx"),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("word")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("uses raw spreadsheet parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-excel-extract",
      "financials.xlsx",
      fileBytes("financials.xlsx"),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("excel")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes presentation files via presentation parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-1",
      "slides.pptx",
      fileBytes("slides.pptx")
    )

    expect(result.type).toBe("presentation")
    expect(result.content).toContain("Slide 1 content")
    expect(result.metadata.slideCount).toBe(2)
    expect(result.metadata.language).toBe("presentation")
    expect(result.parseSummary).toMatchObject({
      parser: "presentation",
      structure: expect.objectContaining({
        slideCount: 2,
        segmentCount: 2,
      }),
    })
  })

  it("uses raw presentation parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-presentation-extract",
      "slides.pptx",
      fileBytes("slides.pptx"),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("presentation")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes rtf files via rtf parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-2",
      "notes.rtf",
      "{\\rtf1\\ansi\\pard hello\\par}"
    )

    expect(result.type).toBe("rtf")
    expect(result.content).toBe("Parsed RTF content")
    expect(result.metadata.language).toBe("rtf")
  })

  it("uses raw RTF parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-rtf-extract",
      "notes.rtf",
      "{\\rtf1\\ansi\\pard hello\\par}",
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("rtf")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes epub files via epub parser", async () => {
    const result = await processDocumentAsync("doc-async-3", "book.epub", fileBytes("book.epub"))

    expect(result.type).toBe("epub")
    expect(result.content).toContain("Chapter 1 text")
    expect(result.metadata.chapterCount).toBe(2)
    expect(result.metadata.language).toBe("epub")
  })

  it("uses raw EPUB parser content when embeddable extraction is disabled", async () => {
    const result = await processDocumentAsync(
      "doc-no-epub-extract",
      "book.epub",
      fileBytes("book.epub"),
      {
        extractEmbeddable: false,
      }
    )

    expect(result.type).toBe("epub")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes csv ArrayBuffer data through the async parser", async () => {
    const buffer = new TextEncoder().encode("name,score\nAda,10\nLinus,9").buffer
    const result = await processDocumentAsync("doc-async-csv", "scores.csv", buffer)

    expect(result.type).toBe("csv")
    expect(result.metadata.rowCount).toBe(2)
    expect(result.metadata.columnCount).toBe(2)
    expect(result.metadata.headers).toEqual(["name", "score"])
    expect(result.parseSummary?.parser).toBe("csv")
  })

  it("processes csv string data and can disable embeddable extraction", async () => {
    const result = await processDocumentAsync("doc-async-csv-string", "scores.csv", "name\nAda", {
      extractEmbeddable: false,
    })

    expect(result.type).toBe("csv")
    expect(result.content).toBe("name\nAda")
    expect(result.embeddableContent).toBe(result.content)
  })

  it("processes html ArrayBuffer data through the async parser", async () => {
    const buffer = new TextEncoder().encode(
      "<html><head><title>Page Title</title></head><body><h1>Hello</h1><a href='/a'>A</a><img src='image.png' alt='Image'></body></html>"
    ).buffer
    const result = await processDocumentAsync("doc-async-html", "page.html", buffer, {
      extractEmbeddable: false,
    })

    expect(result.type).toBe("html")
    expect(result.metadata.title).toBe("Page Title")
    expect(result.metadata.linkCount).toBe(1)
    expect(result.metadata.imageCount).toBe(1)
    expect(result.embeddableContent).toContain("Hello")
  })

  it("processes html string data with embeddable extraction enabled", async () => {
    const result = await processDocumentAsync(
      "doc-async-html-string",
      "page.html",
      "<html><body><main><h1>Hello</h1><p>Body</p></main></body></html>"
    )

    expect(result.type).toBe("html")
    expect(result.embeddableContent).toContain("Hello")
    expect(result.metadata.wordCount).toBeGreaterThan(0)
  })

  it("processes open document text files via dedicated parser", async () => {
    const result = await processDocumentAsync("doc-async-odt", "notes.odt", fileBytes("notes.odt"))

    expect(parseOpenDocumentText).toHaveBeenCalled()
    expect(result.type).toBe("word")
    expect(result.content).toContain("Parsed ODT content")
  })

  it("processes open document spreadsheets via dedicated parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-ods",
      "budget.ods",
      fileBytes("budget.ods")
    )

    expect(parseOpenDocumentSpreadsheet).toHaveBeenCalled()
    expect(result.type).toBe("excel")
    expect(result.content).toContain("ODS Sheet")
  })

  it("processes open document presentations via dedicated parser", async () => {
    const result = await processDocumentAsync(
      "doc-async-odp",
      "roadmap.odp",
      fileBytes("roadmap.odp")
    )

    expect(parseOpenDocumentPresentation).toHaveBeenCalled()
    expect(result.type).toBe("presentation")
    expect(result.content).toContain("Parsed ODP slide")
  })

  it("processes legacy PowerPoint documents as Markdown through AnyDoc", async () => {
    const input = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer
    mockParseLegacyOfficeWithAnyDoc.mockResolvedValueOnce({
      markdown: "# Legacy deck\n\nSlide body",
      format: "ppt",
      engineVersion: "0.1.9",
    })

    const result = await processDocumentAsync("legacy-presentation", "legacy.ppt", input, {
      anyDoc: { enabled: true },
    })

    expect(mockParseLegacyOfficeWithAnyDoc).toHaveBeenCalledWith(input, "ppt", {
      signal: undefined,
      timeoutMs: undefined,
    })
    expect(result).toMatchObject({
      type: "presentation",
      content: "# Legacy deck\n\nSlide body",
      metadata: {
        parseEngine: "anydoc",
        parseEngineVersion: "0.1.9",
        parseMode: "markdown-only",
      },
      parseSummary: {
        parser: "presentation",
        structure: { segmentCount: 1 },
        quality: { status: "partial" },
      },
      parseDiagnostics: [expect.objectContaining({ code: "parser_info", severity: "info" })],
    })
    expect(result.parseResult).toBeUndefined()
  })

  it("keeps the existing rich presentation parser for PPTX mislabeled as .ppt", async () => {
    mockParseLegacyOfficeWithAnyDoc.mockRejectedValueOnce(
      new AnyDocParseError("The file is actually pptx", "formatMismatch", "pptx")
    )

    const result = await processDocumentAsync(
      "mislabeled-presentation",
      "modern.ppt",
      fileBytes("modern.ppt"),
      { anyDoc: { enabled: true } }
    )

    expect(parsePresentation).toHaveBeenCalled()
    expect(result.content).toContain("Slide 1 content")
    expect(result.parseResult).toBeDefined()
    expect(result.metadata.parseEngine).toBeUndefined()
  })

  it("does not guess a parser when legacy PowerPoint content has an unrelated signature", async () => {
    const mismatch = new AnyDocParseError(
      "The file is actually a Word document",
      "formatMismatch",
      "doc"
    )
    mockParseLegacyOfficeWithAnyDoc.mockRejectedValueOnce(mismatch)

    await expect(
      processDocumentAsync("wrong-presentation", "wrong.ppt", fileBytes("wrong.ppt"), {
        anyDoc: { enabled: true },
      })
    ).rejects.toBe(mismatch)
    expect(parsePresentation).not.toHaveBeenCalled()
  })

  it("throws actionable error for unreadable macro-enabled word files", async () => {
    jest.mocked(parseWord).mockRejectedValueOnce(new Error("zip failure"))

    await expect(
      processDocumentAsync("doc-async-docm-error", "protected.docm", fileBytes("protected.docm"))
    ).rejects.toMatchObject({
      message: expect.stringContaining("password protected or corrupted"),
      diagnostic: expect.objectContaining({
        code: "parse_failed",
        severity: "error",
      }),
    })
  })

  it("preserves parser-specific document parse errors", async () => {
    jest.mocked(parseWord).mockRejectedValueOnce(new Error("password protected document"))

    await expect(
      processDocumentAsync("doc-protected-word", "protected.docx", fileBytes("protected.docx"))
    ).rejects.toMatchObject({
      message: "password protected document",
      diagnostic: expect.objectContaining({
        code: "parse_failed",
        severity: "error",
      }),
    })
  })

  it("normalizes non-Error spreadsheet parser failures", async () => {
    jest.mocked(parseExcel).mockRejectedValueOnce("zip failure")

    await expect(
      processDocumentAsync("doc-async-xlsx-error", "broken.xlsx", fileBytes("broken.xlsx"))
    ).rejects.toMatchObject({
      message: expect.stringContaining("spreadsheet file"),
      diagnostic: expect.objectContaining({
        code: "parse_failed",
        severity: "error",
      }),
    })
  })

  it("throws actionable error for unreadable macro-enabled presentation files", async () => {
    jest.mocked(parsePresentation).mockRejectedValueOnce(new Error("zip failure"))

    await expect(
      processDocumentAsync("doc-async-pptm-error", "protected.pptm", fileBytes("protected.pptm"))
    ).rejects.toThrow("password protected or corrupted")
  })

  it("falls back to sync processing for unknown types", async () => {
    const result = await processDocumentAsync("doc-async-5", "raw.bin", "plain text body")
    expect(result.type).toBe("unknown")
    expect(result.content).toBe("plain text body")
  })

  it("decodes unknown ArrayBuffer data before falling back to sync processing", async () => {
    const buffer = new TextEncoder().encode("plain buffer body").buffer
    const result = await processDocumentAsync("doc-async-buffer", "raw.bin", buffer)

    expect(result.type).toBe("unknown")
    expect(result.content).toBe("plain buffer body")
  })

  // F4: IM adapters hand every attachment over as an ArrayBuffer.
  it.each([
    ["notes.txt", "text", "plain note"],
    ["readme.md", "markdown", "# Title\n\nBody"],
    ["config.json", "json", '{"a":1}'],
    ["main.py", "code", "def main():\n    return 1"],
    ["feed.xml", "code", "<feed><title>x</title></feed>"],
  ])("reads a %s ArrayBuffer as %s text", async (filename, type, text) => {
    const buffer = new TextEncoder().encode(text).buffer
    const result = await processDocumentAsync("bytes", filename, buffer)

    expect(result.type).toBe(type)
    expect(result.content).toBe(text)
    expect(result.parseDiagnostics).toEqual([])
  })

  it("decodes UTF-8 and UTF-16 byte-order marks and drops them", async () => {
    const utf8 = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("中文")]).buffer
    const utf16le = Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]).buffer
    const utf16be = Uint8Array.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]).buffer

    for (const buffer of [utf8, utf16le, utf16be]) {
      expect((await processDocumentAsync("bom", "notes.txt", buffer)).content).toBe("中文")
    }
  })

  it("reports bytes that are not valid UTF-8 instead of decoding them silently", async () => {
    const buffer = Uint8Array.from([0x61, 0xff, 0x62]).buffer
    const result = await processDocumentAsync("bad", "notes.txt", buffer)

    expect(result.content).toBe("a�b")
    expect(result.parseDiagnostics).toEqual([
      expect.objectContaining({ code: "parser_warning", severity: "warning" }),
    ])
  })

  it("refuses UTF-32 text rather than reading it as another encoding", async () => {
    const buffer = Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]).buffer
    await expect(processDocumentAsync("u32", "notes.txt", buffer)).rejects.toThrow("UTF-32")
  })

  // F3: the format picks the parser, whether the payload is a string or bytes.
  it("parses an HTML string with the HTML parser, keeping script and markup out", async () => {
    const html =
      "<html><head><title>Guide</title><script>steal()</script><style>p{}</style></head>" +
      "<body><h1>Install</h1><p>Run <b>setup</b>.</p></body></html>"
    const fromString = await processDocumentAsync("html-s", "guide.html", html)
    const fromBytes = await processDocumentAsync(
      "html-b",
      "guide.html",
      new TextEncoder().encode(html).buffer
    )

    for (const result of [fromString, fromBytes]) {
      expect(result.parseSummary?.parser).toBe("html")
      expect(result.parseResult).toBeDefined()
      expect(result.content).toContain("# Install")
      expect(result.content).toContain("**setup**")
      for (const text of [result.content, result.embeddableContent]) {
        expect(text).not.toContain("steal()")
        expect(text).not.toContain("<p>")
      }
    }
    expect(fromString.content).toBe(fromBytes.content)
  })

  it("parses a CSV string with the CSV parser", async () => {
    const csv = 'name,note\nAda,"line one\nline two"\n'
    const result = await processDocumentAsync("csv-s", "people.csv", csv)

    expect(result.parseSummary?.parser).toBe("csv")
    expect(result.metadata.rowCount).toBe(1)
    expect(result.metadata.headers).toEqual(["name", "note"])
  })

  it("refuses rich formats in the sync processor instead of reading them as text", () => {
    expect(() => processDocument("x", "page.html", "<p>x</p>")).toThrow("processDocumentAsync")
    expect(() => processDocument("x", "rows.csv", "a,b")).toThrow("processDocumentAsync")
  })

  // F7: `maxFileSize` was declared and never enforced.
  it("enforces maxFileSize on strings (as UTF-8 bytes) and on ArrayBuffers", async () => {
    await expect(
      processDocumentAsync("big", "notes.txt", "a".repeat(37), { maxFileSize: 2 })
    ).rejects.toMatchObject({ name: "DocumentLimitError", scope: "file-bytes", limit: 2 })
    await expect(
      processDocumentAsync("big", "deck.pptx", fileBytes("deck.pptx"), { maxFileSize: 4 })
    ).rejects.toMatchObject({ scope: "file-bytes", observed: 8 })
    // Three characters, nine bytes.
    expect(() => processDocument("cjk", "notes.txt", "中文字", { maxFileSize: 8 })).toThrow(
      "file-bytes"
    )
    expect(processDocument("cjk", "notes.txt", "中文字", { maxFileSize: 9 }).content).toBe("中文字")
    expect(parsePresentation).not.toHaveBeenCalled()
  })
})

describe("getFileExtension", () => {
  it("returns extension for normal files", () => {
    expect(getFileExtension("file.txt")).toBe("txt")
  })

  it("returns last extension for multiple dots", () => {
    expect(getFileExtension("file.test.ts")).toBe("ts")
  })

  it("returns lowercase extension", () => {
    expect(getFileExtension("FILE.TXT")).toBe("txt")
  })

  it("returns empty string for files without extension", () => {
    expect(getFileExtension("Dockerfile")).toBe("")
  })

  it("handles dotfiles", () => {
    expect(getFileExtension(".gitignore")).toBe("")
  })
})

describe("estimateTokenCount", () => {
  it("estimates tokens for short text", () => {
    const result = estimateTokenCount("Hello world")
    expect(result).toBeGreaterThan(0)
    expect(result).toBeLessThan(10)
  })

  it("estimates tokens for longer text", () => {
    const content = "word ".repeat(100)
    const result = estimateTokenCount(content)
    expect(result).toBeGreaterThan(50)
  })

  it("returns 0 for empty string", () => {
    expect(estimateTokenCount("")).toBe(0)
  })

  it("estimates more tokens for CJK text", () => {
    // 10 CJK characters should produce more tokens than 10 English chars
    const cjk = "这是一个测试文本内容啊"
    const english = "ABCDEFGHIJ"
    const cjkTokens = estimateTokenCount(cjk)
    const englishTokens = estimateTokenCount(english)
    expect(cjkTokens).toBeGreaterThan(englishTokens)
  })

  it("handles mixed CJK and English text", () => {
    const mixed = "Hello 你好 World 世界"
    const result = estimateTokenCount(mixed)
    expect(result).toBeGreaterThan(0)
  })

  it("uses roughly 4 characters per token for pure English", () => {
    const content = "A".repeat(100)
    const result = estimateTokenCount(content)
    expect(result).toBeCloseTo(25, 0)
  })
})

describe("detectEncoding", () => {
  it("detects UTF-8 BOM", () => {
    const buffer = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]).buffer
    expect(detectEncoding(buffer)).toBe("utf-8")
  })

  it("detects UTF-16 LE BOM", () => {
    const buffer = new Uint8Array([0xff, 0xfe, 0x41, 0x00]).buffer
    expect(detectEncoding(buffer)).toBe("utf-16le")
  })

  it("detects UTF-16 BE BOM", () => {
    const buffer = new Uint8Array([0xfe, 0xff, 0x00, 0x41]).buffer
    expect(detectEncoding(buffer)).toBe("utf-16be")
  })

  it("detects UTF-32 LE BOM before the UTF-16 LE prefix", () => {
    const buffer = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41]).buffer
    expect(detectEncoding(buffer)).toBe("utf-32le")
  })

  it("defaults to utf-8 for no BOM", () => {
    const buffer = new Uint8Array([0x41, 0x42, 0x43]).buffer
    expect(detectEncoding(buffer)).toBe("utf-8")
  })
})

describe("new document type detection", () => {
  it("detects presentation files", () => {
    expect(detectDocumentType("slides.pptx")).toBe("presentation")
    expect(detectDocumentType("deck.ppt")).toBe("presentation")
  })

  it("detects macro-enabled office files", () => {
    expect(detectDocumentType("template.docm")).toBe("word")
    expect(detectDocumentType("financials.xlsm")).toBe("excel")
    expect(detectDocumentType("deck.pptm")).toBe("presentation")
  })

  it("detects open document formats", () => {
    expect(detectDocumentType("notes.odt")).toBe("word")
    expect(detectDocumentType("sheet.ods")).toBe("excel")
    expect(detectDocumentType("slides.odp")).toBe("presentation")
  })

  it("detects RTF files", () => {
    expect(detectDocumentType("document.rtf")).toBe("rtf")
  })

  it("detects EPUB files", () => {
    expect(detectDocumentType("book.epub")).toBe("epub")
  })
})

describe("complete source locators", () => {
  it("preserves all PDF page numbers and exact page text", async () => {
    const result = await processDocumentAsync("pdf", "document.pdf", fileBytes("document.pdf"))
    expect(result.sourceSegments).toEqual([
      { id: "pdf:page:1", text: "PDF page one", locator: { type: "page", page: 1 } },
      { id: "pdf:page:2", text: "PDF page two", locator: { type: "page", page: 2 } },
    ])
  })
  it("preserves spreadsheet sheet names and cell ranges", async () => {
    const result = await processDocumentAsync("book", "book.xlsx", fileBytes("book.xlsx"))
    expect(result.sourceSegments?.[0]).toEqual({
      id: "book:sheet:1",
      text: '"Value"',
      locator: { type: "sheet", sheet: "Sheet1", range: "A1:A1" },
    })
  })
  it("preserves all slide numbers and slide text", async () => {
    const result = await processDocumentAsync("deck", "deck.pptx", fileBytes("deck.pptx"))
    expect(result.sourceSegments).toEqual([
      { id: "deck:slide:1", text: "Slide 1 content", locator: { type: "slide", slide: 1 } },
      { id: "deck:slide:2", text: "Slide 2 content", locator: { type: "slide", slide: 2 } },
    ])
  })
  it("preserves text offsets for nonstructural document formats", async () => {
    const result = await processDocumentAsync("text", "notes.txt", "Complete note")
    expect(result.sourceSegments).toEqual([
      { id: "text:text", text: "Complete note", locator: { type: "text", start: 0, end: 13 } },
    ])
  })
  it("does not parse documents already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      processDocumentAsync("cancelled", "document.pdf", fileBytes("document.pdf"), {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})

it("keeps source segments canonical when the Markdown embedding projection removes structure", () => {
  const content = "# Heading\n\nOriginal body\n```ts\nconst value = 3\n```"
  const processed = processDocument("source", "guide.md", content)
  expect(processed.structure?.contentHash).toBeDefined()
  expect(processed.structure?.nodes[1].title).toBe("Heading")
  expect(processed.sourceSegments?.[0].text).toBe(content)
  expect(processed.embeddableContent).not.toBe(content)
})

describe("typed tables (G3)", () => {
  const salesHtml = `<html><body>
    <p>North leads the year.</p>
    <table>
      <thead><tr><th>Region</th><th>Q1</th><th>Q2</th></tr></thead>
      <tbody>
        <tr><td rowspan="2">North</td><td>1</td><td>2</td></tr>
        <tr><td>3</td><td>4</td></tr>
      </tbody>
    </table>
  </body></html>`

  it("keeps an HTML table's merged cells in the structure and its rows in the text", async () => {
    const result = await processDocumentAsync("sales", "sales.html", salesHtml)

    // The text is Markdown: the merged region repeats on the row it covers,
    // and 3 sits under Q1, not under Region.
    expect(result.content).toContain(
      "| Region | Q1 | Q2 |\n| --- | --- | --- |\n| North | 1 | 2 |\n| North | 3 | 4 |"
    )
    const [table] = result.structure?.tables ?? []
    expect(table).toMatchObject({
      index: 1,
      rowCount: 3,
      columnCount: 3,
      headerRowCount: 1,
    })
    expect(table.cells).toContainEqual(
      expect.objectContaining({ row: 1, column: 0, rowSpan: 2, text: "North" })
    )
    expect(table.cells).toContainEqual(expect.objectContaining({ row: 2, column: 1, text: "3" }))
    // The locator spans the table in the text, past the prose mention of North.
    expect(table.locator).toMatchObject({ type: "text" })
    const locator = table.locator as { start: number; end: number }
    expect(result.content.slice(locator.start, locator.end)).toBe(
      "Region | Q1 | Q2 |\n| --- | --- | --- |\n| North | 1 | 2 |\n| North | 3 | 4"
    )
    expect(result.parseDiagnostics).toContainEqual(
      expect.objectContaining({ code: "table_merges_projected", severity: "info" })
    )
  })

  it("reports no projected merges for a table without any", async () => {
    const result = await processDocumentAsync(
      "plain",
      "plain.html",
      "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>"
    )
    expect(result.structure?.tables).toHaveLength(1)
    expect(result.parseDiagnostics?.map((diagnostic) => diagnostic.code)).not.toContain(
      "table_merges_projected"
    )
  })

  it("gives a delimited file one table headed by its header row", async () => {
    const result = await processDocumentAsync("people", "people.csv", "name,age\nAda,36\nLin,")
    expect(result.structure?.tables).toEqual([
      expect.objectContaining({
        index: 1,
        rowCount: 3,
        columnCount: 2,
        headerRowCount: 1,
        cells: [
          expect.objectContaining({ row: 0, column: 0, text: "name", header: true }),
          expect.objectContaining({ row: 0, column: 1, text: "age", header: true }),
          expect.objectContaining({ row: 1, column: 0, text: "Ada" }),
          expect.objectContaining({ row: 1, column: 1, text: "36" }),
          expect.objectContaining({ row: 2, column: 0, text: "Lin" }),
        ],
      }),
    ])
  })

  it("gives each sheet a table located by its range, merges as spans", async () => {
    jest.mocked(parseExcel).mockResolvedValueOnce({
      text: "## Sheet: Sales\nRegion Q1",
      sheets: [
        {
          name: "Sales",
          data: [
            ["Region", "Q1", null],
            ["North", 12.5, 3],
          ],
          rowCount: 2,
          columnCount: 3,
          mergedCells: ["B1:C1"],
        },
      ],
      sheetNames: ["Sales"],
    })
    const result = await processDocumentAsync("book", "sales.xlsx", fileBytes("sales.xlsx"))
    expect(result.structure?.tables).toEqual([
      expect.objectContaining({
        index: 1,
        locator: { type: "sheet", sheet: "Sales", range: "A1:C2" },
        headerRowCount: 1,
        cells: expect.arrayContaining([
          expect.objectContaining({ row: 0, column: 1, columnSpan: 2, text: "Q1", header: true }),
          expect.objectContaining({ row: 1, column: 1, text: "12.5", value: 12.5 }),
        ]),
      }),
    ])
  })

  it("refuses a workbook whose merges widen its grids past the shared budget", async () => {
    jest.mocked(parseExcel).mockResolvedValueOnce({
      text: "## Sheet: A\nx",
      sheets: ["A", "B"].map((name) => ({
        name,
        data: [["x"]],
        rowCount: 1,
        columnCount: 1,
        // 800 × 1000 positions each: either fits alone, both do not.
        mergedCells: ["A1:ALL800"],
      })),
      sheetNames: ["A", "B"],
    })
    await expect(
      processDocumentAsync("wide", "wide.xlsx", fileBytes("wide.xlsx"))
    ).rejects.toMatchObject({ name: "DocumentLimitError", scope: "expanded-cells" })
  })

  it("locates a Word document's tables in its text", async () => {
    jest.mocked(parseWord).mockResolvedValueOnce({
      text: "Results\n\nName\n\nScore\n\nAda\n\n9",
      html: "",
      messages: [],
      images: [],
      headings: [],
      tables: [
        {
          index: 1,
          rowCount: 2,
          columnCount: 2,
          headerRowCount: 1,
          cells: [
            { row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: "Name", header: true },
            { row: 0, column: 1, rowSpan: 1, columnSpan: 1, text: "Score", header: true },
            { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: "Ada" },
            { row: 1, column: 1, rowSpan: 1, columnSpan: 1, text: "9" },
          ],
        },
      ],
    })
    const result = await processDocumentAsync("report", "report.docx", fileBytes("report.docx"))
    const [table] = result.structure?.tables ?? []
    expect(table.locator).toEqual({ type: "text", start: 9, end: 28 })
    expect(result.content.slice(9, 28)).toBe("Name\n\nScore\n\nAda\n\n9")
  })
})

describe("parse identity (G1)", () => {
  it("records the reader, the processing version, the options and when it ran", async () => {
    const before = Date.now()
    const result = await processDocumentAsync("pdf", "document.pdf", fileBytes("document.pdf"))
    expect(result.structure?.parse).toEqual({
      parser: "pdfjs",
      processingVersion: DOCUMENT_PROCESSING_VERSION,
      configHash: expect.any(String),
      strategy: "native",
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
    })
    const parse = result.structure!.parse!
    expect(parse.startedAt).toBeGreaterThanOrEqual(before)
    expect(parse.completedAt).toBeGreaterThanOrEqual(parse.startedAt)
  })

  it("names the native PDF reader when it read the file", async () => {
    const pdf = await jest.mocked(parsePDF).getMockImplementation()!(new ArrayBuffer(8))
    jest.mocked(parsePDF).mockResolvedValueOnce({ ...pdf, engine: "native-pdf" })
    const result = await processDocumentAsync("pdf", "document.pdf", fileBytes("document.pdf"))
    expect(result.structure?.parse?.parser).toBe("native-pdf")
  })

  it("gives options that change the output a different config hash", async () => {
    const outline = await processDocumentAsync("pdf", "document.pdf", fileBytes("document.pdf"))
    const noOutline = await processDocumentAsync("pdf", "document.pdf", fileBytes("document.pdf"), {
      extractPdfOutline: false,
    })
    const projection = await processDocumentAsync(
      "pdf",
      "document.pdf",
      fileBytes("document.pdf"),
      {
        extractEmbeddable: false,
      }
    )
    expect(noOutline.structure?.parse?.configHash).not.toBe(outline.structure?.parse?.configHash)
    // The embedding projection is not the parse.
    expect(projection.structure?.parse?.configHash).toBe(outline.structure?.parse?.configHash)
  })

  it("keeps the version AnyDoc reports about itself", async () => {
    mockParseLegacyOfficeWithAnyDoc.mockResolvedValueOnce({
      markdown: "# Legacy\n\nBody",
      format: "doc",
      engineVersion: "0.1.9",
    })
    const result = await processDocumentAsync("legacy", "legacy.doc", fileBytes("legacy.doc"), {
      anyDoc: { enabled: true },
    })
    expect(result.structure?.parse).toMatchObject({ parser: "anydoc", parserVersion: "0.1.9" })
  })

  it("names the reader of each format", async () => {
    const readers: Array<[string, string | ArrayBuffer, string]> = [
      ["report.docx", fileBytes("report.docx"), "mammoth"],
      ["book.xlsx", fileBytes("book.xlsx"), "sheetjs"],
      ["deck.pptx", fileBytes("deck.pptx"), "pptx"],
      ["page.html", "<p>x</p>", "html"],
      ["rows.csv", "a,b\n1,2", "csv"],
      ["notes.md", "# Notes", "markdown"],
      ["notes.txt", "plain", "text"],
    ]
    for (const [filename, data, parser] of readers) {
      const result = await processDocumentAsync(filename, filename, data)
      expect([filename, result.structure?.parse?.parser]).toEqual([filename, parser])
    }
  })

  it("makes a Word document's styled headings its sections", async () => {
    jest.mocked(parseWord).mockResolvedValueOnce({
      text: "Overview\n\nWhat it covers\n\nRisks\n\nWhat could go wrong",
      html: "",
      messages: [],
      images: [],
      headings: [
        { level: 1, text: "Overview" },
        { level: 1, text: "Risks" },
      ],
    })
    const result = await processDocumentAsync("plan", "plan.docx", fileBytes("plan.docx"))
    expect(result.structure?.nodes.map((node) => node.title)).toEqual(["", "Overview", "Risks"])
  })
})
