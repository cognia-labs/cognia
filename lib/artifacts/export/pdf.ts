"use client"

/**
 * Render an artifact to a PDF Blob.
 *
 * Two shapes, because "a PDF of this artifact" means two different things:
 *
 * - **Text-ish** (document / code / jupyter): laid out as text by the document
 *   writer from the artifact's own blocks (`./document-blocks`), so it stays
 *   selectable, searchable and reflows onto pages. Rasterising a document into
 *   a picture of itself would be a downgrade. A notebook's figures are
 *   embedded between its cells.
 * - **Visual** (chart / mermaid / math / svg / html / react): rasterised first
 *   (`./raster`) and placed on a fitted A4 page. There is no text layout to
 *   recover from a Recharts tree.
 */

import { generatePdf } from "@/lib/files/document-writer"
import { readAsDataUrl, renderArtifactToPngBlob, type RasteriseOptions } from "./raster"
import { artifactPdfBlocks, pdfNeedsMountedPreview } from "./document-blocks"
import type { Artifact } from "@/types"

/** A4 at 72dpi in points, matching `document-writer`'s jsPDF unit. */
const A4_WIDTH_PT = 595.28
const A4_HEIGHT_PT = 841.89
const PAGE_MARGIN_PT = 36

function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 })
    img.onerror = () => reject(new Error("failed to measure the rendered image"))
    img.src = dataUrl
  })
}

export async function renderArtifactToPdfBlob(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content">,
  options: RasteriseOptions = {}
): Promise<Blob> {
  if (!pdfNeedsMountedPreview(artifact)) {
    const doc = await generatePdf({
      title: artifact.title || "artifact",
      blocks: artifactPdfBlocks(artifact),
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
