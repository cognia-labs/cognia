"use client"

/**
 * Render an artifact to a PDF Blob.
 *
 * Two shapes, because "a PDF of this artifact" means two different things:
 *
 * - **Text-ish** (document / code / jupyter): laid out as text through the
 *   client-side document blocks, so it stays
 *   selectable, searchable and reflows onto pages. Rasterising a document into
 *   a picture of itself would be a downgrade.
 * - **Visual** (chart / mermaid / math / svg / html / react): rasterised first
 *   (`./raster`) and placed on a fitted A4 page. There is no text layout to
 *   recover from a Recharts tree.
 *
 * Notebooks reuse the document writer's Markdown parser, with an image block
 * for embedded figures; `generateDocument` currently only supports text.
 */

import { getArtifactRuntimeAdapter } from "@/components/artifacts/runtime-adapters"
import { generateDocument } from "@/lib/files/document-writer"
import { readAsDataUrl, renderArtifactToPngBlob, type RasteriseOptions } from "./raster"
import { notebookToDocumentBlocks, type NotebookDocumentBlock } from "./notebook-markdown"
import type { Artifact } from "@/types"

/** A4 at 72dpi in points, matching `document-writer`'s jsPDF unit. */
const A4_WIDTH_PT = 595.28
const A4_HEIGHT_PT = 841.89
const PAGE_MARGIN_PT = 36

/** Artifact types whose PDF is laid-out text rather than a picture. */
const TEXT_PDF_TYPES = new Set(["document", "code", "jupyter"])

/** Text-layout PDFs read the source directly, without a mounted preview. */
export function pdfNeedsMountedPreview(artifact: Pick<Artifact, "type">): boolean {
  return (
    !TEXT_PDF_TYPES.has(artifact.type) &&
    getArtifactRuntimeAdapter(artifact.type).transport !== "jupyter"
  )
}

function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 })
    img.onerror = () => reject(new Error("failed to measure the rendered image"))
    img.src = dataUrl
  })
}

async function renderNotebookPdf(blocks: NotebookDocumentBlock[]): Promise<Blob> {
  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  const margin = PAGE_MARGIN_PT
  const pageHeight = doc.internal.pageSize.getHeight()
  const maxWidth = doc.internal.pageSize.getWidth() - margin * 2
  let y = margin
  const newPage = () => {
    doc.addPage()
    y = margin
  }

  for (const block of blocks) {
    if (block.kind === "image") {
      const size = await loadImageSize(block.dataUrl)
      const scale = Math.min(maxWidth / size.width, (pageHeight - margin * 2) / size.height, 1)
      const width = size.width * scale
      const height = size.height * scale
      if (y + height > pageHeight - margin) newPage()
      doc.addImage(block.dataUrl, block.format, margin, y, width, height)
      y += height + 8
      continue
    }
    const size = block.kind === "heading" ? 22 - block.level * 2 : block.kind === "code" ? 10 : 11
    doc.setFont(block.kind === "code" ? "courier" : "helvetica", "normal")
    doc.setFontSize(size)
    const text = block.kind === "listItem" ? `• ${block.text}` : block.text
    // Split explicit lines first so code and terminal output retain line breaks.
    for (const line of text.split("\n")) {
      for (const wrapped of doc.splitTextToSize(line, maxWidth) as string[]) {
        if (y + size > pageHeight - margin) newPage()
        doc.text(wrapped, margin, y)
        y += size + 2
      }
    }
    y += 6
  }
  return doc.output("blob")
}

export async function renderArtifactToPdfBlob(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content">,
  options: RasteriseOptions = {}
): Promise<Blob> {
  if (getArtifactRuntimeAdapter(artifact.type).transport === "jupyter") {
    const blocks = notebookToDocumentBlocks(artifact.content)
    if (blocks) return renderNotebookPdf(blocks)
  }
  if (!pdfNeedsMountedPreview(artifact)) {
    const doc = await generateDocument({
      title: artifact.title || "artifact",
      markdown: artifact.content,
      format: "pdf",
    })
    return doc.data
  }

  // A rasterised page wants a white sheet regardless of the app theme — a
  // transparent PNG on a PDF page prints as whatever the viewer feels like.
  const png = await renderArtifactToPngBlob(artifact, {
    background: options.background ?? "#ffffff",
  })
  const dataUrl = await readAsDataUrl(png)
  const { width, height } = await loadImageSize(dataUrl)

  const { jsPDF } = await import("jspdf")
  // Portrait unless the image is genuinely wider than tall — a wide chart
  // squeezed onto a portrait page is unreadable.
  const landscape = width > height
  const pageWidth = landscape ? A4_HEIGHT_PT : A4_WIDTH_PT
  const pageHeight = landscape ? A4_WIDTH_PT : A4_HEIGHT_PT
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: landscape ? "landscape" : "portrait",
  })

  const maxWidth = pageWidth - PAGE_MARGIN_PT * 2
  const maxHeight = pageHeight - PAGE_MARGIN_PT * 2
  const scale = Math.min(maxWidth / width, maxHeight / height, 1)
  const drawWidth = width * scale
  const drawHeight = height * scale

  doc.addImage(
    dataUrl,
    "PNG",
    (pageWidth - drawWidth) / 2,
    (pageHeight - drawHeight) / 2,
    drawWidth,
    drawHeight
  )
  return doc.output("blob")
}
