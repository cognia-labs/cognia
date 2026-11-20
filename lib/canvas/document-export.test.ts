/** @jest-environment jsdom */
import {
  buildCanvasExportPayload,
  canvasExportArtifact,
  canvasExportFilename,
  copyCanvasDocumentToClipboard,
  exportCanvasDocument,
  extensionForLanguage,
  getCanvasExportFormats,
} from "./document-export"
import { PdfUnsupportedCharactersError } from "@/lib/files/document-writer/pdf-text"
import type { ArtifactLanguage, CanvasDocument } from "@/types/artifact/artifact"

jest.mock("@cognia/logging", () => ({
  loggers: { canvas: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } },
}))

const saveExportMock = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (opts: unknown) => saveExportMock(opts),
}))

const renderMock = jest.fn()
jest.mock("@/lib/artifacts/export", () => ({
  ...jest.requireActual("@/lib/artifacts/export"),
  renderArtifactExport: (...a: unknown[]) => renderMock(...a),
}))

function makeDoc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  const now = new Date("2026-07-07T00:00:00.000Z")
  return {
    id: "doc-1",
    sessionId: "sess-1",
    title: "My Doc",
    content: "hello world",
    language: "markdown",
    type: "text",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("extensionForLanguage", () => {
  it.each<[ArtifactLanguage, string]>([
    ["markdown", "md"],
    ["typescript", "ts"],
    ["python", "py"],
    ["html", "html"],
    ["svg", "svg"],
    ["mermaid", "mmd"],
    ["latex", "tex"],
    ["bash", "sh"],
  ])("maps %s → .%s", (language, ext) => {
    expect(extensionForLanguage(language)).toBe(ext)
  })
})

describe("getCanvasExportFormats", () => {
  it("offers raw plus pdf for a markdown document", () => {
    // A markdown document projects onto the `document` artifact type, whose
    // PDF is laid-out text rather than a picture.
    expect(getCanvasExportFormats(makeDoc())).toEqual(["raw", "pdf"])
  })

  it("offers the full rendered set for an html document", () => {
    expect(getCanvasExportFormats(makeDoc({ language: "html", type: "code" }))).toEqual([
      "raw",
      "html",
      "png",
      "pdf",
    ])
  })

  it("offers the full rendered set for an svg document", () => {
    expect(getCanvasExportFormats(makeDoc({ language: "svg", type: "code" }))).toEqual([
      "raw",
      "svg",
      "png",
      "pdf",
    ])
  })

  it("offers raw + pdf for non-previewable code", () => {
    // Code has no raster path (a screenshot of code is worse than the code),
    // but its PDF is selectable text.
    expect(getCanvasExportFormats(makeDoc({ language: "python", type: "code" }))).toEqual([
      "raw",
      "pdf",
    ])
  })
})

describe("canvasExportFilename", () => {
  it("uses the language extension for raw", () => {
    expect(canvasExportFilename(makeDoc({ language: "typescript" }), "raw")).toBe("My-Doc.ts")
  })

  it("uses html/svg extensions for those formats", () => {
    expect(canvasExportFilename(makeDoc({ language: "html", type: "code" }), "html")).toBe(
      "My-Doc.html"
    )
    expect(canvasExportFilename(makeDoc({ language: "svg", type: "code" }), "svg")).toBe(
      "My-Doc.svg"
    )
  })

  it("names a rendered export after its format, keeping a Unicode title", () => {
    expect(canvasExportFilename(makeDoc({ title: "季度 报告" }), "pdf")).toBe("季度-报告.pdf")
    expect(canvasExportFilename(makeDoc({ language: "svg", type: "code" }), "png")).toBe(
      "My-Doc.png"
    )
  })

  it("sanitizes unsafe characters and whitespace", () => {
    expect(canvasExportFilename(makeDoc({ title: "  a/b:c  *d " }), "raw")).toBe("a-b-c-d.md")
  })

  it("falls back to a default stem for an empty title", () => {
    expect(canvasExportFilename(makeDoc({ title: "   " }), "raw")).toBe("canvas-document.md")
  })
})

describe("buildCanvasExportPayload", () => {
  it("serializes filename, content, and mime", () => {
    expect(buildCanvasExportPayload(makeDoc({ language: "html", type: "code" }), "html")).toEqual({
      filename: "My-Doc.html",
      content: "hello world",
      mime: "text/html",
    })
    expect(buildCanvasExportPayload(makeDoc({ language: "svg", type: "code" }), "svg").mime).toBe(
      "image/svg+xml"
    )
    expect(buildCanvasExportPayload(makeDoc(), "raw").mime).toBe("text/plain")
  })
})

describe("canvasExportArtifact", () => {
  it("is the preview projection for a document the preview can draw", () => {
    expect(canvasExportArtifact(makeDoc({ language: "mermaid", type: "code" })).type).toBe(
      "mermaid"
    )
    expect(canvasExportArtifact(makeDoc()).type).toBe("document")
  })

  it("is a code artifact carrying the source for code with no visual form (F9)", () => {
    const artifact = canvasExportArtifact(
      makeDoc({ language: "python", type: "code", content: "def f():\n    return 1\n" })
    )
    expect(artifact).toMatchObject({
      id: "doc-1",
      type: "code",
      language: "python",
      content: "def f():\n    return 1\n",
      messageId: "canvas:doc-1",
    })
  })
})

describe("exportCanvasDocument", () => {
  beforeEach(() => {
    saveExportMock.mockReset().mockImplementation(async (opts: { filename: string }) => ({
      kind: "saved",
      platform: "web",
      location: `/tmp/${opts.filename}`,
      filename: opts.filename,
    }))
    renderMock.mockReset().mockImplementation(async (_artifact: unknown, format: string) => ({
      data: new Blob([format]),
      mimeType: format === "pdf" ? "application/pdf" : "image/png",
      filename: `ignored.${format}`,
    }))
  })

  it("hands a text format to the cross-platform saver and reports where it went", async () => {
    // The `<a download>` anchor this replaces silently no-ops inside a mobile
    // WebView, so Canvas exports vanished on Capacitor exactly as artifact
    // exports used to.
    const outcome = await exportCanvasDocument(
      makeDoc({ title: "Report", language: "markdown" }),
      "raw"
    )
    expect(outcome).toEqual({ kind: "saved", filename: "Report.md", location: "/tmp/Report.md" })
    expect(saveExportMock).toHaveBeenCalledWith({
      filename: "Report.md",
      data: "hello world",
      mimeType: "text/plain",
    })
    expect(renderMock).not.toHaveBeenCalled()
  })

  it("renders a rendered format through the shared artifact exporter, under the Canvas name", async () => {
    // A Canvas svg document and an svg artifact must produce the same image.
    const outcome = await exportCanvasDocument(
      makeDoc({ title: "Diagram", language: "svg", type: "code" }),
      "png"
    )
    expect(renderMock).toHaveBeenCalledWith(expect.objectContaining({ type: "svg" }), "png")
    expect(saveExportMock).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "Diagram.png", mimeType: "image/png" })
    )
    expect(outcome).toMatchObject({ kind: "saved", filename: "Diagram.png" })
  })

  it("exports a code document's PDF as its source laid out as text (F9)", async () => {
    // The menu offered PDF for Python and the exporter then refused it because
    // the document had no preview projection.
    const doc = makeDoc({ title: "calc", language: "python", type: "code", content: "x = 1" })
    expect(getCanvasExportFormats(doc)).toContain("pdf")

    const outcome = await exportCanvasDocument(doc, "pdf")

    expect(renderMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "code", language: "python", content: "x = 1" }),
      "pdf"
    )
    expect(outcome).toMatchObject({ kind: "saved", filename: "calc.pdf" })
  })

  it.each<[ArtifactLanguage, "text" | "code"]>([
    ["markdown", "text"],
    ["plaintext", "text"],
    ["python", "code"],
    ["json", "code"],
    ["css", "code"],
    ["html", "code"],
    ["svg", "code"],
    ["jsx", "code"],
    ["mermaid", "code"],
    ["latex", "code"],
  ])("carries out every format it offers for a %s document", async (language, type) => {
    const doc = makeDoc({ language, type })
    for (const format of getCanvasExportFormats(doc)) {
      expect((await exportCanvasDocument(doc, format)).kind).toBe("saved")
    }
  })

  it("refuses a format the document does not offer, without saving anything", async () => {
    // `html` is not offered for a markdown document, so it must not run either.
    expect(await exportCanvasDocument(makeDoc(), "html")).toEqual({
      kind: "unsupported",
      format: "html",
    })
    expect(await exportCanvasDocument(makeDoc(), "unknown" as never)).toMatchObject({
      kind: "unsupported",
    })
    expect(saveExportMock).not.toHaveBeenCalled()
  })

  it("reports a dismissed save dialog as cancelled", async () => {
    saveExportMock.mockResolvedValue({ kind: "cancelled" })
    expect(await exportCanvasDocument(makeDoc(), "raw")).toEqual({ kind: "cancelled" })
  })

  it("reports a failed write as a save error, whether returned or thrown (F10)", async () => {
    saveExportMock.mockResolvedValueOnce({ kind: "error", message: "EACCES" })
    expect(await exportCanvasDocument(makeDoc(), "raw")).toEqual({
      kind: "save-error",
      filename: "My-Doc.md",
      message: "EACCES",
    })

    saveExportMock.mockRejectedValueOnce(new Error("plugin missing"))
    expect(await exportCanvasDocument(makeDoc(), "pdf")).toEqual({
      kind: "save-error",
      filename: "My-Doc.pdf",
      message: "plugin missing",
    })
  })

  it("reports a render failure with its cause and never reaches the saver (F10)", async () => {
    renderMock.mockRejectedValueOnce(new PdfUnsupportedCharactersError(["😀"]))
    expect(await exportCanvasDocument(makeDoc(), "pdf")).toEqual({
      kind: "render-error",
      failure: { reason: "unsupported-characters", characters: "😀" },
    })

    // A capture of the mounted preview points the user at the preview…
    renderMock.mockRejectedValueOnce(new Error("no preview"))
    expect(
      await exportCanvasDocument(makeDoc({ language: "mermaid", type: "code" }), "png")
    ).toEqual({ kind: "render-error", failure: { reason: "preview" } })

    // …while a text-layout PDF never needed one.
    renderMock.mockRejectedValueOnce(new Error("jsPDF failed"))
    expect(
      await exportCanvasDocument(makeDoc({ language: "python", type: "code" }), "pdf")
    ).toEqual({ kind: "render-error", failure: { reason: "failed" } })

    expect(saveExportMock).not.toHaveBeenCalled()
  })
})

describe("copyCanvasDocumentToClipboard", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard")

  afterEach(() => {
    if (original) Object.defineProperty(globalThis.navigator, "clipboard", original)
    else delete (globalThis.navigator as unknown as { clipboard?: unknown }).clipboard
  })

  it("writes the buffer to the clipboard and returns true", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    await expect(copyCanvasDocumentToClipboard(makeDoc({ content: "abc" }))).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("abc")
  })

  it("returns false when the clipboard API is missing", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    })
    await expect(copyCanvasDocumentToClipboard(makeDoc())).resolves.toBe(false)
  })

  it("returns false when writeText rejects", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"))
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    await expect(copyCanvasDocumentToClipboard(makeDoc())).resolves.toBe(false)
  })
})
