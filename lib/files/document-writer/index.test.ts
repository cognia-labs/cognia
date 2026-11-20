/**
 * @jest-environment jsdom
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import JSZip from "jszip"

jest.mock("./unicode-font", () => ({
  ...jest.requireActual<typeof import("./unicode-font")>("./unicode-font"),
  loadPdfUnicodeFont: jest.fn(),
}))

/** Each call: text, x, y, options, and the font family and style selected when it was drawn. */
const textMock = jest.fn()
const setFontMock = jest.fn()
const setLineWidthMock = jest.fn()
const setTextColorMock = jest.fn()
const setPropertiesMock = jest.fn()
const lineMock = jest.fn()
const rectMock = jest.fn()
const linkMock = jest.fn()
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
    style = "normal"
    constructor(opts: unknown) {
      const real = jsPDFMock(opts)
      if (real) return real
    }
    internal = { pageSize: { getHeight: () => pageHeight, getWidth: () => 600 } }
    setFontSize = jest.fn()
    setFont = (family: string, style?: string) => {
      setFontMock(family, style)
      this.family = family
      this.style = style ?? "normal"
    }
    // Every glyph is 6pt here; 504pt of body is 84 of them.
    getTextWidth = (text: string) => 6 * Array.from(text).length
    getFont = () => ({ metadata: { cmap: { unicode: { codeMap } } } })
    getImageProperties = () => ({ width: 2000, height: 4000 })
    text = (text: string, x: number, y: number, options?: unknown) =>
      textMock(text, x, y, options, this.family, this.style)
    setLineWidth = setLineWidthMock
    setTextColor = setTextColorMock
    setDrawColor = jest.fn()
    setFillColor = jest.fn()
    setProperties = setPropertiesMock
    line = lineMock
    rect = rectMock
    link = linkMock
    Matrix = (...values: number[]) => ({ matrix: values })
    addFileToVFS = addFileToVFSMock
    addFont = addFontMock
    addPage = addPageMock
    addImage = addImageMock
    output = jest.fn(() => new Blob(["pdf"], { type: "application/pdf" }))
  },
}))

import { generateDocx, generatePdf } from "./index"
import { parseMarkdownBlocks, type DocBlock } from "./blocks"
import { PdfUnsupportedCharactersError } from "./pdf-text"
import {
  loadPdfUnicodeFont,
  PDF_UNICODE_FONT,
  PdfFontUnavailableError,
  toBinaryString,
} from "./unicode-font"

const loadFont = jest.mocked(loadPdfUnicodeFont)

/** A 1×1 PNG. */
const PNG_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

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

async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

