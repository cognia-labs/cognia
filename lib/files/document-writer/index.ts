// Client-side document writer: turns document blocks into a downloadable Word
// (.docx) or PDF file, entirely in the webview (no server, no sidecar), so it
// works the same in the browser, the Tauri shell and the Capacitor app. The
// heavy `docx` / `jspdf` libraries are lazy-imported so they never enter the
// main bundle. Saving is the caller's: `saveExport` picks the platform route.
//
// Callers hand over blocks rather than Markdown because "the text of this
// file" depends on what the file is: a Markdown document parses
// (`parseMarkdownBlocks`), while source code is one verbatim code block whose
// `#` comments and indentation must survive.

import {
  assertPdfFontsDraw,
  breakProseLines,
  codeColumns,
  expandTabs,
  needsUnicodePdfFont,
  pdfGlyphs,
  pdfTextRuns,
  wrapCodeLine,
  type PdfGlyph,
  type PdfTextRun,
  type PdfUnicodeCoverage,
} from "./pdf-text"
import { loadPdfUnicodeFont, PDF_UNICODE_FONT } from "./unicode-font"
import type { DocBlock, PdfBlock } from "./blocks"

export type DocFormat = "docx" | "pdf"

export interface GeneratedDocument {
  data: Blob
  mimeType: string
  filename: string
}

const MIME: Record<DocFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
}

/** Page margin, in points (jsPDF's unit here). */
const PDF_MARGIN_PT = 48
const PDF_BODY_SIZE = 11
const PDF_CODE_SIZE = 10
const PDF_LINE_GAP = 2
const PDF_HEADING_SIZE: Record<1 | 2 | 3, number> = { 1: 20, 2: 16, 3: 14 }
/**
 * Outline drawn around a bold heading's glyphs in the bundled font, as a share
 * of the font size. The font ships one weight (a bold file would double its
 * 10 MB), so bold is drawn as fill plus a thin stroke.
 */
const PDF_FAUX_BOLD_STROKE = 0.03
const DOCX_CODE_FONT = "Courier New"

/** Strip characters a filename can't carry, keeping the title readable. */
function safeFilename(title: string, format: DocFormat): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "document"
  return `${base}.${format}`
}

/** Render blocks into a .docx Blob via the `docx` library. */
async function renderDocx(blocks: readonly DocBlock[]): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx")
  const headingFor = (level: 1 | 2 | 3) =>
    level === 1
      ? HeadingLevel.HEADING_1
      : level === 2
        ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_3

  const paragraphs = blocks.map((b) => {
    switch (b.kind) {
      case "heading":
        return new Paragraph({ heading: headingFor(b.level), children: [new TextRun(b.text)] })
      case "listItem":
        return new Paragraph({ text: b.text, bullet: { level: 0 } })
      case "code":
        // One run per line joined by line breaks. A "\n" inside a run is
        // written as a literal newline, which Word shows as a space, so a
        // whole block used to collapse onto one line. Runs keep their leading
        // spaces (`xml:space="preserve"`); tabs are expanded because Word does
        // not draw a raw tab inside a run.
        return new Paragraph({
          children: b.text
            .replace(/\r\n/g, "\n")
            .split("\n")
            .map(
              (line, index) =>
                new TextRun({
                  text: expandTabs(line),
                  font: DOCX_CODE_FONT,
                  ...(index > 0 ? { break: 1 } : {}),
                })
            ),
        })
      case "paragraph":
      default:
        return new Paragraph({ children: [new TextRun(b.text)] })
    }
  })

  const doc = new Document({ sections: [{ children: paragraphs }] })
  return Packer.toBlob(doc)
}

type PdfWeight = "normal" | "bold"
type PdfStandardFamily = "helvetica" | "courier"

