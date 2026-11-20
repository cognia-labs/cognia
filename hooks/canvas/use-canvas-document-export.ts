"use client"

/**
 * Export a Canvas document and tell the user how it went.
 *
 * The export menu and the document rail both export, and both used to read
 * the result as "a filename or nothing": a cancelled save dialog, a render
 * failure and a failed write all looked the same, the menu blamed rendering
 * for all of them on PNG / PDF, and the rail said nothing at all. This hook
 * is the one place that turns a `CanvasExportOutcome` into feedback, so both
 * entry points say the same thing.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { exportCanvasDocument, type CanvasExportOutcome } from "@/lib/canvas/document-export"
import type { ArtifactExportFormat, CanvasDocument } from "@/types/artifact/artifact"

/** A message key under `canvas.exportMenu` and its values. */
export interface CanvasExportNotice {
  tone: "success" | "error"
  key:
    | "downloaded"
    | "renderFailed"
    | "renderNeedsPreview"
    | "unsupportedCharacters"
    | "pdfFontUnavailable"
    | "saveFailed"
    | "formatUnavailable"
  values?: Record<string, string>
}

/**
 * The notice for an outcome, or `null` when there is nothing to say: a
 * dismissed save dialog is the user's own choice, not a failure.
 */
export function canvasExportNotice(outcome: CanvasExportOutcome): CanvasExportNotice | null {
  switch (outcome.kind) {
    case "saved":
      return { tone: "success", key: "downloaded", values: { filename: outcome.filename } }
    case "cancelled":
      return null
    case "unsupported":
      return { tone: "error", key: "formatUnavailable" }
    case "save-error":
      return { tone: "error", key: "saveFailed", values: { filename: outcome.filename } }
    case "render-error":
      switch (outcome.failure.reason) {
        case "unsupported-characters":
          return {
            tone: "error",
            key: "unsupportedCharacters",
            values: { characters: outcome.failure.characters },
          }
        case "pdf-font-unavailable":
          return { tone: "error", key: "pdfFontUnavailable" }
        case "preview":
          return { tone: "error", key: "renderNeedsPreview" }
        // A Canvas document never projects onto a notebook, so an unreadable
        // notebook can only mean the render failed for a reason it did not name.
        case "notebook-unreadable":
        case "failed":
          return { tone: "error", key: "renderFailed" }
      }
  }
}

/** `exportDocument(doc, format)` exports and shows the outcome's notice. */
export function useCanvasDocumentExport(): (
  doc: CanvasDocument,
  format: ArtifactExportFormat
) => Promise<CanvasExportOutcome> {
  const t = useTranslations("canvas.exportMenu")
  return useCallback(
    async (doc, format) => {
      const outcome = await exportCanvasDocument(doc, format)
      const notice = canvasExportNotice(outcome)
      if (notice) {
        const message = t(notice.key, notice.values)
        if (notice.tone === "success") toast.success(message)
        else toast.error(message)
      }
      return outcome
    },
    [t]
  )
}
