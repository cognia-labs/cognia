/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"

jest.mock("@/lib/canvas/document-export", () => ({ exportCanvasDocument: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { exportCanvasDocument, type CanvasExportOutcome } from "@/lib/canvas/document-export"
import type { CanvasDocument } from "@/types/artifact/artifact"
import { canvasExportNotice, useCanvasDocumentExport } from "./use-canvas-document-export"

const exportMock = exportCanvasDocument as jest.Mock
const toastMock = toast as unknown as { success: jest.Mock; warning: jest.Mock; error: jest.Mock }

const doc = {
  id: "doc-1",
  sessionId: "s1",
  title: "Doc",
  content: "x",
  language: "markdown",
  type: "text",
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as CanvasDocument

beforeEach(() => jest.clearAllMocks())

describe("canvasExportNotice", () => {
  it.each<[CanvasExportOutcome, ReturnType<typeof canvasExportNotice>]>([
    [
      { kind: "saved", filename: "Doc.md", location: "/x/Doc.md", losses: [] },
      { tone: "success", key: "downloaded", values: { filename: "Doc.md" } },
    ],
    [
      {
        kind: "saved",
        filename: "Doc.pdf",
        location: "/x/Doc.pdf",
        losses: [{ kind: "image", count: 2 }],
      },
      {
        tone: "warning",
        key: "downloadedWithLosses",
        values: { filename: "Doc.pdf" },
        losses: [{ kind: "image", count: 2 }],
      },
    ],
    [{ kind: "cancelled" }, null],
    [
      { kind: "unsupported", format: "png" },
      { tone: "error", key: "formatUnavailable" },
    ],
    [
      { kind: "save-error", filename: "Doc.md", message: "EACCES" },
      { tone: "error", key: "saveFailed", values: { filename: "Doc.md" } },
    ],
    [
      { kind: "render-error", failure: { reason: "unsupported-characters", characters: "😀 한" } },
      { tone: "error", key: "unsupportedCharacters", values: { characters: "😀 한" } },
    ],
    [
      { kind: "render-error", failure: { reason: "pdf-font-unavailable" } },
      { tone: "error", key: "pdfFontUnavailable" },
    ],
    [
      { kind: "render-error", failure: { reason: "preview" } },
      { tone: "error", key: "renderNeedsPreview" },
    ],
    [
      { kind: "render-error", failure: { reason: "failed" } },
      { tone: "error", key: "renderFailed" },
    ],
    [
      { kind: "render-error", failure: { reason: "notebook-unreadable" } },
      { tone: "error", key: "renderFailed" },
    ],
  ])("%j → %j", (outcome, notice) => {
    expect(canvasExportNotice(outcome)).toEqual(notice)
  })
})

describe("useCanvasDocumentExport", () => {
  it("exports, toasts the saved filename and returns the outcome", async () => {
    const saved = { kind: "saved", filename: "Doc.md", location: "/x/Doc.md", losses: [] }
    exportMock.mockResolvedValue(saved)
    const { result } = renderHook(() => useCanvasDocumentExport())

    await expect(result.current(doc, "raw")).resolves.toEqual(saved)
    expect(exportMock).toHaveBeenCalledWith(doc, "raw")
    expect(toastMock.success).toHaveBeenCalledWith("Downloaded Doc.md")
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it("shows a failure as an error and a cancelled dialog not at all", async () => {
    const { result } = renderHook(() => useCanvasDocumentExport())

    exportMock.mockResolvedValueOnce({ kind: "cancelled" })
    await result.current(doc, "raw")
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()

    exportMock.mockResolvedValueOnce({ kind: "render-error", failure: { reason: "failed" } })
    await result.current(doc, "pdf")
    expect(toastMock.error).toHaveBeenCalledWith("Couldn't render the document")
  })

  it("warns, naming what the saved file could not keep (F11)", async () => {
    exportMock.mockResolvedValueOnce({
      kind: "saved",
      filename: "Doc.pdf",
      location: "/x/Doc.pdf",
      losses: [
        { kind: "image", count: 2 },
        { kind: "html", count: 3 },
      ],
    })
    const { result } = renderHook(() => useCanvasDocumentExport())
    await result.current(doc, "pdf")
    // The test formatter joins a list with commas.
    expect(toastMock.warning).toHaveBeenCalledWith(
      "Downloaded Doc.pdf, but it doesn't keep everything: 2 images are written as their descriptions and addresses, 3 HTML tags are written as text."
    )
    expect(toastMock.success).not.toHaveBeenCalled()
  })
})
