/**
 * Canvas document export.
 *
 * One resolver answers both questions a menu has to ask about a document:
 * which formats it offers and how each one runs. `canvasExportArtifact`
 * projects the document onto the artifact the dock would export (the preview
 * projection for a chart, diagram or page, a `code` artifact for source with
 * no visual form), and both `getCanvasExportFormats` and
 * `exportCanvasDocument` read that same artifact. A menu entry is therefore
 * always one the exporter can carry out: a Python document's PDF is its source
 * laid out as text, exactly like a code artifact's.
 *
 * `raw` / `html` / `svg` are the buffer itself; `png` / `pdf` are rendered by
 * the shared artifact exporter (`lib/artifacts/export`). Saving goes through
 * `saveExport`, not an `<a download>` anchor, which silently no-ops inside a
 * mobile WebView.
 *
 * The result is a typed outcome so the caller can stay quiet on a cancelled
 * save dialog, say why a render failed, and tell a save failure apart from
 * both.
 */

import type {
  Artifact,
  ArtifactExportFormat,
  ArtifactLanguage,
  CanvasDocument,
} from "@/types/artifact/artifact"
import type { ArtifactExportFailure } from "@/lib/artifacts/export"
import { getArtifactExportFormats } from "@/components/artifacts/runtime-adapters"
import { loggers } from "@cognia/logging"
import { exportFilenameStem } from "@/lib/files/export-filename"
import { canvasDocumentToArtifact } from "./artifact-projection"

/** Formats serialized straight from the Canvas buffer, with no rendering. */
const TEXT_FORMATS: ReadonlySet<ArtifactExportFormat> = new Set(["raw", "html", "svg"])

/** Every format a Canvas document can be exported as. */
const DOWNLOADABLE_FORMATS: ReadonlySet<ArtifactExportFormat> = new Set([
  "raw",
  "html",
  "svg",
  "png",
  "pdf",
])

const LANGUAGE_EXTENSIONS: Record<ArtifactLanguage, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  plaintext: "txt",
  html: "html",
  css: "css",
  json: "json",
  markdown: "md",
  jsx: "jsx",
  tsx: "tsx",
  sql: "sql",
  bash: "sh",
  yaml: "yaml",
  xml: "xml",
  svg: "svg",
  mermaid: "mmd",
  latex: "tex",
}

/** File extension for a document's language (defaults to `txt`). */
export function extensionForLanguage(language: ArtifactLanguage): string {
  return LANGUAGE_EXTENSIONS[language] ?? "txt"
}

/**
 * The artifact a Canvas document exports as.
 *
 * `canvasDocumentToArtifact` answers a preview question and returns `null` for
 * a plain Python or JSON buffer, but such a document still exports the way a
 * `code` artifact does in the dock: its source, or a PDF of that source laid
 * out as selectable text. Every non-text document the preview cannot draw is
 * code, since any `text` document previews as Markdown.
 */
export function canvasExportArtifact(doc: CanvasDocument): Artifact {
  return (
    canvasDocumentToArtifact(doc) ?? {
      id: doc.id,
      sessionId: doc.sessionId,
      projectId: doc.projectId,
      messageId: `canvas:${doc.id}`,
      type: "code",
      title: doc.title,
      content: doc.content,
      language: doc.language,
      version: 1,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    }
  )
}

/** Formats a document can be exported as: what its export artifact's adapter offers. */
export function getCanvasExportFormats(doc: CanvasDocument): ArtifactExportFormat[] {
  return getArtifactExportFormats(canvasExportArtifact(doc)).filter((format) =>
    DOWNLOADABLE_FORMATS.has(format)
  )
}

/** The filename a given export would produce (pure — used by the UI + tests). */
export function canvasExportFilename(doc: CanvasDocument, format: ArtifactExportFormat): string {
  const ext = format === "raw" ? extensionForLanguage(doc.language) : format
  return `${exportFilenameStem(doc.title, "canvas-document")}.${ext}`
}

function mimeForFormat(format: ArtifactExportFormat): string {
  if (format === "html") return "text/html"
  if (format === "svg") return "image/svg+xml"
  return "text/plain"
}

export interface CanvasExportPayload {
  filename: string
  content: string
  mime: string
}

