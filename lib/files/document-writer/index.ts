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
  assertStandardPdfFontText,
  expandTabs,
  toStandardPdfFontText,
  wrapMonospaceLine,
} from "./pdf-text"
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

/** Render blocks into a PDF Blob via `jspdf`. */
async function renderPdf(blocks: readonly PdfBlock[]): Promise<Blob> {
  // Before drawing anything: a PDF missing the characters its fonts cannot
  // draw is exactly the silent loss this refuses (see `./pdf-text`).
  assertStandardPdfFontText(blocks.flatMap((block) => (block.kind === "image" ? [] : [block.text])))

  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4" })
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
  const drawRows = (rows: readonly string[], size: number, gap: number) => {
    for (const row of rows) {
      ensureRoom(size)
      doc.text(row, margin, y)
      y += size + PDF_LINE_GAP
    }
    y += gap
  }
  const drawProse = (text: string, size: number, gap: number, weight: "normal" | "bold") => {
    doc.setFont("helvetica", weight)
    doc.setFontSize(size)
    drawRows(doc.splitTextToSize(toStandardPdfFontText(text), maxWidth) as string[], size, gap)
  }

  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        drawProse(b.text, PDF_HEADING_SIZE[b.level], 6, "bold")
        break
      case "listItem":
        drawProse(`• ${b.text}`, PDF_BODY_SIZE, 2, "normal")
        break
      case "code": {
        // Cut at a fixed column count rather than wrapped like prose: prose
        // wrapping breaks at spaces and drops them, losing indentation.
        doc.setFont("courier", "normal")
        doc.setFontSize(PDF_CODE_SIZE)
        const charsPerLine = Math.floor(maxWidth / doc.getTextWidth("M"))
        const rows = toStandardPdfFontText(b.text)
          .replace(/\r\n/g, "\n")
          .split("\n")
          .flatMap((line) => wrapMonospaceLine(line, charsPerLine))
        drawRows(rows, PDF_CODE_SIZE, 6)
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
 * Rejects with `PdfUnsupportedCharactersError` when the text holds characters
 * the built-in fonts cannot draw (Chinese, Cyrillic, emoji, …), and with
 * jsPDF's own error for a figure it cannot read.
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