async function readBlobBinary(blob: Blob): Promise<string> {
  return Buffer.from(await readBlobBuffer(blob)).toString("latin1")
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
const drawnStyled = () =>
  textMock.mock.calls.map(([line, , , , family, style]) => [line, `${family}:${style}`] as const)

/** The Word file's parts, written by the real `docx` library. */
async function docxParts(blocks: readonly DocBlock[], title = "Doc") {
  const out = await generateDocx({ title, blocks })
  const zip = await JSZip.loadAsync(await readBlobBuffer(out.data))
  const read = async (path: string) => (await zip.file(path)?.async("string")) ?? ""
  return {
    out,
    document: await read("word/document.xml"),
    numbering: await read("word/numbering.xml"),
    relationships: await read("word/_rels/document.xml.rels"),
    styles: await read("word/styles.xml"),
    core: await read("docProps/core.xml"),
    files: Object.keys(zip.files),
  }
}

describe("generateDocx", () => {
  it("carries its title in the document properties", async () => {
    const { core, out } = await docxParts([], "Quarterly Report")
    expect(core).toContain("<dc:title>Quarterly Report</dc:title>")
    expect(out.losses).toEqual([])
  })

  it("writes code one run per line, joined by line breaks, keeping indentation (A07)", async () => {
    const { document } = await docxParts([
      { kind: "code", text: "# keep me\ndef f():\n\treturn 1" },
    ])
    // A "\n" inside one run is a space in Word: the block used to collapse.
    expect(document).toContain('<w:t xml:space="preserve"># keep me</w:t>')
    expect(document).toContain('<w:br/><w:t xml:space="preserve">def f():</w:t>')
    expect(document).toContain('<w:br/><w:t xml:space="preserve">    return 1</w:t>')
    expect(document).toContain('w:ascii="Courier New"')
  })

  it("writes bold, italic, strikethrough, code and links as native runs (F11)", async () => {
    const { document, relationships, styles } = await docxParts(
      parseMarkdownBlocks("**b** *i* ~~s~~ `c` [site](https://example.com/a?b=1)")
    )
    expect(document).toMatch(
      /<w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">b<\/w:t>/
    )
    expect(document).toMatch(/<w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">i<\/w:t>/)
    expect(document).toMatch(/<w:strike\/><\/w:rPr><w:t xml:space="preserve">s<\/w:t>/)
    expect(document).toMatch(/w:ascii="Courier New"[^]*?<w:t xml:space="preserve">c<\/w:t>/)
    const link =
      /<w:hyperlink [^>]*r:id="([^"]+)"[^>]*><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">site<\/w:t>/.exec(
        document
      )
    expect(link).not.toBeNull()
    expect(relationships).toContain(
      `Id="${link![1]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1" TargetMode="External"`
    )
    // The character style the link runs name is defined, so Word draws them as links.
    expect(styles).toContain('w:styleId="Hyperlink"')
    // No Markdown markers left in the text.
    expect(document).not.toMatch(/<w:t[^>]*>[^<]*(\*\*|~~|`|\]\()/)
  })

  it("writes a table as a native table with a repeating header row (F11)", async () => {
    const { document } = await docxParts(
      parseMarkdownBlocks(
        "| Name | Qty | Note |\n|:-|-:|:-:|\n| Apple | **3** | ok |\n| Pear | 12 | |"
      )
    )
    expect(document.match(/<w:tbl>/g)).toHaveLength(1)
    expect(document.match(/<w:gridCol /g)).toHaveLength(3)
    expect(document.match(/<w:tr>/g)).toHaveLength(3)
    expect(document).toMatch(/<w:trPr><w:tblHeader\/><\/w:trPr>/)
    expect(document).toContain('w:fill="F2F2F2"')
    expect(document).toContain('<w:jc w:val="right"/>')
    expect(document).toContain('<w:jc w:val="center"/>')
    for (const cell of ["Name", "Qty", "Note", "Apple", "3", "Pear", "12"]) {
      expect(document).toContain(`>${cell}</w:t>`)
    }
    // The pipes used to land in one paragraph per row.
    expect(document).not.toContain("|")
  })

  it("keeps two tables apart and ends the body with a paragraph", async () => {
    const table: DocBlock = { kind: "table", align: [null], header: [[{ text: "h" }]], rows: [] }
    const { document } = await docxParts([table, table])
    expect(document).toMatch(/<\/w:tbl><w:p\/><w:tbl>[^]*<\/w:tbl><w:p\/><w:sectPr>/)
  })

  it("numbers each list from its own start, nesting a level deeper (F11)", async () => {
    const { document, numbering } = await docxParts(
      parseMarkdownBlocks("3. three\n4. four\n   - nested\n\nbreak\n\n1. again\n2. more")
    )
    const numIds = [...document.matchAll(/<w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/>/g)].map(
      ([, level, id]) => [Number(level), Number(id)]
    )
    expect(numIds).toHaveLength(5)
    const [three, four, nested, again, more] = numIds
    expect(three[1]).toBe(four[1])
    expect(nested[0]).toBe(1)
    expect(nested[1]).not.toBe(three[1])
    expect(again[1]).toBe(more[1])
    expect(again[1]).not.toBe(three[1])
    expect(numbering).toContain('<w:start w:val="3"/>')
    expect(numbering).toContain('<w:numFmt w:val="decimal"/>')
    expect(numbering).toContain('<w:numFmt w:val="bullet"/>')
  })

  it("writes a task item's box in place of its bullet", async () => {
    const { document } = await docxParts(parseMarkdownBlocks("- [x] done\n- [ ] open"))
    expect(document).toContain('<w:t xml:space="preserve">☒</w:t><w:tab/>')
    expect(document).toContain('<w:t xml:space="preserve">☐</w:t><w:tab/>')
    expect(document).not.toContain("<w:numPr>")
    expect(document).toContain('<w:tab w:val="left" w:pos="720"/>')
  })

  it("embeds a data image as a picture with its alt text (F11)", async () => {
    const { document, files, out } = await docxParts(parseMarkdownBlocks(`![plot](${PNG_URL})`))
    expect(document).toContain("<w:drawing>")
    expect(document).toContain('descr="plot"')
    // One pixel is 9525 EMUs.
    expect(document).toContain('cx="9525" cy="9525"')
    expect(files.some((path) => /^word\/media\/.+\.png$/.test(path))).toBe(true)
    expect(out.losses).toEqual([])
  })

  it("indents quotes behind a left rule, headings to level six, and draws a thematic break", async () => {
    const { document } = await docxParts(parseMarkdownBlocks("> quoted\n\n#### Four\n\n---"))
    expect(document).toMatch(/<w:pBdr><w:left w:val="single"[^>]*\/><\/w:pBdr>[^]*?quoted/)
    expect(document).toMatch(/<w:ind w:left="480"\/>[^]*?quoted/)
    expect(document).toContain('<w:pStyle w:val="Heading4"/>')
    expect(document).toMatch(/<w:pBdr><w:bottom w:val="single"/)
  })

  it("reports the images it wrote as text and the raw HTML", async () => {
    const { document, out } = await docxParts(
      parseMarkdownBlocks("![chart](https://x.y/c.png) <sup>2</sup>")
    )
    expect(document).toContain(">chart (https://x.y/c.png)</w:t>")
    expect(document).toContain("&lt;sup&gt;")
    expect(out.losses).toEqual([
      { kind: "image", count: 1 },
      { kind: "html", count: 2 },
    ])
  })

  it("rejects an image block it cannot read rather than leaving it out", async () => {
    await expect(
      generateDocx({
        title: "Broken",
        blocks: [{ kind: "image", dataUrl: "data:image/png;base64,broken", format: "PNG" }],
      })
    ).rejects.toThrow("readable PNG or JPEG")
  })
})

describe("generatePdf", () => {
  it("carries its title in the document properties", async () => {
    const out = await generatePdf({ title: "Doc", blocks: [] })
    expect(setPropertiesMock).toHaveBeenCalledWith({ title: "Doc" })
    expect(out.losses).toEqual([])
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
    expect(drawn()).toEqual(['"Quoted" -- fine...', "·", "item"])
    // No 10 MB font for text the built-in ones draw.
    expect(loadFont).not.toHaveBeenCalled()
    expect(addFileToVFSMock).not.toHaveBeenCalled()
  })

  it("draws each run in its own font: bold, italic, both, and code (F11)", async () => {
    await generatePdf({ title: "Runs", blocks: parseMarkdownBlocks("a **b** *c* ***d*** `e`") })
    expect(drawnStyled()).toEqual([
      ["a ", "helvetica:normal"],
      ["b", "helvetica:bold"],
      [" ", "helvetica:normal"],
      ["c", "helvetica:italic"],
      [" ", "helvetica:normal"],
      ["d", "helvetica:bolditalic"],
      [" ", "helvetica:normal"],
      ["e", "courier:normal"],
    ])
    expect(drawnAt().map(([, x]) => x)).toEqual([48, 60, 66, 72, 78, 84, 90, 96])
  })

  it("draws a link in link colour, underlined, with a link annotation over it (F11)", async () => {
    await generatePdf({
      title: "Link",
      blocks: parseMarkdownBlocks("go [here](https://e.com) now"),
    })
    expect(drawnAt()).toEqual([
      ["go ", 48, 48, "helvetica"],
      ["here", 66, 48, "helvetica"],
      [" now", 90, 48, "helvetica"],
    ])
    expect(setTextColorMock.mock.calls[1]).toEqual([5, 99, 193])
    expect(linkMock).toHaveBeenCalledWith(66, 48 - 11 * 0.85, 24, 11 * 1.1, {
      url: "https://e.com",
    })
    expect(lineMock).toHaveBeenCalledWith(66, 48 + 11 * 0.12, 90, 48 + 11 * 0.12)
  })

  it("strikes struck text through", async () => {
    await generatePdf({ title: "Del", blocks: parseMarkdownBlocks("~~gone~~") })
    expect(lineMock).toHaveBeenCalledWith(48, 48 - 11 * 0.3, 72, 48 - 11 * 0.3)
  })

  it("slants italic text the bundled font draws, as it has no italic face", async () => {
    covering("斜体")
    await generatePdf({ title: "I", blocks: parseMarkdownBlocks("*斜体*") })
    const [[text, x, y, options, family]] = textMock.mock.calls
    const shear = Math.tan((12 * Math.PI) / 180)
    expect([text, y, family]).toEqual(["斜体", 48, "NotoSansSC"])
    expect(options).toEqual({ angle: { matrix: [1, 0, shear, 1, 0, 0] } })
    // jsPDF applies the position inside the slant; the start compensates.
    expect(x + shear * (pageHeight - 48)).toBeCloseTo(48)
  })

  it("draws Chinese in the bundled font and Latin in Helvetica (C09)", async () => {
    covering("中文")
    await generatePdf({ title: "Mixed", blocks: parseMarkdownBlocks("Hello 中文") })
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
    await generatePdf({ title: "Long", blocks: parseMarkdownBlocks("中".repeat(100)) })
    expect(drawn().map((line) => line.length)).toEqual([84, 16])
  })

  it("draws a bold heading's Chinese as fill plus stroke, the font having no bold", async () => {
    covering("标题")
    await generatePdf({ title: "H", blocks: parseMarkdownBlocks("# Title 标题") })
    expect(setFontMock).toHaveBeenCalledWith("helvetica", "bold")
    expect(textMock).toHaveBeenCalledWith("Title ", 48, 48, undefined, "helvetica", "bold")
    expect(textMock).toHaveBeenCalledWith(
      "标题",
      84,
      48,
      { renderingMode: "fillThenStroke" },
      "NotoSansSC",
      "normal"
    )
    expect(setLineWidthMock).toHaveBeenCalledWith(20 * 0.03)
  })

  it("hangs list markers in a gutter, nested lists one step in, numbers right-aligned", async () => {
    await generatePdf({
      title: "List",
      blocks: parseMarkdownBlocks("- a\n  - b\n\n9. nine\n10. ten"),
    })
    expect(drawnAt()).toEqual([
      ["·", 52, 48, "helvetica"],
      ["a", 66, 48, "helvetica"],
      ["·", 70, 63, "helvetica"],
      ["b", 84, 63, "helvetica"],
      // Right-aligned against the text, 4pt before it.
      ["9.", 50, 78, "helvetica"],
      ["nine", 66, 78, "helvetica"],
      ["10.", 44, 93, "helvetica"],
      ["ten", 66, 93, "helvetica"],
    ])
  })

  it("draws a task item's box, ticked when done", async () => {
    await generatePdf({ title: "Tasks", blocks: parseMarkdownBlocks("- [x] done\n- [ ] open") })
    const box = 11 * 0.7
    expect(rectMock.mock.calls).toEqual([
      [51, 48 - box, box, box],
      [51, 63 - box, box, box],
    ])
    // The tick is two strokes, on the first box only.
    expect(lineMock).toHaveBeenCalledTimes(2)
    expect(drawn()).toEqual(["done", "open"])
  })

  it("indents a quote behind a bar, and puts an item's code in its content column", async () => {
    await generatePdf({
      title: "Quote",
      blocks: parseMarkdownBlocks("> said\n\n- item\n\n  ```\n  x = 1\n  ```"),
    })
    expect(drawnAt()).toEqual([
      ["said", 62, 48, "helvetica"],
      ["·", 52, 67, "helvetica"],
      ["item", 66, 67, "helvetica"],
      ["x = 1", 66, 82, "courier"],
    ])
    expect(lineMock).toHaveBeenCalledWith(51, 48 - 11, 51, 48 + 2)
  })

  it("draws a table as a ruled grid with a shaded header and aligned cells (F11)", async () => {
    await generatePdf({
      title: "Table",
      blocks: parseMarkdownBlocks("| Name | Qty |\n|:-|-:|\n| Apple | 3 |"),
    })
    // Natural widths: "Apple" 30 + 8 padding; "Qty" 18 + 8.
    const fills = rectMock.mock.calls.filter((call) => call[4] === "F")
    const borders = rectMock.mock.calls.filter((call) => call[4] === undefined)
    expect(fills).toEqual([
      [48, 37, 38, 21, "F"],
      [86, 37, 26, 21, "F"],
    ])
    expect(borders).toEqual([
      [48, 37, 38, 21],
      [86, 37, 26, 21],
      [48, 58, 38, 21],
      [86, 58, 26, 21],
    ])
    expect(drawnStyled()).toEqual([
      ["Name", "helvetica:bold"],
      ["Qty", "helvetica:bold"],
      ["Apple", "helvetica:normal"],
      ["3", "helvetica:normal"],
    ])
    expect(drawnAt().map(([text, x, y]) => [text, x, y])).toEqual([
      ["Name", 52, 52],
      ["Qty", 90, 52],
      ["Apple", 52, 73],
      // Right-aligned: 86 + 26 - 4 - 6.
      ["3", 102, 73],
    ])
  })

  it("wraps long cells within their column and repeats the header on a new page", async () => {
    pageHeight = 160
    const rows = Array.from({ length: 5 }, (_, i) => `| r${i} | ${"word ".repeat(30).trim()} |`)
    await generatePdf({
      title: "Long table",
      blocks: parseMarkdownBlocks(["| k | v |", "|-|-|", ...rows].join("\n")),
    })
    expect(addPageMock).toHaveBeenCalled()
    const headers = drawn().filter((text) => text === "k")
    expect(headers.length).toBe(addPageMock.mock.calls.length + 1)
    // Every cell line stays inside the page body.
    for (const [, x] of drawnAt()) expect(x).toBeLessThan(552)
  })

  it("leaves room above a heading that follows other text", async () => {
    await generatePdf({ title: "H", blocks: parseMarkdownBlocks("intro\n\n## Next") })
    // The paragraph ends at 48 + 13 + 6; a 16pt heading adds 8 and 5 more.
    expect(drawnAt()).toEqual([
      ["intro", 48, 48, "helvetica"],
      ["Next", 48, 48 + 13 + 6 + 8 + 16 - 11, "helvetica"],
    ])
  })

  it("draws a thematic break across the text column", async () => {
    await generatePdf({ title: "Rule", blocks: parseMarkdownBlocks("---") })
    expect(lineMock).toHaveBeenCalledWith(48, 48 - 5.5, 552, 48 - 5.5)
  })

  it("refuses an emoji without fetching the bundled font, before drawing anything", async () => {
    await expect(
      generatePdf({ title: "Emoji", blocks: parseMarkdownBlocks("ok \u{1f600}") })
    ).rejects.toEqual(new PdfUnsupportedCharactersError(["\u{1f600}"]))
    expect(loadFont).not.toHaveBeenCalled()
    expect(textMock).not.toHaveBeenCalled()
  })

  it("names the characters the bundled font lacks, before drawing anything (C09)", async () => {
    covering("中文")
    const error = await generatePdf({
      title: "中文",
      blocks: parseMarkdownBlocks("# 中文\n\n| 한국어 |\n|-|\n| \u{1f600} |"),
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
      generatePdf({ title: "中文", blocks: parseMarkdownBlocks("正文") })
    ).rejects.toBeInstanceOf(PdfFontUnavailableError)
    expect(jsPDFMock).not.toHaveBeenCalled()
  })

  it("fits a figure inside the margins, on a new page when it does not fit", async () => {
    await generatePdf({
      title: "Fig",
      blocks: [
        { kind: "paragraph", runs: [{ text: "before" }] },
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

  it("reports the images it wrote as text and the raw HTML", async () => {
    const out = await generatePdf({
      title: "Losses",
      blocks: parseMarkdownBlocks("![a](https://x/a.png) <span>x</span>"),
    })
    expect(drawn()).toContain("a (https://x/a.png)")
    expect(out.losses).toEqual([
      { kind: "image", count: 1 },
      { kind: "html", count: 2 },
    ])
  })

  it("produces a real PDF with indented code, selectable text and an embedded PNG", async () => {
    const { jsPDF } = jest.requireActual<typeof import("jspdf")>("jspdf")
    jsPDFMock.mockImplementationOnce((options) => new jsPDF(options))
    const out = await generatePdf({
      title: "Real",
      blocks: [
        ...parseMarkdownBlocks(
          "# Analysis\n\n**Bold** and [a link](https://example.com)\n\n| k | v |\n|-|-|\n| a | b |"
        ),
        { kind: "code", text: "# comment\n    indented()" },
        { kind: "image", dataUrl: PNG_URL, format: "PNG" },
      ],
    })
    const pdf = await readBlobBinary(out.data)
    const content = inflatedStreams(pdf).join("\n")
    expect(pdf).toMatch(/^%PDF-/)
    expect(content).toContain("(Analysis)")
    expect(content).toContain("(Bold)")
    expect(content).toContain("(# comment)")
    expect(content).toContain("(    indented\\(\\))")
    expect(pdf).toContain("/Subtype /Image")
    expect(pdf).toContain("/Helvetica-Bold")
    expect(pdf).toMatch(/\/Subtype \/Link[^]*?\/URI \(https:\/\/example\.com\)/)
    expect(pdf).toContain("/Title (Real)")
    expect(loadFont).not.toHaveBeenCalled()
  })

  it("embeds a subset of the shipped font, so Chinese text is selectable (C09)", async () => {
    const { jsPDF } = jest.requireActual<typeof import("jspdf")>("jspdf")
    jsPDFMock.mockImplementationOnce((options) => new jsPDF(options))
    loadFont.mockResolvedValueOnce(realFont())
    const out = await generatePdf({
      title: "中文",
      blocks: parseMarkdownBlocks("# 标题\n\n正文“引号”，*Latin* 混排。\n\n```\n# 注释\n```"),
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
