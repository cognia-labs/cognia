// Client-side document writer: turns document blocks into a Word (.docx) or
// PDF file, entirely in the webview (no server, no sidecar), so it works the
// same in the browser, the Tauri shell and the Capacitor app. The heavy
// `docx` / `jspdf` libraries are lazy-imported so they never enter the main
// bundle. Saving is the caller's: `saveExport` picks the platform route.
//
// Callers hand over blocks rather than Markdown because "the text of this
// file" depends on what the file is: a Markdown document parses
// (`parseMarkdownBlocks`), while source code is one verbatim code block whose
// `#` comments and indentation must survive.
//
// Both writers lay the blocks out natively: Word gets real headings, numbered
// and bulleted lists, tables with a repeating header row, hyperlinks, bold /
// italic / strikethrough / code runs and embedded pictures; the PDF draws the
// same with matching fonts, a ruled table grid, link annotations and figures.
// What a block stands in for (an image not embedded, raw HTML) comes back as
// `losses`, for the caller to tell the user.

import type { IRunOptions, NumberingDefinition, ParagraphChild } from "docx"
import type { jsPDF as JsPdf } from "jspdf"
import {
  assertPdfFontsDraw,
  breakProseLines,
  codeColumns,
  expandTabs,
  fitTableColumns,
  needsUnicodePdfFont,
  pdfGlyphs,
  proseMinimumWidth,
  proseNaturalWidth,
  wrapCodeLine,
  type PdfGlyph,
  type PdfUnicodeCoverage,
} from "./pdf-text"
import { loadPdfUnicodeFont, PDF_UNICODE_FONT } from "./unicode-font"
import {
  dataUrlBytes,
  documentLosses,
  imageFormatOf,
  imagePixelSize,
  listDepth,
  runsText,
  type DocAlign,
  type DocBlock,
  type DocListMarker,
  type DocNest,
  type DocRun,
  type DocumentLoss,
} from "./blocks"

export type DocFormat = "docx" | "pdf"

/** A written file, and what it could not keep (empty when it kept everything). */
export interface WrittenDocument {
  data: Blob
  losses: DocumentLoss[]
}

/** A bulleted item's marker, by list depth. */
const BULLETS = ["•", "◦", "▪"] as const
/** The PDF's: the third DOCX bullet would pull the 10 MB font in for one glyph. */
const PDF_BULLETS = ["•", "◦", "-"] as const

// ---------------------------------------------------------------------------
// Word

/** A4 with the `docx` library's default one-inch margins, in twips. */
const DOCX_CONTENT_WIDTH = 11906 - 2 * 1440
const DOCX_CONTENT_HEIGHT = 16838 - 2 * 1440
/** Twips per CSS pixel (96 to the inch), the unit `docx` sizes pictures in. */
const TWIPS_PER_PIXEL = 15
const DOCX_QUOTE_INDENT = 480
const DOCX_LIST_INDENT = 720
const DOCX_LIST_HANGING = 360
const DOCX_RULE_COLOR = "BFBFBF"
const DOCX_HEADER_FILL = "F2F2F2"
const DOCX_CODE_FONT = "Courier New"
const DOCX_BULLET_REFERENCE = "bullets"
const LIST_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

const docxIndentOf = (nest: readonly DocNest[] | undefined) =>
  (nest ?? []).reduce(
    (sum, container) => sum + (container === "quote" ? DOCX_QUOTE_INDENT : DOCX_LIST_INDENT),
    0
  )

