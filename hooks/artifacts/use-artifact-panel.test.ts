/**
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from "@testing-library/react"
import { useEffect } from "react"

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

jest.mock("@/lib/artifacts/export/raster", () => ({
  ...jest.requireActual("@/lib/artifacts/export/raster"),
  renderArtifactToPngBlob: jest.fn(async () => new Blob(["png"], { type: "image/png" })),
  captureArtifactToPngBlob: jest.fn(),
}))
jest.mock("@/lib/artifacts/export/pdf", () => ({
  ...jest.requireActual("@/lib/artifacts/export/pdf"),
  renderArtifactToPdfBlob: jest.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: jest.fn(),
  openPath: jest.fn(),
}))

const saveExportMock = jest.fn(
  async (_opts?: unknown): Promise<{ kind: string; [k: string]: unknown }> => ({
    kind: "saved",
    platform: "web",
    location: "downloads",
    filename: "Page.html",
  })
)
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (opts: unknown) => saveExportMock(opts),
}))

const clipboardWriteTextMock = jest.fn(async (_v?: string): Promise<{ kind: string }> => ({
  kind: "unsupported",
}))
jest.mock("@/lib/capacitor/clipboard", () => ({
  writeText: (v: string) => clipboardWriteTextMock(v),
}))

const generateDocxMock = jest.fn(async (_o?: unknown) => ({
  data: new Blob(["docx"]),
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  filename: "Page.docx",
}))
jest.mock("@/lib/files/document-writer", () => ({
  ...jest.requireActual("@/lib/files/document-writer"),
  generateDocx: (o: unknown) => generateDocxMock(o),
}))

import { useArtifactPanelState } from "./use-artifact-panel"
import { ArtifactNotebookUnreadableError } from "@/lib/artifacts/export/document-blocks"
import { PdfUnsupportedCharactersError } from "@/lib/files/document-writer/pdf-text"
import { PdfFontUnavailableError } from "@/lib/files/document-writer/unicode-font"
import { registerArtifactRenderer } from "@/lib/artifacts/renderer-registry"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactDraftStore } from "@/stores/artifact/artifact-draft-store"
import { requestArtifactPreview } from "@/lib/artifacts/preview-view-request"
import { useChatStore } from "@/stores/chat"
import {
  renderArtifactToPngBlob,
  captureArtifactToPngBlob,
  ArtifactPreviewNotMountedError,
} from "@/lib/artifacts/export/raster"
import { renderArtifactToPdfBlob } from "@/lib/artifacts/export/pdf"
import {
  registerArtifactPreviewNode,
  getArtifactPreviewNode,
} from "@/lib/artifacts/preview-registry"
import { toast } from "sonner"
import { captureArtifactImage } from "@/lib/artifacts/capture"
import { isArtifactPreviewRequested } from "@/lib/artifacts/preview-view-request"
import {
  registerArtifactFrameCapturer,
  hasArtifactFrameCapturer,
} from "@/lib/artifacts/frame-capture-registry"

beforeEach(() => {
  localStorage.clear()
  jest.mocked(toast.error).mockClear()
  generateDocxMock.mockClear()
  // The active artifact is bucketed per conversation, so the panel only
  // resolves one once a conversation is on screen.
  useChatStore.setState({ activeSessionId: "s" })
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactIdBySession: {},
    artifactVersions: {},
    pendingReviews: {},
    artifactWorkspace: {
      scope: "session",
      sessionId: null,
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
      recentArtifactIds: [],
      returnContext: null,
    },
    canvasDocuments: {},
    activeCanvasId: null,
  })
})

function makeArtifact() {
  return useArtifactStore.getState().createArtifact({
    sessionId: "s",
    messageId: "m",
    type: "html",
    title: "Page",
    content: "<!DOCTYPE html><html><body></body></html>",
    language: "html",
  })
}

describe("useArtifactPanelState", () => {
  it("B18 agent capture reveals a closed Code panel and mounts the React capturer", async () => {
    const a = makeArtifact()
    useArtifactStore.getState().updateArtifact(a.id, { type: "react" })
    const artifact = useArtifactStore.getState().artifacts[a.id]
    jest.mocked(captureArtifactToPngBlob).mockImplementation(async () => {
      if (!hasArtifactFrameCapturer(a.id)) throw new ArtifactPreviewNotMountedError(a.id)
      return new Blob(["png"], { type: "image/png" })
    })
    const { result } = renderHook(() => {
      const panel = useArtifactPanelState()
      useEffect(() => {
        if (panel.viewMode !== "preview") return
        return registerArtifactFrameCapturer(a.id, {
          live: true,
          shows: () => artifact.content,
          capture: async () => ({ html: "<p>Painted</p>", width: 100, height: 100 }),
        })
      }, [panel.viewMode])
      return panel
    })
    expect(result.current.viewMode).toBe("code")
    let capturing!: ReturnType<typeof captureArtifactImage>
    act(() => {
      capturing = captureArtifactImage(artifact)
    })
    await waitFor(() => expect(result.current.viewMode).toBe("preview"))
    await act(async () => {
      await expect(capturing).resolves.toMatchObject({ data: "cG5n" })
    })
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(captureArtifactToPngBlob).toHaveBeenCalledTimes(2)
    expect(isArtifactPreviewRequested(a.id)).toBe(false)
  })

  it("B18 reports a mount timeout and releases its pending Preview request", async () => {
    jest.useFakeTimers()
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    let exporting!: Promise<void>
    act(() => {
      exporting = result.current.handleExportAs("png")
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000)
      await exporting
    })
    expect(toast.error).toHaveBeenCalledWith("exportFailed")
    expect(isArtifactPreviewRequested(a.id)).toBe(false)
    jest.useRealTimers()
  })

  it.each(["png", "pdf"] as const)("B18 mounts Preview before exporting %s", async (format) => {
    const a = makeArtifact()
    const render = format === "png" ? renderArtifactToPngBlob : renderArtifactToPdfBlob
    const mountedAtExport: boolean[] = []
    jest.mocked(render).mockImplementationOnce(async () => {
      mountedAtExport.push(getArtifactPreviewNode(a.id) !== null)
      return new Blob([format])
    })
    const { result } = renderHook(() => {
      const panel = useArtifactPanelState()
      useEffect(() => {
        if (panel.viewMode !== "preview") return
        const node = document.createElement("div")
        let unregister: (() => void) | undefined
        const mounting = setTimeout(() => {
          document.body.appendChild(node)
          unregister = registerArtifactPreviewNode(a.id, node, () => a.content)
        }, 20)
        return () => {
          clearTimeout(mounting)
          unregister?.()
          node.remove()
        }
      }, [panel.viewMode])
      return panel
    })
    let exporting!: Promise<void>
    act(() => {
      exporting = result.current.handleExportAs(format)
    })
    await act(async () => {
      await exporting
    })
    expect(result.current.viewMode).toBe("preview")
    expect(mountedAtExport).toEqual([true])
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }))
  })

  it("B18 surfaces an actionable localized export failure without an unhandled rejection", async () => {
    makeArtifact()
    saveExportMock.mockResolvedValueOnce({ kind: "error", message: "disk full" })
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await expect(result.current.handleExportAs("html")).resolves.toBeUndefined()
    })
    // Saving source text renders no preview, so the copy does not send the
    // user to one (it used to, even for code, which has no Preview tab).
    expect(toast.error).toHaveBeenCalledWith("exportFailedSource")
  })

  it.each(["code", "document", "jupyter"] as const)(
    "B18 exports %s PDF without requesting or mounting Preview",
    async (type) => {
      const artifact = makeArtifact()
      useArtifactStore.getState().updateArtifact(artifact.id, { type })
      const { result } = renderHook(() => useArtifactPanelState())
      const previewRequest = jest.fn()
      window.addEventListener("cognia:artifact-preview:request", previewRequest)
      jest.mocked(renderArtifactToPdfBlob).mockClear()
      try {
        expect(result.current.exportFormats).toContain("pdf")
        expect(result.current.exportFormats).not.toContain("png")
        expect(getArtifactPreviewNode(artifact.id)).toBeNull()
        await act(async () => {
          await result.current.handleExportAs("pdf")
          await result.current.handleDownloadAs("pdf")
        })
        expect(result.current.viewMode).toBe("code")
        expect(previewRequest).not.toHaveBeenCalled()
        expect(renderArtifactToPdfBlob).toHaveBeenCalledTimes(2)
        expect(toast.error).not.toHaveBeenCalled()
      } finally {
        window.removeEventListener("cognia:artifact-preview:request", previewRequest)
      }
    }
  )

  it("derives isPreviewable / panelMode for an HTML artifact", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.isPreviewable).toBe(true)
    expect(result.current.primaryActions).toContain("modeTabs")
    expect(result.current.primaryActions).toContain("close")
  })

  it("does not include modeTabs for non-previewable types", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "T",
      content: "x",
      language: "javascript",
    })
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.primaryActions).not.toContain("modeTabs")
  })

  it("handleEditMode flips viewMode to edit", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    expect(result.current.viewMode).toBe("edit")
  })

  it("handleSaveEdit persists changes and exits edit mode", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    act(() => result.current.handleEditorChange("<html>changed</html>"))
    act(() => result.current.handleSaveEdit())
    expect(result.current.viewMode).toBe("code")
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("<html>changed</html>")
  })

  it("handleCancelEdit drops changes", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    act(() => result.current.handleCancelEdit())
    expect(result.current.viewMode).toBe("code")
    expect(result.current.hasChanges).toBe(false)
  })

  describe("unsaved drafts (A01, C02)", () => {
    beforeEach(() => useArtifactDraftStore.setState({ drafts: {} }))

    function second() {
      return useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m2",
        type: "html",
        title: "Other",
        content: "<p>other</p>",
        language: "html",
      })
    }

    it("keeps the draft across a switch to another artifact and back", () => {
      const a = makeArtifact()
      const b = second()
      act(() => useArtifactStore.getState().setActiveArtifact(a.id, "s"))
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleEditMode())
      act(() => result.current.handleEditorChange("<p>unsaved</p>"))
      act(() => useArtifactStore.getState().setActiveArtifact(b.id, "s"))
      expect(result.current.viewMode).toBe("code")
      expect(result.current.editContent).toBe("<p>other</p>")
      act(() => useArtifactStore.getState().setActiveArtifact(a.id, "s"))
      // It opens back where the user left it, with the text they typed.
      expect(result.current.viewMode).toBe("edit")
      expect(result.current.editContent).toBe("<p>unsaved</p>")
      expect(result.current.hasChanges).toBe(true)
      expect(useArtifactStore.getState().artifacts[a.id].content).toBe(a.content)
    })

    it("keeps the draft when the panel is remounted", () => {
      makeArtifact()
      const first = renderHook(() => useArtifactPanelState())
      act(() => first.result.current.handleEditMode())
      act(() => first.result.current.handleEditorChange("<p>kept</p>"))
      first.unmount()
      const { result } = renderHook(() => useArtifactPanelState())
      expect(result.current.viewMode).toBe("edit")
      expect(result.current.editContent).toBe("<p>kept</p>")
    })

    it("a background Preview request leaves Edit without losing the draft", () => {
      const a = makeArtifact()
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleEditMode())
      act(() => result.current.handleEditorChange("<p>experiment</p>"))
      let release!: () => void
      act(() => {
        release = requestArtifactPreview(a.id)
      })
      expect(result.current.viewMode).toBe("preview")
      act(() => release())
      act(() => result.current.handleEditMode())
      expect(result.current.editContent).toBe("<p>experiment</p>")
      expect(result.current.hasChanges).toBe(true)
    })

    it("does not save over a revision committed while the draft was open", () => {
      const a = makeArtifact()
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleEditMode())
      act(() => result.current.handleEditorChange("<p>local</p>"))
      act(() => useArtifactStore.getState().updateArtifact(a.id, { content: "<p>v2</p>" }))
      expect(result.current.draftConflict).toBe(true)
      act(() => result.current.handleSaveEdit())
      expect(useArtifactStore.getState().artifacts[a.id].content).toBe("<p>v2</p>")
      expect(result.current.viewMode).toBe("edit")
      expect(result.current.editContent).toBe("<p>local</p>")
    })

    it("overwrite keeps the draft and snapshots the revision it replaces", () => {
      const a = makeArtifact()
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleEditMode())
      act(() => result.current.handleEditorChange("<p>local</p>"))
      act(() => useArtifactStore.getState().updateArtifact(a.id, { content: "<p>v2</p>" }))
      act(() => result.current.handleOverwriteDraft())
      const state = useArtifactStore.getState()
      expect(state.artifacts[a.id].content).toBe("<p>local</p>")
      expect(state.getArtifactVersions(a.id).map((v) => v.content)).toContain("<p>v2</p>")
      expect(result.current.draftConflict).toBe(false)
      expect(useArtifactDraftStore.getState().drafts[a.id]).toBeUndefined()
    })

    it("discard drops the draft and leaves the newer revision in place", () => {
      const a = makeArtifact()
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleEditMode())
      act(() => result.current.handleEditorChange("<p>local</p>"))
      act(() => useArtifactStore.getState().updateArtifact(a.id, { content: "<p>v2</p>" }))
      act(() => result.current.handleDiscardDraft())
      expect(useArtifactStore.getState().artifacts[a.id].content).toBe("<p>v2</p>")
      expect(result.current.viewMode).toBe("code")
      act(() => result.current.handleEditMode())
      expect(result.current.editContent).toBe("<p>v2</p>")
    })

    it("cancel drops the draft", () => {
      const a = makeArtifact()
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleEditMode())
      act(() => result.current.handleEditorChange("<p>gone</p>"))
      act(() => result.current.handleCancelEdit())
      expect(useArtifactDraftStore.getState().drafts[a.id]).toBeUndefined()
      act(() => result.current.handleEditMode())
      expect(result.current.editContent).toBe(a.content)
    })
  })

  it("toggleFullscreen flips isFullscreen", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.toggleFullscreen())
    expect(result.current.isFullscreen).toBe(true)
  })

  it("handleCopy falls back to navigator.clipboard when the native plugin is unsupported", async () => {
    clipboardWriteTextMock.mockResolvedValueOnce({ kind: "unsupported" })
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleCopy()
    })
    expect(writeText).toHaveBeenCalledWith(a.content)
  })

  it("handleCopy uses the native clipboard when available (no navigator fallback)", async () => {
    clipboardWriteTextMock.mockResolvedValueOnce({ kind: "ok" })
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleCopy()
    })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(a.content)
    expect(writeText).not.toHaveBeenCalled()
  })

  it("handleOpenInCanvas creates a canvas document", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleOpenInCanvas())
    expect(Object.keys(useArtifactStore.getState().canvasDocuments).length).toBeGreaterThan(0)
  })

  it("auto-enters review mode when a pending proposal appears and exposes it", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.viewMode).toBe("code")
    act(() => {
      useArtifactStore
        .getState()
        .proposeArtifactUpdate(a.id, "<!DOCTYPE html><html><body>changed</body></html>")
    })
    expect(result.current.viewMode).toBe("review")
    expect(result.current.pendingReview).not.toBeNull()
  })

  it("leaves review mode for code once the proposal is resolved", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => {
      useArtifactStore
        .getState()
        .proposeArtifactUpdate(a.id, "<!DOCTYPE html><html><body>changed</body></html>")
    })
    expect(result.current.viewMode).toBe("review")
    act(() => useArtifactStore.getState().rejectArtifactReview(a.id))
    expect(result.current.viewMode).toBe("code")
    expect(result.current.pendingReview).toBeNull()
  })

  it("does not yank the user out of edit mode when a proposal appears", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    expect(result.current.viewMode).toBe("edit")
    act(() => {
      useArtifactStore
        .getState()
        .proposeArtifactUpdate(a.id, "<!DOCTYPE html><html><body>changed</body></html>")
    })
    expect(result.current.viewMode).toBe("edit")
  })

  it("handleDownload saves via the cross-platform saveExport (works on mobile WebView)", async () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleDownload()
    })
    expect(saveExportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: `${a.title}.html`,
        data: a.content,
        mimeType: "text/html;charset=utf-8",
      })
    )
  })

  it("does not offer text exports for content a plugin renderer owns", async () => {
    const a = makeArtifact()
    const dispose = registerArtifactRenderer("test-plugin-renderer", {
      id: "test-plugin-renderer",
      kind: "test-plugin/payload",
      mount: () => ({ dispose: () => {} }),
    })
    try {
      act(() => {
        useArtifactStore.getState().updateArtifact(a.id, {
          metadata: {
            ...a.metadata,
            plugin: { kind: "test-plugin/payload", schemaVersion: 1, ownerPluginId: "test-plugin" },
          },
        })
      })
      const { result } = renderHook(() => useArtifactPanelState())
      expect(result.current.canDownloadAsDocument).toBe(false)
      expect(result.current.exportFormats).toEqual(["raw"])
      await act(async () => {
        await result.current.handleDownloadAs("docx")
      })
      expect(generateDocxMock).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it("treats a plugin's JSON model as plugin-owned even when its renderer is not loaded", async () => {
    const a = makeArtifact()
    act(() => {
      useArtifactStore.getState().updateArtifact(a.id, {
        language: "json",
        content: '{"schemaVersion":1}',
        metadata: {
          ...a.metadata,
          plugin: {
            kind: "cognia-documents/document",
            schemaVersion: 1,
            ownerPluginId: "cognia-documents",
          },
        },
      })
    })
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.canDownloadAsDocument).toBe(false)
    expect(result.current.exportFormats).toEqual(["raw"])
    jest.mocked(renderArtifactToPdfBlob).mockClear()
    await act(async () => {
      await result.current.handleDownloadAs("pdf")
    })
    expect(renderArtifactToPdfBlob).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("saves a code artifact's Word file as one verbatim code block (A07)", async () => {
    const a = makeArtifact()
    const source = "# a comment, not a heading\ndef f():\n    return 1"
    act(() => {
      useArtifactStore
        .getState()
        .updateArtifact(a.id, { type: "code", language: "python", content: source })
    })
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.canDownloadAsDocument).toBe(true)
    saveExportMock.mockClear()
    await act(async () => {
      await result.current.handleDownloadAs("docx")
    })
    expect(generateDocxMock).toHaveBeenCalledWith({
      title: "Page",
      blocks: [{ kind: "code", text: source }],
    })
    expect(saveExportMock).toHaveBeenCalledWith(expect.objectContaining({ filename: "Page.docx" }))
  })

  it.each(["html", "chart", "mermaid", "jupyter"] as const)(
    "offers no Word file for a %s artifact, whose source is not its text (A07)",
    async (type) => {
      const a = makeArtifact()
      act(() => useArtifactStore.getState().updateArtifact(a.id, { type }))
      const { result } = renderHook(() => useArtifactPanelState())
      expect(result.current.canDownloadAsDocument).toBe(false)
      await act(async () => {
        await result.current.handleDownloadAs("docx")
      })
      expect(generateDocxMock).not.toHaveBeenCalled()
    }
  )

  it("names the characters a text PDF cannot draw instead of blaming the preview (C09)", async () => {
    const a = makeArtifact()
    act(() => useArtifactStore.getState().updateArtifact(a.id, { type: "document" }))
    jest
      .mocked(renderArtifactToPdfBlob)
      .mockRejectedValueOnce(new PdfUnsupportedCharactersError(["中", "文"]))
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleExportAs("pdf")
    })
    expect(toast.error).toHaveBeenCalledWith("exportUnsupportedCharacters")
  })

  it("says the PDF font could not load instead of blaming the source save (C09)", async () => {
    const a = makeArtifact()
    act(() => useArtifactStore.getState().updateArtifact(a.id, { type: "document" }))
    jest
      .mocked(renderArtifactToPdfBlob)
      .mockRejectedValueOnce(new PdfFontUnavailableError(new Error("HTTP 404")))
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleExportAs("pdf")
    })
    expect(toast.error).toHaveBeenCalledWith("exportPdfFontUnavailable")
  })

  it("reports an unreadable notebook as such (C09)", async () => {
    const a = makeArtifact()
    act(() => useArtifactStore.getState().updateArtifact(a.id, { type: "jupyter" }))
    jest
      .mocked(renderArtifactToPdfBlob)
      .mockRejectedValueOnce(new ArtifactNotebookUnreadableError(a.id))
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleExportAs("pdf")
    })
    expect(toast.error).toHaveBeenCalledWith("exportNotebookUnreadable")
  })

  it("does not send a code export failure to a Preview the artifact lacks", async () => {
    const a = makeArtifact()
    act(() => useArtifactStore.getState().updateArtifact(a.id, { type: "code" }))
    jest.mocked(renderArtifactToPdfBlob).mockRejectedValueOnce(new Error("disk full"))
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleExportAs("pdf")
    })
    expect(toast.error).toHaveBeenCalledWith("exportFailedSource")
  })
})