/** Render blocks into a PDF Blob via `jspdf`. */
async function renderPdf(blocks: readonly PdfBlock[]): Promise<Blob> {
  const texts = blocks.flatMap((block) => (block.kind === "image" ? [] : [block.text]))
  // Only text the built-in fonts cannot draw pulls in the bundled font.
  const unicodeFont = needsUnicodePdfFont(texts) ? await loadPdfUnicodeFont() : null

  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true })
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
  const maxImageHeight = pageHeight - margin * 2
  let y = margin

  const ensureRoom = (height: number) => {
    if (y + height > pageHeight - margin) {
      doc.addPage()
      y = margin
    }
  }
  const selectFace = (
    face: PdfGlyph["face"],
    family: PdfStandardFamily,
    weight: PdfWeight,
    size: number
  ) => {
    if (face === "unicode") doc.setFont(PDF_UNICODE_FONT.family, "normal")
    else doc.setFont(family, weight)
    doc.setFontSize(size)
  }
  const widths = new Map<string, number>()
  const widthOf = (
    glyph: PdfGlyph,
    family: PdfStandardFamily,
    weight: PdfWeight,
    size: number
  ): number => {
    const key = `${glyph.face === "unicode" ? "unicode" : `${family}:${weight}`}:${size}:${glyph.char}`
    let width = widths.get(key)
    if (width === undefined) {
      selectFace(glyph.face, family, weight, size)
      width = doc.getTextWidth(glyph.char)
      widths.set(key, width)
    }
    return width
  }
  const drawRun = (
    run: PdfTextRun,
    x: number,
    family: PdfStandardFamily,
    weight: PdfWeight,
    size: number
  ) => {
    selectFace(run.face, family, weight, size)
    if (run.face === "unicode" && weight === "bold") {
      doc.setLineWidth(size * PDF_FAUX_BOLD_STROKE)
      doc.text(run.text, x, y, { renderingMode: "fillThenStroke" })
    } else {
      doc.text(run.text, x, y)
    }
  }
  const drawProse = (text: string, size: number, gap: number, weight: PdfWeight) => {
    const measure = (glyph: PdfGlyph) => widthOf(glyph, "helvetica", weight, size)
    for (const line of breakProseLines(pdfGlyphs(text, covers), maxWidth, measure)) {
      ensureRoom(size)
      let x = margin
      for (const run of pdfTextRuns(line)) {
        drawRun(run, x, "helvetica", weight, size)
        x += Array.from(run.text).reduce((sum, char) => sum + measure({ char, face: run.face }), 0)
      }
      y += size + PDF_LINE_GAP
    }
    y += gap
  }
  // A code row on a monospace grid: Latin-1 runs in Courier, every other
  // glyph centred in its cell (two cells for a wide one), so indentation and
  // alignment hold as they do in an editor.
  const drawCodeRow = (row: readonly PdfGlyph[], column: number) => {
    let col = 0
    let pending: { text: string; col: number } | null = null
    const flush = () => {
      if (pending)
        drawRun(
          { face: "standard", text: pending.text },
          margin + pending.col * column,
          "courier",
          "normal",
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
        const glyphWidth = widthOf(glyph, "courier", "normal", PDF_CODE_SIZE)
        const x = margin + col * column + (span * column - glyphWidth) / 2
        drawRun({ face: "unicode", text: glyph.char }, x, "courier", "normal", PDF_CODE_SIZE)
      }
      col += span
    }
    flush()
  }

  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        drawProse(b.text, PDF_HEADING_SIZE[b.level], 6, "bold")
        break
      case "listItem":
        drawProse(`\u2022 ${b.text}`, PDF_BODY_SIZE, 2, "normal")
        break
      case "code": {
        // Cut at a fixed column count rather than wrapped like prose: prose
        // wrapping breaks at spaces and drops them, losing indentation.
        doc.setFont("courier", "normal")
        doc.setFontSize(PDF_CODE_SIZE)
        const column = doc.getTextWidth("M")
        const columns = Math.floor(maxWidth / column)
        for (const line of b.text.replace(/\r\n/g, "\n").split("\n")) {
          for (const row of wrapCodeLine(pdfGlyphs(line, covers), columns)) {
            ensureRoom(PDF_CODE_SIZE)
            drawCodeRow(row, column)
            y += PDF_CODE_SIZE + PDF_LINE_GAP
          }
        }
        y += 6
        break
      }
      case "image": {
        // Throws on an image jsPDF cannot read, rather than dropping it.
        const { width, height } = doc.getImageProperties(b.dataUrl)
        const scale = Math.min(maxWidth / (width || 1), maxImageHeight / (height || 1), 1)
        const drawWidth = (width || 1) * scale
        const drawHeight = (height || 1) * scale
        ensureRoom(drawHeight)
        doc.addImage(b.dataUrl, b.format, margin, y, drawWidth, drawHeight)
        y += drawHeight + 8
        break
      }
      case "paragraph":
      default:
        drawProse(b.text, PDF_BODY_SIZE, 6, "normal")
        break
    }
  }

  return doc.output("blob")
}

/** A Word document of `blocks`. */
export async function generateDocx(opts: {
  title: string
  blocks: readonly DocBlock[]
}): Promise<GeneratedDocument> {
  return {
    data: await renderDocx(opts.blocks),
    mimeType: MIME.docx,
    filename: safeFilename(opts.title, "docx"),
  }
}

/**
 * A PDF of `blocks`, as selectable text (and embedded figures).
 *
 * Text the built-in fonts cannot draw (Chinese, kana, Russian, typographic
 * punctuation) is drawn in the bundled Noto Sans SC, fetched only then.
 * Rejects with `PdfUnsupportedCharactersError` when the text holds characters
 * no font can draw (emoji, Hangul, accented Greek, …), with
 * `PdfFontUnavailableError` when the
 * bundled font cannot be read, and with jsPDF's own error for a figure it
 * cannot read.
 */
export async function generatePdf(opts: {
  title: string
  blocks: readonly PdfBlock[]
}): Promise<GeneratedDocument> {
  return {
    data: await renderPdf(opts.blocks),
    mimeType: MIME.pdf,
    filename: safeFilename(opts.title, "pdf"),
  }
}