/** Render blocks into a .docx Blob via the `docx` library. */
async function renderDocx(title: string, blocks: readonly DocBlock[]): Promise<Blob> {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    ExternalHyperlink,
    HeadingLevel,
    ImageRun,
    LevelFormat,
    Packer,
    Paragraph,
    ShadingType,
    Tab,
    TabStopType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = await import("docx")
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ] as const
  const alignments = {
    left: AlignmentType.LEFT,
    center: AlignmentType.CENTER,
    right: AlignmentType.RIGHT,
  } as const
  const rule = { style: BorderStyle.SINGLE, size: 4, color: DOCX_RULE_COLOR } as const
  const levelIndent = (level: number) => ({
    paragraph: {
      indent: { left: DOCX_LIST_INDENT * (level + 1), hanging: DOCX_LIST_HANGING },
    },
  })

  const numbering: NumberingDefinition[] = [
    {
      reference: DOCX_BULLET_REFERENCE,
      levels: LIST_LEVELS.map((level) => ({
        level,
        format: LevelFormat.BULLET,
        text: BULLETS[level % BULLETS.length],
        style: levelIndent(level),
      })),
    },
  ]
  // A numbered list is its own Word list, so it counts from its own start.
  // Items of one list share a nesting path, and lists at one path cannot
  // interleave, so the path names the list being numbered there.
  const openLists = new Map<string, string>()
  const numberedReference = (path: string, value: number) => {
    const open = openLists.get(path)
    if (open) return open
    const reference = `numbered-${numbering.length}`
    numbering.push({
      reference,
      levels: LIST_LEVELS.map((level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        start: value,
        style: levelIndent(level),
      })),
    })
    openLists.set(path, reference)
    return reference
  }

  const placed = (nest: readonly DocNest[] | undefined, hanging = false) => {
    const left = docxIndentOf(nest) + (hanging ? DOCX_LIST_INDENT : 0)
    return {
      ...(left > 0 ? { indent: { left, ...(hanging ? { hanging: DOCX_LIST_HANGING } : {}) } } : {}),
      ...(nest?.includes("quote")
        ? {
            border: {
              left: { style: BorderStyle.SINGLE, size: 12, color: DOCX_RULE_COLOR, space: 8 },
            },
          }
        : {}),
    }
  }

  const textRuns = (run: DocRun, base: IRunOptions) =>
    run.text.split("\n").map(
      (text, index) =>
        new TextRun({
          ...base,
          text,
          ...(run.bold ? { bold: true } : {}),
          ...(run.italic ? { italics: true } : {}),
          ...(run.strike ? { strike: true } : {}),
          ...(run.code ? { font: DOCX_CODE_FONT } : {}),
          ...(index > 0 ? { break: 1 } : {}),
        })
    )
  const runChildren = (runs: readonly DocRun[], base: IRunOptions = {}): ParagraphChild[] => {
    const children: ParagraphChild[] = []
    for (let i = 0; i < runs.length;) {
      const href = runs[i].href
      if (!href) {
        children.push(...textRuns(runs[i], base))
        i += 1
        continue
      }
      // Adjacent runs of one link are one hyperlink, whatever their styling.
      const linked: ParagraphChild[] = []
      while (i < runs.length && runs[i].href === href) {
        linked.push(...textRuns(runs[i], { ...base, style: "Hyperlink" }))
        i += 1
      }
      children.push(new ExternalHyperlink({ link: href, children: linked }))
    }
    return children
  }

  // One run per line joined by line breaks. A "\n" inside a run is written as
  // a literal newline, which Word shows as a space, so a whole block used to
  // collapse onto one line. Runs keep their leading spaces
  // (`xml:space="preserve"`); tabs are expanded because Word does not draw a
  // raw tab inside a run.
  const codeRuns = (text: string) =>
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map(
        (line, index) =>
          new TextRun({
            text: expandTabs(line),
            font: DOCX_CODE_FONT,
            ...(index > 0 ? { break: 1 } : {}),
          })
      )

  const imageRun = (block: Extract<DocBlock, { kind: "image" }>) => {
    const bytes = dataUrlBytes(block.dataUrl)
    const format = bytes && imageFormatOf(bytes)
    const size = bytes && imagePixelSize(bytes)
    if (!bytes || !format || !size) {
      throw new Error("the document's image is not a readable PNG or JPEG")
    }
    const maxWidth = (DOCX_CONTENT_WIDTH - docxIndentOf(block.nest)) / TWIPS_PER_PIXEL
    const scale = Math.min(
      maxWidth / size.width,
      DOCX_CONTENT_HEIGHT / TWIPS_PER_PIXEL / size.height,
      1
    )
    return new ImageRun({
      type: format === "PNG" ? "png" : "jpg",
      data: bytes,
      transformation: {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      },
      ...(block.alt
        ? { altText: { name: block.alt, description: block.alt, title: block.alt } }
        : {}),
    })
  }

  const table = (block: Extract<DocBlock, { kind: "table" }>) => {
    const left = docxIndentOf(block.nest)
    const columns = Math.max(1, block.header.length)
    const columnWidth = Math.floor((DOCX_CONTENT_WIDTH - left) / columns)
    const alignment = (align: DocAlign | undefined) => (align ? alignments[align] : undefined)
    const row = (cells: readonly DocRun[][], header: boolean) =>
      new TableRow({
        ...(header ? { tableHeader: true } : {}),
        children: Array.from(
          { length: columns },
          (_, column) =>
            new TableCell({
              width: { size: columnWidth, type: WidthType.DXA },
              ...(header
                ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: DOCX_HEADER_FILL } }
                : {}),
              children: [
                new Paragraph({
                  ...(alignment(block.align[column])
                    ? { alignment: alignment(block.align[column]) }
                    : {}),
                  children: runChildren(cells[column] ?? [], header ? { bold: true } : {}),
                }),
              ],
            })
        ),
      })
    return new Table({
      width: { size: columnWidth * columns, type: WidthType.DXA },
      columnWidths: Array.from({ length: columns }, () => columnWidth),
      ...(left > 0 ? { indent: { size: left, type: WidthType.DXA } } : {}),
      borders: {
        top: rule,
        bottom: rule,
        left: rule,
        right: rule,
        insideHorizontal: rule,
        insideVertical: rule,
      },
      rows: [row(block.header, true), ...block.rows.map((cells) => row(cells, false))],
    })
  }

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case "heading":
        children.push(
          new Paragraph({
            heading: headings[block.level - 1],
            ...placed(block.nest),
            children: runChildren(block.runs),
          })
        )
        break
      case "paragraph":
        children.push(new Paragraph({ ...placed(block.nest), children: runChildren(block.runs) }))
        break
      case "listItem": {
        const path = (block.nest ?? []).join("/")
        const marker: DocListMarker = block.marker
        if (marker.type === "number" && marker.value === marker.start) openLists.delete(path)
        if (block.checked !== undefined) {
          // A task item shows its box where the bullet would be, the text
          // starting at the stop where a list item's text does.
          children.push(
            new Paragraph({
              ...placed(block.nest, true),
              tabStops: [
                { type: TabStopType.LEFT, position: docxIndentOf(block.nest) + DOCX_LIST_INDENT },
              ],
              children: [
                new TextRun({ children: [block.checked ? "☒" : "☐", new Tab()] }),
                ...runChildren(block.runs),
              ],
            })
          )
          break
        }
        children.push(
          new Paragraph({
            ...placed(block.nest, true),
            numbering: {
              reference:
                marker.type === "number"
                  ? numberedReference(path, marker.value)
                  : DOCX_BULLET_REFERENCE,
              level: Math.min(listDepth(block.nest), LIST_LEVELS.length - 1),
            },
            children: runChildren(block.runs),
          })
        )
        break
      }
      case "code":
        children.push(new Paragraph({ ...placed(block.nest), children: codeRuns(block.text) }))
        break
      case "table":
        children.push(table(block))
        // Word merges two tables that touch, and a body ends in a paragraph.
        if (index === blocks.length - 1 || blocks[index + 1].kind === "table") {
          children.push(new Paragraph({ children: [] }))
        }
        break
      case "image":
        children.push(new Paragraph({ ...placed(block.nest), children: [imageRun(block)] }))
        break
      case "rule": {
        const { border, ...indent } = placed(block.nest)
        children.push(
          new Paragraph({
            ...indent,
            border: { ...border, bottom: { ...rule, size: 6, space: 1 } },
            children: [],
          })
        )
        break
      }
    }
  })

  const doc = new Document({
    ...(title ? { title } : {}),
    numbering: { config: numbering },
    sections: [{ children }],
  })
  return Packer.toBlob(doc)
}

