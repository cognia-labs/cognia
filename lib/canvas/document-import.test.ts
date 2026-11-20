import JSZip from "jszip"
import {
  buildImportWarnings,
  CANVAS_IMPORT_MAX_BYTES,
  importCanvasDocument,
  resolveImportLanguage,
  titleFromFilename,
  type CanvasImportDeps,
} from "./document-import"

function fileOf(name: string, body: BlobPart = "hello", type = "text/plain"): File {
  return new File([body], name, { type })
}

async function minimalDocx(extra: Record<string, string> = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", "<Types/>")
  zip.file("word/document.xml", "<w:document/>")
  for (const [path, body] of Object.entries(extra)) zip.file(path, body)
  return zip.generateAsync({ type: "uint8array" })
}

describe("titleFromFilename", () => {
  it("drops the extension and the directory", () => {
    expect(titleFromFilename("notes/Q4 plan.md")).toBe("Q4 plan")
    expect(titleFromFilename("C:\\docs\\report.docx")).toBe("report")
  })

  it("keeps a dotfile whole rather than emptying it", () => {
    expect(titleFromFilename(".eslintrc")).toBe(".eslintrc")
  })

  it("falls back to the filename when the stem is blank", () => {
    expect(titleFromFilename("   .md")).toBe("   .md")
  })
})

describe("resolveImportLanguage", () => {
  it("maps an extension onto the editor's own language set", () => {
    expect(resolveImportLanguage("app.py", "code")).toEqual({ language: "python", type: "code" })
    expect(resolveImportLanguage("Component.tsx", "code")).toEqual({
      language: "tsx",
      type: "code",
    })
  })

  it("opens markdown and latex as writing surfaces, not code", () => {
    expect(resolveImportLanguage("notes.md", "markdown")).toEqual({
      language: "markdown",
      type: "text",
    })
    expect(resolveImportLanguage("paper.tex", "text")).toEqual({
      language: "latex",
      type: "text",
    })
  })

  it("opens a converted binary as markdown whatever it started as", () => {
    // The body is Markdown by the time it gets here, so asking the editor for a
    // `pdf` or `word` grammar would ask for one that does not exist.
    expect(resolveImportLanguage("report.pdf", "pdf")).toEqual({
      language: "markdown",
      type: "text",
    })
    expect(resolveImportLanguage("deck.pptx", "presentation")).toEqual({
      language: "markdown",
      type: "text",
    })
  })

  it("falls back to markdown for an extension it does not know", () => {
    expect(resolveImportLanguage("archive.xyz", "text")).toEqual({
      language: "markdown",
      type: "text",
    })
  })
})

describe("buildImportWarnings", () => {
  it("says a binary format was converted", () => {
    const warnings = buildImportWarnings({ documentType: "pdf", content: "text" })
    expect(warnings).toEqual([{ code: "converted-to-markdown", message: "pdf" }])
  })

  it("says nothing for a text file that arrived intact", () => {
    expect(buildImportWarnings({ documentType: "markdown", content: "# hi" })).toEqual([])
  })

  it("flags a file that produced no readable text", () => {
    const warnings = buildImportWarnings({ documentType: "pdf", content: "   " })
    expect(warnings.map((w) => w.code)).toEqual(["converted-to-markdown", "empty"])
  })

  it("passes parser errors and warnings through, but not its notes", () => {
    const warnings = buildImportWarnings({
      documentType: "word",
      content: "body",
      diagnostics: [
        { code: "unsupported_feature", severity: "warning", message: "Dropped a text box." },
        { code: "parser_info", severity: "info", message: "Used the fast path." },
      ],
    })
    expect(warnings.map((w) => w.message)).toEqual(["word", "Dropped a text box."])
  })
})

describe("importCanvasDocument", () => {
  function deps(overrides: Partial<Awaited<ReturnType<CanvasImportDeps["processDocument"]>>> = {}) {
    const processDocument = jest.fn(async () => ({
      type: "markdown" as const,
      content: "# hello",
      ...overrides,
    }))
    return { processDocument } as unknown as CanvasImportDeps & {
      processDocument: jest.Mock
    }
  }

  it("reads a text file as text so its bytes survive exactly", async () => {
    const d = deps()
    await importCanvasDocument(fileOf("notes.md", "# hello"), d)
    // Routing a text file through the binary path would normalise whitespace
    // and line endings.
    expect(typeof d.processDocument.mock.calls[0][2]).toBe("string")
  })

  it("reads a binary file as bytes", async () => {
    const d = deps({ type: "pdf", content: "converted" })
    await importCanvasDocument(fileOf("report.pdf", "%PDF-1.4", "application/pdf"), d)
    expect(d.processDocument.mock.calls[0][2]).toBeInstanceOf(ArrayBuffer)
  })

  it("prefers the parsed title over the filename", async () => {
    const d = deps({ metadata: { title: "Quarterly Report" } })
    const result = await importCanvasDocument(fileOf("q4-final-v2.md"), d)
    expect(result.title).toBe("Quarterly Report")
  })

  it("falls back to the filename when the parser found no title", async () => {
    const result = await importCanvasDocument(fileOf("q4-final-v2.md"), deps())
    expect(result.title).toBe("q4-final-v2")
  })

  it("carries provenance and the conversion warning", async () => {
    const d = deps({ type: "word", content: "# Heading" })
    const docx = Uint8Array.from(await minimalDocx())
    const result = await importCanvasDocument(fileOf("memo.docx", docx), d)
    expect(result).toMatchObject({
      language: "markdown",
      type: "text",
      sourceFormat: "word",
      sourceFilename: "memo.docx",
    })
    expect(result.warnings.map((w) => w.code)).toContain("converted-to-markdown")
  })

  // F7: Canvas used to hand any file straight to the parser.
  it.each([
    [
      "a file whose bytes contradict its extension",
      fileOf("memo.docx", "not a zip"),
      "type_mismatch",
    ],
    [
      "an executable renamed as text",
      fileOf("notes.txt", Uint8Array.from([0x4d, 0x5a, 0x90, 0x00])),
      "malicious_content",
    ],
  ])("refuses %s before any parser runs", async (_label, file, reason) => {
    const d = deps()
    await expect(importCanvasDocument(file, d)).rejects.toMatchObject({
      name: "CanvasImportRejectedError",
      reason,
    })
    expect(d.processDocument).not.toHaveBeenCalled()
  })

  it("refuses a macro-enabled package before any parser runs", async () => {
    const d = deps()
    const docx = Uint8Array.from(await minimalDocx({ "word/vbaProject.bin": "macro" }))
    await expect(importCanvasDocument(fileOf("memo.docx", docx), d)).rejects.toMatchObject({
      reason: "malicious_content",
    })
    expect(d.processDocument).not.toHaveBeenCalled()
  })

  it("refuses a file over the import ceiling without reading it", async () => {
    const d = deps()
    const file = fileOf("huge.md")
    Object.defineProperty(file, "size", { value: CANVAS_IMPORT_MAX_BYTES + 1 })
    const read = jest.spyOn(file, "arrayBuffer")
    await expect(importCanvasDocument(file, d)).rejects.toMatchObject({ reason: "too_large" })
    expect(read).not.toHaveBeenCalled()
  })

  it("hands the parser the import ceiling as its file-size budget", async () => {
    const d = deps()
    await importCanvasDocument(fileOf("notes.md"), d)
    expect(d.processDocument.mock.calls[0][3]).toEqual({ maxFileSize: CANVAS_IMPORT_MAX_BYTES })
  })
})
