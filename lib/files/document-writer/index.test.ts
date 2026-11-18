/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { inflateSync } from "node:zlib"

jest.mock("docx", () => {
  const actual = jest.requireActual<typeof import("docx")>("docx")
  return {
    ...actual,
    Packer: {
      toBlob: jest.fn(async () => new Blob(["docx"], { type: "application/octet-stream" })),
    },
    Paragraph: jest.fn(),
    TextRun: jest.fn(),
    Document: jest.fn(),
  }
})

jest.mock("./unicode-font", () => ({
  ...jest.requireActual<typeof import("./unicode-font")>("./unicode-font"),
  loadPdfUnicodeFont: jest.fn(),
}))

/** Each call: text, x, y, options, and the font family selected when it was drawn. */
const textMock = jest.fn()
const setFontMock = jest.fn()
const setLineWidthMock = jest.fn()
const addFileToVFSMock = jest.fn()
const addFontMock = jest.fn()
const addPageMock = jest.fn()
const addImageMock = jest.fn()
let pageHeight = 800
/** The mocked bundled font's character map: code point to glyph id. */
let codeMap: Record<number, number> = {}
const jsPDFMock = jest.fn()
jest.mock("jspdf", () => ({
  jsPDF: class {
    family = "helvetica"
    constructor(opts: unknown) {
      const real = jsPDFMock(opts)
      if (real) return real
    }
    internal = { pageSize: { getHeight: () => pageHeight, getWidth: () => 600 } }
    setFontSize = jest.fn()
    setFont = (family: string, style?: string) => {
      setFontMock(family, style)
      this.family = family
    }
    // Every glyph is 6pt here; 504pt of body is 84 of them.
    getTextWidth = (text: string) => 6 * Array.from(text).length
    getFont = () => ({ metadata: { cmap: { unicode: { codeMap } } } })
    getImageProperties = () => ({ width: 2000, height: 4000 })
    text = (text: string, x: number, y: number, options?: unknown) =>
      textMock(text, x, y, options, this.family)
    setLineWidth = setLineWidthMock
    addFileToVFS = addFileToVFSMock
    addFont = addFontMock
    addPage = addPageMock
    addImage = addImageMock
    output = jest.fn(() => new Blob(["pdf"], { type: "application/pdf" }))
  },
}))

import { Paragraph, TextRun } from "docx"

import { generateDocx, generatePdf } from "./index"
import { parseMarkdownBlocks } from "./blocks"
import { PdfUnsupportedCharactersError } from "./pdf-text"
import {
  loadPdfUnicodeFont,
  PDF_UNICODE_FONT,
  PdfFontUnavailableError,
  toBinaryString,
} from "./unicode-font"

const loadFont = jest.mocked(loadPdfUnicodeFont)

/** Let the mocked bundled font cover `chars`. */
function covering(chars: string) {
  codeMap = Object.fromEntries(Array.from(chars, (char, i) => [char.codePointAt(0)!, i + 1]))
}

beforeEach(() => {
  jest.clearAllMocks()
  pageHeight = 800
  codeMap = {}
  loadFont.mockResolvedValue("\x00\x01\x00\x00font")
})

async function readBlobBinary(blob: Blob): Promise<string> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
  return Buffer.from(buffer).toString("latin1")
}

/** The PDF's Flate streams, inflated (`compress: true` deflates them all). */
function inflatedStreams(pdf: string): string[] {
  return Array.from(pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g), ([, body]) => {
    try {
      return inflateSync(Buffer.from(body, "latin1")).toString("latin1")
    } catch {
      return body
    }
  })
}

/** The shipped font, as the loader hands it to jsPDF. */
const realFont = () =>
  toBinaryString(readFileSync(join(process.cwd(), "public", PDF_UNICODE_FONT.path)))

const drawn = () => textMock.mock.calls.map(([line]) => line as string)
const drawnAt = () =>
  textMock.mock.calls.map(([line, x, y, , family]) => [line, x, y, family] as const)