// ---------------------------------------------------------------------------
// PDF

/** Page margin, in points (jsPDF's unit here). */
const PDF_MARGIN_PT = 48
const PDF_BODY_SIZE = 11
const PDF_CODE_SIZE = 10
const PDF_LINE_GAP = 2
const PDF_BLOCK_GAP = 6
const PDF_HEADING_SIZE: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
  1: 20,
  2: 16,
  3: 14,
  4: 12,
  5: 11,
  6: 11,
}
const PDF_HEADING_SPACE_BEFORE = 8
const PDF_QUOTE_INDENT = 14
const PDF_LIST_INDENT = 18
const PDF_CELL_PADDING = 4
const PDF_LINK_RGB = [5, 99, 193] as const
const PDF_TEXT_RGB = [0, 0, 0] as const
const PDF_RULE_GRAY = 191
const PDF_HEADER_GRAY = 242
/**
 * The bundled font ships one upright weight (a bold or italic file would
 * double its 10 MB), so bold is drawn as fill plus a thin stroke (as a share
 * of the font size) and italic as a 12° slant, as Word and browsers
 * synthesise a missing style.
 */
const PDF_FAUX_BOLD_STROKE = 0.03
const PDF_FAUX_ITALIC_SHEAR = Math.tan((12 * Math.PI) / 180)