/** Pure serialization of a text-format export request (no DOM side effects). */
export function buildCanvasExportPayload(
  doc: CanvasDocument,
  format: ArtifactExportFormat
): CanvasExportPayload {
  return {
    filename: canvasExportFilename(doc, format),
    content: doc.content,
    mime: mimeForFormat(format),
  }
}

/**
 * What became of one export.
 *
 * - `saved`: written under `filename`; `location` is where the saver put it.
 * - `cancelled`: the user dismissed the save dialog. Not a failure.
 * - `unsupported`: the document does not offer `format`. A menu built from
 *   `getCanvasExportFormats` never asks for one.
 * - `render-error`: rendering the PNG / PDF failed, with the reason the
 *   artifact exporter gives (`preview` when the capture needed a preview that
 *   was not ready).
 * - `save-error`: the file was rendered and the saver could not write it.
 */
export type CanvasExportOutcome =
  | { kind: "saved"; filename: string; location: string }
  | { kind: "cancelled" }
  | { kind: "unsupported"; format: ArtifactExportFormat }
  | { kind: "render-error"; failure: ArtifactExportFailure }
  | { kind: "save-error"; filename: string; message: string }

/** Lazy: the renderers pull in html2canvas and jsPDF. */
const loadArtifactExporter = () => import("@/lib/artifacts/export")
type ArtifactExporter = Awaited<ReturnType<typeof loadArtifactExporter>>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render (when the format needs it) and save one export of a Canvas document.
 * Never throws: every way it can end is a `CanvasExportOutcome`.
 */
export async function exportCanvasDocument(
  doc: CanvasDocument,
  format: ArtifactExportFormat
): Promise<CanvasExportOutcome> {
  if (!getCanvasExportFormats(doc).includes(format)) {
    loggers.canvas.warn("canvas export: format not offered for this document", {
      documentId: doc.id,
      format,
    })
    return { kind: "unsupported", format }
  }

  const filename = canvasExportFilename(doc, format)
  let data: string | Blob
  let mimeType: string
  if (TEXT_FORMATS.has(format)) {
    const payload = buildCanvasExportPayload(doc, format)
    data = payload.content
    mimeType = payload.mime
  } else {
    const artifact = canvasExportArtifact(doc)
    const renderFailed = (error: unknown, failure: ArtifactExportFailure): CanvasExportOutcome => {
      loggers.canvas.warn("canvas export: render failed", {
        documentId: doc.id,
        format,
        error: errorMessage(error),
      })
      return { kind: "render-error", failure }
    }
    let exporter: ArtifactExporter
    try {
      exporter = await loadArtifactExporter()
    } catch (error) {
      return renderFailed(error, { reason: "failed" })
    }
    try {
      const rendered = await exporter.renderArtifactExport(artifact, format)
      data = rendered.data
      mimeType = rendered.mimeType
    } catch (error) {
      return renderFailed(
        error,
        exporter.describeArtifactExportFailure(error, {
          neededPreview: exporter.exportNeedsMountedPreview(artifact, format),
        })
      )
    }
  }

  try {
    // Imported at call time: `save-export` reaches the Tauri / Capacitor
    // platform layer, which drags a large graph into any module that touches
    // it — this file's own tests run in the light jest project.
    const { saveExport } = await import("@/lib/files/save-export")
    const outcome = await saveExport({ filename, data, mimeType })
    if (outcome.kind === "saved") {
      return { kind: "saved", filename: outcome.filename, location: outcome.location }
    }
    if (outcome.kind === "cancelled") return { kind: "cancelled" }
    loggers.canvas.warn("canvas export: save failed", {
      documentId: doc.id,
      format,
      error: outcome.message,
    })
    return { kind: "save-error", filename, message: outcome.message }
  } catch (error) {
    loggers.canvas.warn("canvas export: save failed", {
      documentId: doc.id,
      format,
      error: errorMessage(error),
    })
    return { kind: "save-error", filename, message: errorMessage(error) }
  }
}

/** Copy the document buffer to the clipboard. Returns whether it succeeded. */
export async function copyCanvasDocumentToClipboard(doc: CanvasDocument): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard?.writeText) return false
  try {
    await clipboard.writeText(doc.content)
    return true
  } catch (err) {
    loggers.canvas.warn("canvas export: clipboard copy failed", {
      documentId: doc.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
