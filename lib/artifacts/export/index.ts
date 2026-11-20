"use client"

/**
 * One entry point for every artifact export format.
 *
 * Before this there were three download paths that disagreed:
 * `use-artifact-panel.handleDownload` (format-aware), `handleDownloadAs`
 * (docx/pdf through the document writer) and `artifact-part.handleDownload`
 * (a `text/plain` blob with `.${artifact.type}` for an extension — so a chart
 * downloaded as `chart.chart`). They now all come through here.
 *
 * `raw` / `html` / `svg` are the source text. `png` / `pdf` render, and are
 * lazily imported so `html2canvas-pro` and `jspdf` never enter the bundle for
 * a user who only ever copies source. Word (`exportArtifactAsWord`) sits
 * beside them rather than in `ArtifactExportFormat`: that union is the plugin
 * contract's, and Word is the panel's own "Download as Word" action.
 */

import { getArtifactExportFormats } from "@/components/artifacts/runtime-adapters"
import { getArtifactExtension } from "@/lib/artifacts/constants"
import { saveExport, type SaveExportOutcome } from "@/lib/files/save-export"
import { PdfUnsupportedCharactersError } from "@/lib/files/document-writer/pdf-text"
import { PdfFontUnavailableError } from "@/lib/files/document-writer/unicode-font"
import type { DocumentLoss } from "@/lib/files/document-writer/blocks"
import {
  ArtifactNotebookUnreadableError,
  artifactWordBlocks,
  pdfNeedsMountedPreview,
  supportsWordExport,
} from "./document-blocks"
import type { Artifact, ArtifactExportFormat } from "@/types"

export {
  ArtifactNotRasterisableError,
  ArtifactPreviewNotMountedError,
  ArtifactTooLargeToRasteriseError,
} from "./raster"
export {
  ArtifactNotebookUnreadableError,
  pdfNeedsMountedPreview,
  supportsWordExport,
} from "./document-blocks"
export { PdfUnsupportedCharactersError } from "@/lib/files/document-writer/pdf-text"
export { PdfFontUnavailableError } from "@/lib/files/document-writer/unicode-font"

/** The artifact's adapter does not offer the requested format. */
export class UnsupportedArtifactExportError extends Error {
  constructor(type: string, format: ArtifactExportFormat | "docx") {
    super(`artifact type ${type} cannot be exported as ${format}`)
    this.name = "UnsupportedArtifactExportError"
  }
}

/**
 * Whether exporting `artifact` as `format` captures its mounted preview: a PNG
 * always renders the preview (an SVG draws its source, but through the same
 * renderer), and a PDF does unless it is laid-out text. A failure of such an
 * export is explained as "check the preview".
 */
export function exportNeedsMountedPreview(
  artifact: Pick<Artifact, "type">,
  format: ArtifactExportFormat
): boolean {
  return format === "png" || (format === "pdf" && pdfNeedsMountedPreview(artifact))
}

const MIME_BY_FORMAT: Record<ArtifactExportFormat, string> = {
  raw: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
  png: "image/png",
  pdf: "application/pdf",
}

/** Strip characters a filename cannot carry, keeping the title readable. */
function safeBase(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "artifact"
}

export function artifactExportFilename(
  artifact: Pick<Artifact, "type" | "title" | "language">,
  format: ArtifactExportFormat
): string {
  const extension =
    format === "raw" ? getArtifactExtension(artifact.type, artifact.language) : format
  return `${safeBase(artifact.title)}.${extension}`
}

export interface RenderedArtifactExport {
  data: string | Blob
  mimeType: string
  filename: string
  /** What the file could not keep: only a laid-out Word or PDF file loses anything. */
  losses: DocumentLoss[]
}

/** How the save went, and what the saved file could not keep. */
export type ArtifactExportOutcome = SaveExportOutcome & { losses: DocumentLoss[] }