type PdfFontStyle = "normal" | "bold" | "italic" | "bolditalic"

/** How a glyph is drawn. `key` is equal for equal styles, to group glyphs into runs. */
interface PdfRunStyle {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  href?: string
  key: string
}

interface StyledGlyph extends PdfGlyph {
  style: PdfRunStyle
}

function pdfRunStyle(run: Omit<DocRun, "text">, forceBold = false): PdfRunStyle {
  const bold = forceBold || run.bold === true
  const italic = run.italic === true
  const strike = run.strike === true
  const code = run.code === true
  return {
    bold,
    italic,
    strike,
    code,
    ...(run.href ? { href: run.href } : {}),
    key: `${+bold}${+italic}${+strike}${+code}${run.href ?? ""}`,
  }
}

const PDF_CODE_STYLE = pdfRunStyle({ code: true })

const pdfFontStyle = (style: PdfRunStyle): PdfFontStyle =>
  style.bold && style.italic
    ? "bolditalic"
    : style.bold
      ? "bold"
      : style.italic
        ? "italic"
        : "normal"

const pdfBullet = (nest: readonly DocNest[] | undefined) =>
  PDF_BULLETS[listDepth(nest) % PDF_BULLETS.length]

/** Every text the PDF draws, to choose and check its fonts before drawing. */
function pdfTexts(blocks: readonly DocBlock[]): string[] {
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case "heading":
      case "paragraph":
        return [runsText(block.runs)]
      case "listItem":
        return [
          runsText(block.runs),
          block.checked !== undefined
            ? ""
            : block.marker.type === "number"
              ? `${block.marker.value}.`
              : pdfBullet(block.nest),
        ]
      case "code":
        return [block.text]
      case "table":
        return [...block.header, ...block.rows.flat()].map(runsText)
      case "image":
      case "rule":
        return []
    }
  })
}