describe("generateDocx", () => {
  it("names the file from the title and carries the Word mime type", async () => {
    const out = await generateDocx({ title: "My/Report:1", blocks: [] })
    expect(out.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    expect(out.filename).toBe("My Report 1.docx")
    expect((await generateDocx({ title: "  ", blocks: [] })).filename).toBe("document.docx")
  })

  it("writes code one run per line, joined by line breaks (A07)", async () => {
    await generateDocx({
      title: "Code",
      blocks: [{ kind: "code", text: "# keep me\ndef f():\n\treturn 1" }],
    })
    // A "\n" inside one run is a space in Word: the block used to collapse.
    expect(jest.mocked(TextRun).mock.calls.map(([options]) => options)).toEqual([
      { text: "# keep me", font: "Courier New" },
      { text: "def f():", font: "Courier New", break: 1 },
      { text: "    return 1", font: "Courier New", break: 1 },
    ])
    expect(Paragraph).toHaveBeenCalledTimes(1)
  })

  it("writes a real Word file whose code keeps its lines and indentation", async () => {
    const actual = jest.requireActual<typeof import("docx")>("docx")
    jest.mocked(Paragraph).mockImplementation(((o: never) => new actual.Paragraph(o)) as never)
    jest.mocked(TextRun).mockImplementation(((o: never) => new actual.TextRun(o)) as never)
    const { Document, Packer } = jest.requireMock<typeof import("docx")>("docx")
    jest.mocked(Document).mockImplementation(((o: never) => new actual.Document(o)) as never)
    let xml = ""
    jest.mocked(Packer.toBlob).mockImplementationOnce(async (doc) => {
      const { default: JSZip } = await import("jszip")
      const zip = await JSZip.loadAsync(await actual.Packer.toBuffer(doc))
      xml = await zip.file("word/document.xml")!.async("string")
      return new Blob(["docx"])
    })

    await generateDocx({ title: "Code", blocks: [{ kind: "code", text: "if x:\n    y()" }] })

    expect(xml).toContain('<w:t xml:space="preserve">if x:</w:t>')
    expect(xml).toContain('<w:br/><w:t xml:space="preserve">    y()</w:t>')
  })
})

describe("generatePdf", () => {
  it("names the file from the title and carries the PDF mime type", async () => {
    const out = await generatePdf({ title: "Doc", blocks: [] })
    expect(out.mimeType).toBe("application/pdf")
    expect(out.filename).toBe("Doc.pdf")
  })

  it("draws code verbatim: comments stay comments, indentation stays (A07)", async () => {
    await generatePdf({
      title: "Code",
      blocks: [{ kind: "code", text: "# comment\ndef f():\n    return 1\n\n\tpass" }],
    })
    // The blank line is a row with nothing drawn on it.
    expect(drawnAt()).toEqual([
      ["# comment", 48, 48, "courier"],
      ["def f():", 48, 60, "courier"],
      ["    return 1", 48, 72, "courier"],
      ["    pass", 48, 96, "courier"],
    ])
  })

  it("cuts an over-long code line at the column width without dropping spaces", async () => {
    const line = `    ${"x".repeat(100)}`
    await generatePdf({ title: "Code", blocks: [{ kind: "code", text: line }] })
    expect(drawn()).toEqual([line.slice(0, 84), line.slice(84)])
  })

  it("keeps English on the built-in fonts, rewriting typographic punctuation", async () => {
    await generatePdf({
      title: "Prose",
      blocks: parseMarkdownBlocks("“Quoted” — fine…\n\n- item"),
    })
    expect(drawn()).toEqual(['"Quoted" -- fine...', "· item"])
    // No 10 MB font for text the built-in ones draw.
    expect(loadFont).not.toHaveBeenCalled()
    expect(addFileToVFSMock).not.toHaveBeenCalled()
  })

  it("draws Chinese in the bundled font and Latin in Helvetica (C09)", async () => {
    covering("中文")
    await generatePdf({ title: "Mixed", blocks: [{ kind: "paragraph", text: "Hello 中文" }] })
    expect(loadFont).toHaveBeenCalledTimes(1)
    expect(addFileToVFSMock).toHaveBeenCalledWith("NotoSansSC-Regular.ttf", "\x00\x01\x00\x00font")
    expect(addFontMock).toHaveBeenCalledWith(
      "NotoSansSC-Regular.ttf",
      "NotoSansSC",
      "normal",
      "normal",
      "Identity-H"
    )
    expect(drawnAt()).toEqual([
      ["Hello ", 48, 48, "helvetica"],
      ["中文", 84, 48, "NotoSansSC"],
    ])
  })

  it("wraps Chinese prose between characters", async () => {
    covering("中")
    await generatePdf({ title: "Long", blocks: [{ kind: "paragraph", text: "中".repeat(100) }] })
    expect(drawn().map((line) => line.length)).toEqual([84, 16])
  })

  it("draws a bold heading's Chinese as fill plus stroke, the font having no bold", async () => {
    covering("标题")
    await generatePdf({ title: "H", blocks: [{ kind: "heading", level: 1, text: "Title 标题" }] })
    expect(setFontMock).toHaveBeenCalledWith("helvetica", "bold")
    expect(textMock).toHaveBeenCalledWith("Title ", 48, 48, undefined, "helvetica")
    expect(textMock).toHaveBeenCalledWith(
      "标题",
      84,
      48,
      { renderingMode: "fillThenStroke" },
      "NotoSansSC"
    )
    expect(setLineWidthMock).toHaveBeenCalledWith(20 * 0.03)
  })

  it("keeps code on its monospace grid when a comment is Chinese", async () => {
    covering("注释")
    await generatePdf({ title: "Code", blocks: [{ kind: "code", text: "# 注释\nx = 1" }] })
    // Each Chinese glyph takes two 6pt cells and is centred in them.
    expect(drawnAt()).toEqual([
      ["# ", 48, 48, "courier"],
      ["注", 63, 48, "NotoSansSC"],
      ["释", 75, 48, "NotoSansSC"],
      ["x = 1", 48, 60, "courier"],
    ])
  })

  it("refuses an emoji without fetching the bundled font, before drawing anything", async () => {
    await expect(
      generatePdf({ title: "Emoji", blocks: [{ kind: "paragraph", text: "ok \u{1f600}" }] })
    ).rejects.toEqual(new PdfUnsupportedCharactersError(["\u{1f600}"]))
    expect(loadFont).not.toHaveBeenCalled()
    expect(textMock).not.toHaveBeenCalled()
  })

  it("names the characters the bundled font lacks, before drawing anything (C09)", async () => {
    covering("中文")
    const error = await generatePdf({
      title: "中文",
      blocks: parseMarkdownBlocks("# 中文\n\n한국어 \u{1f600}"),
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PdfUnsupportedCharactersError)
    expect((error as PdfUnsupportedCharactersError).characters).toEqual([
      "한",
      "국",
      "어",
      "\u{1f600}",
    ])
    expect(textMock).not.toHaveBeenCalled()
    expect(addPageMock).not.toHaveBeenCalled()
  })

  it("reports a bundled font it cannot load", async () => {
    loadFont.mockRejectedValueOnce(new PdfFontUnavailableError(new Error("HTTP 404")))
    await expect(
      generatePdf({ title: "中文", blocks: [{ kind: "paragraph", text: "正文" }] })
    ).rejects.toBeInstanceOf(PdfFontUnavailableError)
    expect(jsPDFMock).not.toHaveBeenCalled()
  })

  it("fits a figure inside the margins, on a new page when it does not fit", async () => {
    await generatePdf({
      title: "Fig",
      blocks: [
        { kind: "paragraph", text: "before" },
        { kind: "image", dataUrl: "data:image/png;base64,cG5n", format: "PNG" },
      ],
    })
    expect(addPageMock).toHaveBeenCalledTimes(1)
    const [dataUrl, format, x, y, width, height] = addImageMock.mock.calls[0]
    expect([dataUrl, format, x, y]).toEqual(["data:image/png;base64,cG5n", "PNG", 48, 48])
    expect(height).toBeLessThanOrEqual(800 - 96)
    expect(width / height).toBeCloseTo(0.5)
  })

  it("paginates text that overflows the page", async () => {
    pageHeight = 80
    await generatePdf({
      title: "Long",
      blocks: [
        { kind: "code", text: Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") },
      ],
    })
    expect(addPageMock).toHaveBeenCalled()
    expect(drawn().at(-1)).toBe("line 9")
  })

  it("produces a real PDF with indented code, selectable text and an embedded PNG", async () => {
    const { jsPDF } = jest.requireActual<typeof import("jspdf")>("jspdf")
    jsPDFMock.mockImplementationOnce((options) => new jsPDF(options))
    const out = await generatePdf({
      title: "Real",
      blocks: [
        { kind: "heading", level: 1, text: "Analysis" },
        { kind: "code", text: "# comment\n    indented()" },
        {
          kind: "image",
          dataUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          format: "PNG",
        },
      ],
    })
    const pdf = await readBlobBinary(out.data)
    const content = inflatedStreams(pdf).join("\n")
    expect(pdf).toMatch(/^%PDF-/)
    expect(content).toContain("(Analysis)")
    expect(content).toContain("(# comment)")
    expect(content).toContain("(    indented\\(\\))")
    expect(pdf).toContain("/Subtype /Image")
    expect(loadFont).not.toHaveBeenCalled()
  })

  it("embeds a subset of the shipped font, so Chinese text is selectable (C09)", async () => {
    const { jsPDF } = jest.requireActual<typeof import("jspdf")>("jspdf")
    jsPDFMock.mockImplementationOnce((options) => new jsPDF(options))
    loadFont.mockResolvedValueOnce(realFont())
    const out = await generatePdf({
      title: "中文",
      blocks: parseMarkdownBlocks("# 标题\n\n正文“引号”，Latin 混排。\n\n```\n# 注释\n```"),
    })
    const pdf = await readBlobBinary(out.data)
    const toUnicode = inflatedStreams(pdf).find((stream) => stream.includes("beginbfchar")) ?? ""
    expect(pdf).toContain("/Subtype /Type0")
    expect(pdf).toContain("/Encoding /Identity-H")
    expect(pdf).toContain("/FontFile2")
    // Text extraction maps each glyph back to its character.
    for (const char of "标题正文引号注释“，。") {
      const hex = char.codePointAt(0)!.toString(16).padStart(4, "0")
      expect(toUnicode).toContain(`<${hex}>`)
    }
    // A subset of the glyphs used, not the 10 MB font.
    expect(out.data.size).toBeLessThan(200_000)
  })

  it("rejects a figure jsPDF cannot read instead of leaving it out", async () => {
    const { jsPDF } = jest.requireActual<typeof import("jspdf")>("jspdf")
    jsPDFMock.mockImplementationOnce((options) => new jsPDF(options))
    await expect(
      generatePdf({
        title: "Broken",
        blocks: [{ kind: "image", dataUrl: "data:image/png;base64,broken", format: "PNG" }],
      })
    ).rejects.toThrow()
  })
})