/** Produce the bytes for one export format without saving them. */
export async function renderArtifactExport(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content" | "language" | "metadata">,
  format: ArtifactExportFormat
): Promise<RenderedArtifactExport> {
  if (!getArtifactExportFormats(artifact).includes(format)) {
    throw new UnsupportedArtifactExportError(artifact.type, format)
  }
  const filename = artifactExportFilename(artifact, format)
  const mimeType = MIME_BY_FORMAT[format]

  if (format === "png") {
    const { renderArtifactToPngBlob } = await import("./raster")
    return { data: await renderArtifactToPngBlob(artifact), mimeType, filename, losses: [] }
  }
  if (format === "pdf") {
    const { renderArtifactToPdf } = await import("./pdf")
    const { data, losses } = await renderArtifactToPdf(artifact)
    return { data, mimeType, filename, losses }
  }
  // raw / html / svg are all the source text; only the extension and the mime
  // differ, and the adapter table already decided which of them are on offer.
  return { data: artifact.content, mimeType, filename, losses: [] }
}

/**
 * Render and save. Returns the saver's outcome so the caller can report *where*
 * the file went (or that the user cancelled), which is the whole reason
 * `saveExport` exists.
 */
export async function exportArtifact(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content" | "language" | "metadata">,
  format: ArtifactExportFormat
): Promise<ArtifactExportOutcome> {
  return saveRendered(await renderArtifactExport(artifact, format))
}

async function saveRendered(rendered: RenderedArtifactExport): Promise<ArtifactExportOutcome> {
  const outcome = await saveExport({
    filename: rendered.filename,
    data: rendered.data,
    mimeType: rendered.mimeType,
  })
  return { ...outcome, losses: rendered.losses }
}

const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/**
 * The artifact as a Word file. Only a document or code artifact has one
 * (`supportsWordExport`); anything else rejects with
 * `UnsupportedArtifactExportError` rather than writing its source into prose.
 */
export async function renderArtifactWordExport(
  artifact: Pick<Artifact, "type" | "title" | "content">
): Promise<RenderedArtifactExport> {
  if (!supportsWordExport(artifact)) throw new UnsupportedArtifactExportError(artifact.type, "docx")
  const { generateDocx } = await import("@/lib/files/document-writer")
  const doc = await generateDocx({ title: artifact.title, blocks: artifactWordBlocks(artifact) })
  return {
    data: doc.data,
    mimeType: WORD_MIME,
    filename: `${safeBase(artifact.title)}.docx`,
    losses: doc.losses,
  }
}

/** Render the Word file and save it, like `exportArtifact`. */
export async function exportArtifactAsWord(
  artifact: Pick<Artifact, "type" | "title" | "content">
): Promise<ArtifactExportOutcome> {
  return saveRendered(await renderArtifactWordExport(artifact))
}

/**
 * Why an export failed, as the panel explains it.
 *
 * - `unsupported-characters`: a text PDF holds characters none of its fonts
 *   can draw, emoji or Hangul say (`characters` names them).
 * - `pdf-font-unavailable`: the bundled font a text PDF needed for text
 *   beyond Latin-1 (Chinese, kana, Russian) could not be read.
 * - `notebook-unreadable`: a notebook is not notebook JSON.
 * - `preview`: the export renders the preview, and it was not ready or could
 *   not be captured; the remedy is to open Preview and check it.
 * - `failed`: anything else, which for a source-only export (code, a
 *   document) is no reason to send the user to a Preview it may not have.
 */
export type ArtifactExportFailure =
  | { reason: "unsupported-characters"; characters: string }
  | { reason: "pdf-font-unavailable" }
  | { reason: "notebook-unreadable" }
  | { reason: "preview" }
  | { reason: "failed" }

export function describeArtifactExportFailure(
  error: unknown,
  options: { neededPreview: boolean }
): ArtifactExportFailure {
  if (error instanceof PdfUnsupportedCharactersError) {
    return { reason: "unsupported-characters", characters: error.characters.join(" ") }
  }
  if (error instanceof PdfFontUnavailableError) return { reason: "pdf-font-unavailable" }
  if (error instanceof ArtifactNotebookUnreadableError) return { reason: "notebook-unreadable" }
  return options.neededPreview ? { reason: "preview" } : { reason: "failed" }
}