/** Render blocks into a PDF Blob via `jspdf`. */
async function renderPdf(title: string, blocks: readonly DocBlock[]): Promise<Blob> {
  const texts = pdfTexts(blocks)
  // Only text the built-in fonts cannot draw pulls in the bundled font.
  const unicodeFont = needsUnicodePdfFont(texts) ? await loadPdfUnicodeFont() : null

  const { jsPDF } = await import("jspdf")
  const doc: JsPdf = new jsPDF({ unit: "pt", format: "a4", compress: true })
  if (title) doc.setProperties({ title })
  let covers: PdfUnicodeCoverage = null
  if (unicodeFont !== null) {
    doc.addFileToVFS(PDF_UNICODE_FONT.vfsName, unicodeFont)
    doc.addFont(PDF_UNICODE_FONT.vfsName, PDF_UNICODE_FONT.family, "normal", "normal", "Identity-H")
    doc.setFont(PDF_UNICODE_FONT.family, "normal")
    const codeMap = doc.getFont().metadata.cmap.unicode.codeMap as Record<number, number>
    covers = (codePoint) => (codeMap[codePoint] ?? 0) > 0
  }
  // Before drawing anything: a PDF missing the characters no font can draw is
  // exactly the silent loss this refuses (see `./pdf-text`).
  assertPdfFontsDraw(texts, covers)

  const margin = PDF_MARGIN_PT
  const pageHeight = doc.internal.pageSize.getHeight()
  const maxWidth = doc.internal.pageSize.getWidth() - margin * 2
  const bottom = pageHeight - margin
  const maxImageHeight = pageHeight - margin * 2
  // `y` is the baseline of the next line of text.
  let y = margin

  const newPage = () => {
    doc.addPage()
    y = margin
  }
  const ensureRoom = (height: number) => {
    if (y + height > bottom) newPage()
  }
  const leftOf = (nest: readonly DocNest[] | undefined) =>
    margin +
    (nest ?? []).reduce(
      (sum, container) => sum + (container === "quote" ? PDF_QUOTE_INDENT : PDF_LIST_INDENT),
      0
    )
  const widthFrom = (left: number) => margin + maxWidth - left
  // A quote's bar beside every line, row or figure drawn inside it.
  const quoteBars = (nest: readonly DocNest[] | undefined, top: number, until: number) => {
    let x = margin
    for (const container of nest ?? []) {
      if (container === "quote") {
        doc.setDrawColor(PDF_RULE_GRAY, PDF_RULE_GRAY, PDF_RULE_GRAY)
        doc.setLineWidth(2)
        doc.line(x + 3, top, x + 3, until)
        x += PDF_QUOTE_INDENT
      } else {
        x += PDF_LIST_INDENT
      }
    }
  }

  const selectFace = (face: PdfGlyph["face"], style: PdfRunStyle, size: number) => {
    if (face === "unicode") doc.setFont(PDF_UNICODE_FONT.family, "normal")
    else doc.setFont(style.code ? "courier" : "helvetica", pdfFontStyle(style))
    doc.setFontSize(size)
  }
  const widths = new Map<string, number>()
  const glyphWidth = (glyph: StyledGlyph, size: number): number => {
    const font =
      glyph.face === "unicode"
        ? "unicode"
        : `${glyph.style.code ? "courier" : "helvetica"}:${pdfFontStyle(glyph.style)}`
    const key = `${font}:${size}:${glyph.char}`
    let width = widths.get(key)
    if (width === undefined) {
      selectFace(glyph.face, glyph.style, size)
      width = doc.getTextWidth(glyph.char)
      widths.set(key, width)
    }
    return width
  }
  const lineWidth = (line: readonly StyledGlyph[], size: number) =>
    line.reduce((sum, glyph) => sum + glyphWidth(glyph, size), 0)
  const styledGlyphs = (runs: readonly DocRun[], forceBold = false): StyledGlyph[] =>
    runs.flatMap((run) => {
      const style = pdfRunStyle(run, forceBold)
      return pdfGlyphs(run.text, covers).map((glyph) => ({ ...glyph, style }))
    })

  const drawText = (
    face: PdfGlyph["face"],
    text: string,
    style: PdfRunStyle,
    x: number,
    size: number
  ) => {
    selectFace(face, style, size)
    const rgb = style.href ? PDF_LINK_RGB : PDF_TEXT_RGB
    doc.setTextColor(rgb[0], rgb[1], rgb[2])
    const options: { renderingMode?: "fillThenStroke"; angle?: ReturnType<JsPdf["Matrix"]> } = {}
    let at = x
    if (face === "unicode" && style.bold) {
      doc.setDrawColor(rgb[0], rgb[1], rgb[2])
      doc.setLineWidth(size * PDF_FAUX_BOLD_STROKE)
      options.renderingMode = "fillThenStroke"
    }
    if (face === "unicode" && style.italic) {
      // jsPDF applies the text position inside the matrix it is given, so a
      // slant moves the text right by the shear times its height above the
      // page's bottom edge; start that much to the left.
      options.angle = doc.Matrix(1, 0, PDF_FAUX_ITALIC_SHEAR, 1, 0, 0)
      at = x - PDF_FAUX_ITALIC_SHEAR * (pageHeight - y)
    }
    if (options.renderingMode || options.angle) doc.text(text, at, y, options)
    else doc.text(text, at, y)
  }
  const decorate = (style: PdfRunStyle, x: number, width: number, size: number) => {
    if (!style.strike && !style.href) return
    const rgb = style.href ? PDF_LINK_RGB : PDF_TEXT_RGB
    doc.setDrawColor(rgb[0], rgb[1], rgb[2])
    doc.setLineWidth(Math.max(0.5, size * 0.05))
    if (style.strike) doc.line(x, y - size * 0.3, x + width, y - size * 0.3)
    if (style.href) {
      doc.line(x, y + size * 0.12, x + width, y + size * 0.12)
      doc.link(x, y - size * 0.85, width, size * 1.1, { url: style.href })
    }
  }
  /** One laid-out line at `y`: runs of one face and style, each one `text()` call. */
  const drawLine = (line: readonly StyledGlyph[], x: number, size: number) => {
    let at = x
    for (let i = 0; i < line.length;) {
      const { face, style } = line[i]
      let text = ""
      let width = 0
      while (i < line.length && line[i].face === face && line[i].style.key === style.key) {
        text += line[i].char
        width += glyphWidth(line[i], size)
        i += 1
      }
      drawText(face, text, style, at, size)
      decorate(style, at, width, size)
      at += width
    }
  }
  const drawProse = (
    glyphs: readonly StyledGlyph[],
    nest: readonly DocNest[] | undefined,
    left: number,
    size: number,
    marker?: () => void
  ) => {
    const measure = (glyph: StyledGlyph) => glyphWidth(glyph, size)
    breakProseLines(glyphs, widthFrom(left), measure).forEach((line, index) => {
      ensureRoom(size)
      quoteBars(nest, y - size, y + PDF_LINE_GAP)
      if (index === 0) marker?.()
      drawLine(line, left, size)
      y += size + PDF_LINE_GAP
    })
  }
  const drawCheckbox = (x: number, size: number, checked: boolean) => {
    const box = size * 0.7
    const top = y - box
    doc.setDrawColor(PDF_TEXT_RGB[0], PDF_TEXT_RGB[1], PDF_TEXT_RGB[2])
    doc.setLineWidth(0.8)
    doc.rect(x, top, box, box)
    if (checked) {
      doc.line(x + box * 0.2, top + box * 0.55, x + box * 0.42, top + box * 0.78)
      doc.line(x + box * 0.42, top + box * 0.78, x + box * 0.82, top + box * 0.22)
    }
  }
  // A code row on a monospace grid: Latin-1 runs in Courier, every other
  // glyph centred in its cell (two cells for a wide one), so indentation and
  // alignment hold as they do in an editor.
  const drawCodeRow = (row: readonly PdfGlyph[], left: number, column: number) => {
    let col = 0
    let pending: { text: string; col: number } | null = null
    const flush = () => {
      if (pending)
        drawText(
          "standard",
          pending.text,
          PDF_CODE_STYLE,
          left + pending.col * column,
          PDF_CODE_SIZE
        )
      pending = null
    }
    for (const glyph of row) {
      const span = codeColumns(glyph)
      if (glyph.face === "standard") {
        if (pending) pending.text += glyph.char
        else pending = { text: glyph.char, col }
      } else {
        flush()
        const width = glyphWidth({ ...glyph, style: PDF_CODE_STYLE }, PDF_CODE_SIZE)
        const x = left + col * column + (span * column - width) / 2
        drawText("unicode", glyph.char, PDF_CODE_STYLE, x, PDF_CODE_SIZE)
      }
      col += span
    }
    flush()
  }

  const drawTable = (block: Extract<DocBlock, { kind: "table" }>) => {
    const size = PDF_BODY_SIZE
    const pad = PDF_CELL_PADDING
    const lineHeight = size + PDF_LINE_GAP
    const left = leftOf(block.nest)
    const columns = Math.max(1, block.header.length)
    const measure = (glyph: StyledGlyph) => glyphWidth(glyph, size)
    const cells = [block.header, ...block.rows].map((row, index) =>
      Array.from({ length: columns }, (_, column) => styledGlyphs(row[column] ?? [], index === 0))
    )
    const natural = Array.from({ length: columns }, (_, column) =>
      Math.max(...cells.map((row) => proseNaturalWidth(row[column], measure) + 2 * pad))
    )
    const minimum = Array.from({ length: columns }, (_, column) =>
      Math.max(...cells.map((row) => proseMinimumWidth(row[column], measure) + 2 * pad))
    )
    const columnWidths = fitTableColumns(natural, minimum, widthFrom(left))
    const laidOut = cells.map((row) =>
      row.map((glyphs, column) => breakProseLines(glyphs, columnWidths[column] - 2 * pad, measure))
    )
    const pageTop = () => margin - size
    const usable = bottom - pageTop()
    // The table's cursor is the top edge of the next row.
    let top = y - size

    const drawRow = (lines: StyledGlyph[][][], header: boolean) => {
      const total = Math.max(1, ...lines.map((cell) => cell.length))
      let from = 0
      while (from < total) {
        const fit = Math.floor((bottom - top - 2 * pad) / lineHeight)
        const remaining = total - from
        const atPageTop = top <= pageTop()
        // A row that would fit whole on a fresh page moves there rather than
        // splitting; a row taller than a page splits between its lines.
        if (
          fit < 1 ||
          (from === 0 &&
            fit < remaining &&
            !atPageTop &&
            remaining * lineHeight + 2 * pad <= usable)
        ) {
          breakPage(header)
          continue
        }
        const count = Math.min(fit, remaining)
        const height = count * lineHeight + 2 * pad
        quoteBars(block.nest, top, top + height)
        let x = left
        lines.forEach((cell, column) => {
          const width = columnWidths[column]
          if (header) {
            doc.setFillColor(PDF_HEADER_GRAY, PDF_HEADER_GRAY, PDF_HEADER_GRAY)
            doc.rect(x, top, width, height, "F")
          }
          doc.setDrawColor(PDF_RULE_GRAY, PDF_RULE_GRAY, PDF_RULE_GRAY)
          doc.setLineWidth(0.5)
          doc.rect(x, top, width, height)
          const inner = width - 2 * pad
          const align = block.align[column]
          cell.slice(from, from + count).forEach((line, index) => {
            y = top + pad + size + index * lineHeight
            const room = inner - lineWidth(line, size)
            const offset = align === "center" ? room / 2 : align === "right" ? room : 0
            drawLine(line, x + pad + Math.max(0, offset), size)
          })
          x += width
        })
        top += height
        from += count
        if (from < total) breakPage(header)
      }
    }
    // A table that continues on the next page repeats its header row there.
    const breakPage = (header: boolean) => {
      newPage()
      top = y - size
      if (!header) drawRow(laidOut[0], true)
    }

    laidOut.forEach((lines, index) => drawRow(lines, index === 0))
    y = top + PDF_BLOCK_GAP + size
  }

  for (const block of blocks) {
    const left = leftOf(block.nest)
    switch (block.kind) {
      case "heading": {
        const size = PDF_HEADING_SIZE[block.level]
        // Room above a heading that does not open the page, and for its taller line.
        if (y > margin) y += PDF_HEADING_SPACE_BEFORE + size - PDF_BODY_SIZE
        drawProse(styledGlyphs(block.runs, true), block.nest, left, size)
        y += PDF_BLOCK_GAP
        break
      }
      case "paragraph":
        drawProse(styledGlyphs(block.runs), block.nest, left, PDF_BODY_SIZE)
        y += PDF_BLOCK_GAP
        break
      case "listItem": {
        const textLeft = left + PDF_LIST_INDENT
        const marker = block.marker
        drawProse(styledGlyphs(block.runs), block.nest, textLeft, PDF_BODY_SIZE, () => {
          if (block.checked !== undefined) {
            drawCheckbox(left + 3, PDF_BODY_SIZE, block.checked)
            return
          }
          if (marker.type === "bullet") {
            drawLine(styledGlyphs([{ text: pdfBullet(block.nest) }]), left + 4, PDF_BODY_SIZE)
            return
          }
          const number = styledGlyphs([{ text: `${marker.value}.` }])
          drawLine(number, textLeft - 4 - lineWidth(number, PDF_BODY_SIZE), PDF_BODY_SIZE)
        })
        y += 2
        break
      }
      case "code": {
        // Cut at a fixed column count rather than wrapped like prose: prose
        // wrapping breaks at spaces and drops them, losing indentation.
        doc.setFont("courier", "normal")
        doc.setFontSize(PDF_CODE_SIZE)
        const column = doc.getTextWidth("M")
        const columns = Math.floor(widthFrom(left) / column)
        for (const line of block.text.replace(/\r\n/g, "\n").split("\n")) {
          for (const row of wrapCodeLine(pdfGlyphs(line, covers), columns)) {
            ensureRoom(PDF_CODE_SIZE)
            quoteBars(block.nest, y - PDF_CODE_SIZE, y + PDF_LINE_GAP)
            drawCodeRow(row, left, column)
            y += PDF_CODE_SIZE + PDF_LINE_GAP
          }
        }
        y += PDF_BLOCK_GAP
        break
      }
      case "table":
        drawTable(block)
        break
      case "image": {
        // Throws on an image jsPDF cannot read, rather than dropping it.
        const { width, height } = doc.getImageProperties(block.dataUrl)
        const scale = Math.min(widthFrom(left) / (width || 1), maxImageHeight / (height || 1), 1)
        const drawWidth = (width || 1) * scale
        const drawHeight = (height || 1) * scale
        ensureRoom(drawHeight)
        quoteBars(block.nest, y, y + drawHeight)
        doc.addImage(block.dataUrl, block.format, left, y, drawWidth, drawHeight)
        y += drawHeight + 8
        break
      }
      case "rule":
        ensureRoom(PDF_BODY_SIZE)
        quoteBars(block.nest, y - PDF_BODY_SIZE, y + PDF_LINE_GAP)
        doc.setDrawColor(PDF_RULE_GRAY, PDF_RULE_GRAY, PDF_RULE_GRAY)
        doc.setLineWidth(0.75)
        doc.line(left, y - PDF_BODY_SIZE / 2, margin + maxWidth, y - PDF_BODY_SIZE / 2)
        y += PDF_BODY_SIZE + PDF_LINE_GAP
        break
    }
  }

  return doc.output("blob")
}

/** A Word document of `blocks`, titled `title` in its properties. */
export async function generateDocx(opts: {
  title: string
  blocks: readonly DocBlock[]
}): Promise<WrittenDocument> {
  return {
    data: await renderDocx(opts.title, opts.blocks),
    losses: documentLosses(opts.blocks),
  }
}

/**
 * A PDF of `blocks`, as selectable text (and embedded figures), titled
 * `title` in its properties.
 *
 * Text the built-in fonts cannot draw (Chinese, kana, Russian, typographic
 * punctuation) is drawn in the bundled Noto Sans SC, fetched only then.
 * Rejects with `PdfUnsupportedCharactersError` when the text holds characters
 * no font can draw (emoji, Hangul, accented Greek, …), with
 * `PdfFontUnavailableError` when the bundled font cannot be read, and with
 * jsPDF's own error for a figure it cannot read.
 */
export async function generatePdf(opts: {
  title: string
  blocks: readonly DocBlock[]
}): Promise<WrittenDocument> {
  return {
    data: await renderPdf(opts.title, opts.blocks),
    losses: documentLosses(opts.blocks),
  }
}
