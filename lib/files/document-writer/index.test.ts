/**
 * @jest-environment jsdom
 */
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

const textMock = jest.fn()
const addPageMock = jest.fn()
const addImageMock = jest.fn()
let pageHeight = 800
const jsPDFMock = jest.fn()
jest.mock("jspdf", () => ({
  jsPDF: class {
    constructor(opts: unknown) {
      const real = jsPDFMock(opts)
      if (real) return real
    }
    internal = { pageSize: { getHeight: () => pageHeight, getWidth: () => 600 } }
    setFontSize = jest.fn()
    setFont = jest.fn()
    // Courier at 10pt is 6pt per character; 504pt of body is 84 columns.
    getTextWidth = () => 6
    splitTextToSize = (t: string) => t.split("\n")
    getImageProperties = () => ({ width: 2000, height: 4000 })
    text = textMock
    addPage = addPageMock
    addImage = addImageMock
    output = jest.fn(() => new Blob(["pdf"], { type: "application/pdf" }))
  },
}))

import { Paragraph, TextRun } from "docx"

import { generateDocx, generatePdf } from "./index"
import { parseMarkdownBlocks } from "./blocks"
import { PdfUnsupportedCharactersError } from "./pdf-text"

beforeEach(() => {
  jest.clearAllMocks()
  pageHeight = 800
})

async function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

const drawn = () => textMock.mock.calls.map(([line]) => line as string)

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
    expect(drawn()).toEqual(["# comment", "def f():", "    return 1", "", "    pass"])
  })

  it("cuts an over-long code line at the column width without dropping spaces", async () => {
    const line = `    ${"x".repeat(100)}`
    await generatePdf({ title: "Code", blocks: [{ kind: "code", text: line }] })
    expect(drawn()).toEqual([line.slice(0, 84), line.slice(84)])
  })

  it("rewrites typographic punctuation, its bullet included", async () => {
    await generatePdf({
      title: "Prose",
      blocks: parseMarkdownBlocks("“Quoted” — fine…\n\n- item"),
    })
    expect(drawn()).toEqual(['"Quoted" -- fine...', "· item"])
  })

  it("refuses text its fonts cannot draw before laying out a page (C09)", async () => {
    await expect(
      generatePdf({ title: "中文", blocks: parseMarkdownBlocks("# 标题\n\n正文") })
    ).rejects.toBeInstanceOf(PdfUnsupportedCharactersError)
    expect(jsPDFMock).not.toHaveBeenCalled()
    expect(textMock).not.toHaveBeenCalled()
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
    const pdf = await readBlobText(out.data)
    expect(pdf).toMatch(/^%PDF-/)
    expect(pdf).toContain("(Analysis)")
    expect(pdf).toContain("(# comment)")
    expect(pdf).toContain("(    indented\\(\\))")
    expect(pdf).toContain("/Subtype /Image")
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
