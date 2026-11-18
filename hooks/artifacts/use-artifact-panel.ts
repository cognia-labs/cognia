/**
 * useArtifactPanelState - Extracted state and logic for ArtifactPanel.
 *
 * cognia-next adapts the upstream hook by:
 *  - swapping `useNativeStore.isDesktop` for `isTauri()`
 *  - using `lib/tauri/opener` (revealInExplorer / openPath)
 *  - dropping the Designer subsystem entirely: "Edit in Canvas" is the visual
 *    authoring surface here, and it reopens the document the artifact was
 *    already sent to rather than minting a new one
 *  - using cognia-next's `downloadFile(filename, content, mimeType)` signature
 */

"use client"

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import { useShallow } from "zustand/react/shallow"
import { useTranslations } from "next-intl"
import { useMediaQuery } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  isDraftConflicted,
  isDraftDirty,
  useArtifactDraftStore,
} from "@/stores/artifact/artifact-draft-store"
import { useActiveArtifactId } from "@/hooks/artifacts/use-session-artifacts"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { revealInExplorer, openPath } from "@/lib/tauri/opener"
import { saveExport } from "@/lib/files/save-export"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { allRootPaths } from "@/lib/workspace/roots"
import { resolveSessionExecutionRoot } from "@/lib/workspace/session-root"
import { useProjectStore } from "@/stores/project/project-store"
import { useChatStore } from "@/stores/chat"
import { getSession } from "@/lib/db/sessions"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { saveGeneratedDocument, type DocFormat } from "@/lib/files/document-writer"
import { writeText as clipboardWriteText } from "@/lib/capacitor/clipboard"
import { canPreview, resolveRegisteredArtifactRenderer } from "@/lib/artifacts"
import { revealCanvasDocument } from "@/lib/artifacts/reveal"
import { createArtifactTabDocument } from "@/lib/artifacts/open-in-new-tab"
import { waitForArtifactPreview } from "@/lib/artifacts/capture"
import { pdfNeedsMountedPreview } from "@/lib/artifacts/export/pdf"
import {
  isArtifactPreviewRequested,
  onArtifactPreviewRequest,
} from "@/lib/artifacts/preview-view-request"
import { loggers } from "@cognia/logging"
import {
  getArtifactExportFormats,
  getPreferredArtifactExportFormat,
  isPluginModelArtifact,
} from "@/components/artifacts/runtime-adapters"
import {
  artifactExportFilename,
  exportArtifact,
  renderArtifactExport,
} from "@/lib/artifacts/export"
import type {
  ArtifactAuthoringOrigin,
  ArtifactExportFormat,
  ArtifactWorkspaceReturnContext,
  CanvasDocument,
} from "@/types"

type ArtifactPanelAction =
  | "modeTabs"
  | "edit"
  | "canvas"
  | "fullscreen"
  | "close"
  | "copy"
  | "download"
  | "openInNewTab"
  | "revealInExplorer"
  | "saveToProject"
  | "versionHistory"

/** Artifact view modes. `split` (code + live preview side-by-side) is the wide
 * docked-panel Codex experience; it is only offered for previewable types. */
export type ArtifactViewMode = "code" | "preview" | "edit" | "review" | "split"

export function useArtifactPanelState() {
  const t = useTranslations("artifacts")
  const tCommon = useTranslations("common")
  const router = useRouter()
  const pathname = usePathname()

  // Store state - using useShallow for optimized subscriptions
  const { artifacts, artifactWorkspace } = useArtifactStore(
    useShallow((state) => ({
      artifacts: state.artifacts,
      artifactWorkspace: state.artifactWorkspace,
    }))
  )
  const activeArtifactId = useActiveArtifactId()
  // Subscribe to only the active artifact's pending review — selecting the
  // whole `pendingReviews` map would re-render the panel whenever a proposal
  // lands/resolves on any *other* artifact.
  const pendingReview = useArtifactStore((state) =>
    activeArtifactId ? (state.pendingReviews[activeArtifactId] ?? null) : null
  )

  // Store actions - using useShallow for stable references
  const {
    closePanel,
    updateArtifact,
    saveArtifactVersion,
    createCanvasDocument,
    setArtifactWorkspaceReturnContext,
  } = useArtifactStore(
    useShallow((state) => ({
      closePanel: state.closePanel,
      updateArtifact: state.updateArtifact,
      saveArtifactVersion: state.saveArtifactVersion,
      createCanvasDocument: state.createCanvasDocument,
      setArtifactWorkspaceReturnContext: state.setArtifactWorkspaceReturnContext,
    }))
  )

  const canvasDocuments = useArtifactStore((state) => state.canvasDocuments)
  const activeArtifact = activeArtifactId ? artifacts[activeArtifactId] : null
  const theme = useSettingsStore((state) => state.settings?.theme)
  const defaultPanelMode = useSettingsStore((state) => state.settings?.artifacts?.defaultPanelMode)
  const isPreviewable = activeArtifact ? canPreview(activeArtifact.type) : false
  const initialViewMode = defaultPanelMode === "preview" && isPreviewable ? "preview" : "code"
  const isDesktop = isTauri()
  const isMobileViewport = useMediaQuery("(max-width: 639px)")
  const isTabletViewport = useMediaQuery("(min-width: 640px) and (max-width: 1023px)")
  // The unsaved edit buffer lives in its own store, keyed by artifact, so it
  // survives this panel leaving edit mode, the dock switching tabs, and the
  // panel being remounted (see `artifact-draft-store.ts`).
  const draft = useArtifactDraftStore((state) =>
    activeArtifactId ? state.drafts[activeArtifactId] : undefined
  )
  const beginDraft = useArtifactDraftStore((state) => state.beginDraft)
  const updateDraft = useArtifactDraftStore((state) => state.updateDraft)
  const clearDraft = useArtifactDraftStore((state) => state.clearDraft)
  // An artifact with a draft opens back in Edit: that is where the user left it.
  const openingViewMode: ArtifactViewMode = draft ? "edit" : initialViewMode
  // `mode: null` follows the opening mode (the Settings default, or Edit for a
  // draft) until the user — or a capture's Preview request — picks one. Read
  // live, a default changed while the panel sat mounted applies the next time
  // it is looked at; the `panelOpen` reset that did this before followed a flag
  // the docked surfaces no longer drive.
  const [viewState, setViewState] = useState<{
    artifactId: string | null
    mode: ArtifactViewMode | null
  }>({ artifactId: activeArtifactId, mode: null })
  // Reset synchronously so a previous artifact's Preview/Edit never paints for
  // the newly selected artifact. A user's tab choice survives ordinary renders.
  if (viewState.artifactId !== activeArtifactId) {
    setViewState({ artifactId: activeArtifactId, mode: null })
  }
  const viewMode = viewState.mode ?? openingViewMode
  const setViewMode = useCallback((mode: ArtifactViewMode) => {
    setViewState((state) => ({ ...state, mode }))
  }, [])
  const [copied, setCopied] = useState(false)
  const editContent = draft?.content ?? activeArtifact?.content ?? ""
  const hasChanges = isDraftDirty(draft)
  /** The committed content moved on since this draft was started. */
  const draftConflict = isDraftConflicted(draft, activeArtifact?.content)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [lastDownloadPath, setLastDownloadPath] = useState<string | null>(null)

  // A capture (the agent's `artifact_capture`, or an export that needs pixels)
  // can ask this panel to show its Preview. Leaving Edit for it is safe: the
  // draft is kept, and Edit resumes it.
  useEffect(() => {
    if (!activeArtifactId || !isPreviewable) return
    const showRequestedPreview = (id: string) => {
      if (id === activeArtifactId) setViewMode("preview")
    }
    const unsubscribe = onArtifactPreviewRequest(showRequestedPreview)
    if (isArtifactPreviewRequested(activeArtifactId)) showRequestedPreview(activeArtifactId)
    return unsubscribe
  }, [activeArtifactId, isPreviewable, setViewMode])

  // Auto-enter the review surface when a fresh AI-revision proposal appears,
  // and leave it once the proposal is resolved (applied/rejected). Keyed on the
  // review id so the user can still click the code/preview tabs to peek without
  // being yanked back, and a re-diff (new id) re-enters review.
  const lastReviewIdRef = useRef<string | null>(null)
  useEffect(() => {
    const reviewId = pendingReview?.id ?? null
    if (activeArtifactId && isArtifactPreviewRequested(activeArtifactId)) {
      lastReviewIdRef.current = reviewId
      return
    } else if (reviewId && reviewId !== lastReviewIdRef.current && viewMode !== "edit") {
      setViewMode("review")
    } else if (!reviewId && lastReviewIdRef.current && viewMode === "review") {
      setViewMode("code")
    }
    lastReviewIdRef.current = reviewId
  }, [activeArtifactId, pendingReview, viewMode, setViewMode])

  const buildReturnContext = useCallback(
    (authoringOrigin: ArtifactAuthoringOrigin): ArtifactWorkspaceReturnContext | null => {
      if (!activeArtifact) {
        return null
      }

      return {
        scope: artifactWorkspace.scope,
        sessionId: artifactWorkspace.sessionId,
        searchQuery: artifactWorkspace.searchQuery,
        typeFilter: artifactWorkspace.typeFilter,
        runtimeFilter: artifactWorkspace.runtimeFilter,
        activeArtifactId: activeArtifact.id,
        authoringOrigin,
        workingRevisionUpdatedAt: activeArtifact.updatedAt,
      }
    },
    [activeArtifact, artifactWorkspace]
  )

  /** Mint a Canvas copy of the active artifact and open it. */
  const createCanvasFromArtifact = useCallback(
    (returnContext: ArtifactWorkspaceReturnContext | null) => {
      if (!activeArtifact) return
      const docId = createCanvasDocument({
        title: activeArtifact.title,
        content: activeArtifact.content,
        language: activeArtifact.language || "javascript",
        type: "code",
        sourceArtifactId: activeArtifact.id,
        returnContext,
        authoringOrigin: "artifact-panel",
        createdBy: "user",
      })
      if (revealCanvasDocument(docId) && pathname !== "/") router.push("/")
      loggers.ui.info("artifacts.action.open-in-canvas", {
        artifactId: activeArtifact.id,
        canvasId: docId,
      })
    },
    [activeArtifact, createCanvasDocument, pathname, router]
  )

  // Handlers
  const handleOpenInCanvas = useCallback(() => {
    if (!activeArtifact) return
    const returnContext = buildReturnContext("artifact-panel")
    setArtifactWorkspaceReturnContext(returnContext)

    // Reopen the document this artifact was already sent to. Without this the
    // action minted a fresh copy every time, so a user who alternated between
    // the panel and the canvas accumulated duplicates and lost their edits to
    // whichever copy they had stopped looking at. A link pointing at a deleted
    // document falls through to creating a new one.
    const existingId = findCanvasDocumentForArtifact(
      activeArtifact.id,
      activeArtifact.metadata?.derivedFromCanvasDocumentId,
      canvasDocuments
    )
    if (existingId) {
      if (revealCanvasDocument(existingId)) {
        if (pathname !== "/") router.push("/")
        loggers.ui.info("artifacts.action.open-in-canvas", {
          artifactId: activeArtifact.id,
          canvasId: existingId,
          reused: true,
        })
        return
      }
      // The document exists but belongs to another workspace, so the canvas
      // here cannot show it. Doing nothing read as a broken button.
      loggers.ui.info("artifacts.action.open-in-canvas-other-workspace", {
        artifactId: activeArtifact.id,
        canvasId: existingId,
      })
      toast.info(t("canvasInOtherWorkspace"), {
        action: {
          label: t("canvasCopyHere"),
          onClick: () => createCanvasFromArtifact(returnContext),
        },
      })
      return
    }

    createCanvasFromArtifact(returnContext)
  }, [
    activeArtifact,
    buildReturnContext,
    canvasDocuments,
    createCanvasFromArtifact,
    pathname,
    router,
    setArtifactWorkspaceReturnContext,
    t,
  ])

  const handleEditMode = useCallback(() => {
    if (activeArtifact) {
      // Resumes an existing draft rather than reseeding it from the committed
      // content: re-entering Edit used to discard whatever had been typed.
      beginDraft(activeArtifact.id, {
        content: activeArtifact.content,
        version: activeArtifact.version,
      })
      setViewMode("edit")
    }
  }, [activeArtifact, beginDraft, setViewMode])

  /** Commit the draft, snapshotting what it replaces. */
  const commitDraft = useCallback(() => {
    if (!activeArtifact || !draft) return
    saveArtifactVersion(activeArtifact.id, t("beforeEdit"))
    updateArtifact(activeArtifact.id, { content: draft.content })
    clearDraft(activeArtifact.id)
    setViewMode("code")
    loggers.ui.info("artifacts.action.save-edit", { artifactId: activeArtifact.id })
  }, [activeArtifact, clearDraft, draft, saveArtifactVersion, setViewMode, t, updateArtifact])

  const handleSaveEdit = useCallback(() => {
    if (!activeArtifact || !hasChanges) return
    // Another revision landed while this draft was open. Saving would replace
    // it without the user ever having seen it, so the save waits for an
    // explicit choice (`handleOverwriteDraft` / `handleDiscardDraft`).
    if (draftConflict) {
      loggers.ui.info("artifacts.action.save-edit-conflict", { artifactId: activeArtifact.id })
      return
    }
    commitDraft()
  }, [activeArtifact, commitDraft, draftConflict, hasChanges])

  /** Keep the draft over the revision committed meanwhile (that one is snapshotted). */
  const handleOverwriteDraft = useCallback(() => {
    if (!activeArtifact || !draft) return
    commitDraft()
    loggers.ui.info("artifacts.action.save-edit-overwrite", { artifactId: activeArtifact.id })
  }, [activeArtifact, commitDraft, draft])

  /** Drop the draft and show the revision committed meanwhile. */
  const handleDiscardDraft = useCallback(() => {
    if (!activeArtifact) return
    clearDraft(activeArtifact.id)
    setViewMode("code")
  }, [activeArtifact, clearDraft, setViewMode])

  const handleCancelEdit = useCallback(() => {
    if (activeArtifact) clearDraft(activeArtifact.id)
    setViewMode("code")
  }, [activeArtifact, clearDraft, setViewMode])

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (activeArtifact) updateDraft(activeArtifact.id, value ?? "")
    },
    [activeArtifact, updateDraft]
  )

  /**
   * Save (Cmd/Ctrl+S) and Edit (Cmd/Ctrl+E), for key presses inside the panel.
   *
   * Attached to the panel rather than the window: a window listener fired for
   * every keystroke anywhere in the app, while ignoring the one place a save
   * shortcut is pressed — the editor itself, whose input is a textarea.
   */
  const handlePanelKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (!activeArtifact || !(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === "s" && viewMode === "edit") {
        event.preventDefault()
        handleSaveEdit()
      } else if (key === "e" && viewMode !== "edit") {
        event.preventDefault()
        handleEditMode()
      }
    },
    [activeArtifact, handleEditMode, handleSaveEdit, viewMode]
  )

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev)
  }, [])

  const handleCopy = async () => {
    if (activeArtifact) {
      // Native clipboard first (mobile WebView often leaves navigator.clipboard
      // unavailable); fall back to the web API on Tauri/web where the native
      // plugin reports "unsupported".
      const native = await clipboardWriteText(activeArtifact.content)
      if (native.kind !== "ok") {
        await navigator.clipboard.writeText(activeArtifact.content)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  /**
   * One-click download. Always the *source* format
   * (`getPreferredArtifactExportFormat` never returns png/pdf) — a default
   * download must not silently become a rasterisation.
   */
  const handleDownload = async () => {
    if (!activeArtifact) return
    const preferredFormat = getPreferredArtifactExportFormat(activeArtifact)
    try {
      // Cross-platform saver — the prior `<a download>` path silently no-ops
      // inside a mobile WebView, so artifact exports vanished on Capacitor.
      const outcome = await exportArtifact(activeArtifact, preferredFormat)
      if (outcome.kind === "error") throw new Error(outcome.message)
      if (outcome.kind === "saved" && isDesktop) {
        setLastDownloadPath(outcome.location)
      }
      loggers.ui.info("artifacts.action.download", {
        artifactId: activeArtifact.id,
        format: preferredFormat,
      })
    } catch (error) {
      loggers.ui.error("artifacts.action.download-failed", error, {
        artifactId: activeArtifact.id,
      })
      toast.error(t("exportFailed"))
    }
  }

  /**
   * A plugin renderer draws this artifact, so its content is that plugin's
   * model (e.g. a cognia-office workbook) and the plugin exports it natively.
   * The host's text exporters and Word writer would print the model as prose.
   */
  const pluginOwnsContent = activeArtifact
    ? isPluginModelArtifact(activeArtifact) ||
      resolveRegisteredArtifactRenderer(activeArtifact) !== null
    : false

  /** Every format the active artifact's adapter actually offers. */
  const exportFormats = activeArtifact
    ? getArtifactExportFormats(activeArtifact, { pluginOwnsContent }).filter(
        (format) =>
          isPreviewable ||
          (format !== "png" && (format !== "pdf" || !pdfNeedsMountedPreview(activeArtifact)))
      )
    : []

  /** Whether "Download as Word" can turn the content into a document. */
  const canDownloadAsDocument = Boolean(activeArtifact) && !pluginOwnsContent

  /**
   * Explicit "export as <format>" — the menu's path, so png / pdf / svg are
   * reachable here even though `handleDownload` will never pick them.
   */
  const handleExportAs = async (format: ArtifactExportFormat) => {
    if (!activeArtifact) return
    try {
      if (format === "png" || (format === "pdf" && pdfNeedsMountedPreview(activeArtifact))) {
        if (!isPreviewable) return
        setViewMode("preview")
        await waitForArtifactPreview(activeArtifact.id)
      }
      const outcome = await exportArtifact(activeArtifact, format)
      if (outcome.kind === "error") throw new Error(outcome.message)
      if (outcome.kind === "saved" && isDesktop) setLastDownloadPath(outcome.location)
      loggers.ui.info("artifacts.action.export-as", { artifactId: activeArtifact.id, format })
    } catch (error) {
      loggers.ui.error("artifacts.action.export-as-failed", error, {
        artifactId: activeArtifact.id,
        format,
      })
      toast.error(t("exportFailed"))
    }
  }

  // Generate + save the artifact's content as a Word (.docx) or PDF document.
  // Treats the content as markdown; reuses the client-side document writer +
  // cross-platform saver, so it works on mobile WebView (unlike <a download>).
  const handleDownloadAs = async (format: DocFormat) => {
    if (!activeArtifact || !canDownloadAsDocument) return
    try {
      if (format === "pdf") {
        await handleExportAs("pdf")
        return
      }
      // Word keeps the document writer; PDF uses the same format-specific
      // preparation and error feedback as the export menu above.
      const outcome = await saveGeneratedDocument({
        title: activeArtifact.title,
        markdown: activeArtifact.content,
        format,
      })
      if (outcome.kind === "error") throw new Error(outcome.message)
      if (outcome.kind === "saved" && isDesktop) setLastDownloadPath(outcome.location)
      loggers.ui.info("artifacts.action.download-as", { artifactId: activeArtifact.id, format })
    } catch (error) {
      loggers.ui.error("artifacts.action.download-as-failed", error, {
        artifactId: activeArtifact.id,
      })
      toast.error(t("exportFailed"))
    }
  }

  // The Blob document is a scriptless host for an opaque-origin sandbox.
  const handleOpenInNewTab = useCallback(() => {
    if (!activeArtifact || (activeArtifact.type !== "html" && activeArtifact.type !== "svg")) return
    let document: ReturnType<typeof createArtifactTabDocument> | undefined
    let url: string | undefined
    try {
      document = createArtifactTabDocument(
        activeArtifact,
        useSettingsStore.getState().settings?.artifacts?.interactiveHtml === true
      )
      const blob = new Blob([document.html], { type: "text/html" })
      url = URL.createObjectURL(blob)
      window.open(url, "_blank", "noopener,noreferrer")
      const openedUrl = url
      setTimeout(() => {
        URL.revokeObjectURL(openedUrl)
        document?.dispose()
      }, 10000)
      loggers.ui.info("artifacts.action.open-in-new-tab", {
        artifactId: activeArtifact.id,
        type: activeArtifact.type,
      })
    } catch (error) {
      if (url) URL.revokeObjectURL(url)
      document?.dispose()
      loggers.ui.error("artifacts.action.open-in-new-tab-failed", error, {
        artifactId: activeArtifact.id,
      })
      throw error
    }
  }, [activeArtifact])

  /**
   * Write the artifact into the user's project and open it right there in the
   * dock's workspace panel, so the next step (reading the diff) is one click
   * away instead of a trip through the OS file manager.
   *
   * Deliberately one-directional: the artifact records nothing about the file
   * afterwards. A stored link would owe us stale-detection and conflict
   * resolution the moment either side changed.
   */
  const handleSaveToProject = async () => {
    if (!activeArtifact) return
    const sessionId = useChatStore.getState().activeSessionId
    // Same chain the workspace panel resolves its root from — the
    // conversation's execution root first, so a save defaults into the tree the
    // agent is working in. Falls back to the project the artifact was authored
    // under when the chat itself is unbound.
    const session = sessionId ? await getSession(sessionId) : undefined
    const { project, root } = resolveSessionExecutionRoot(
      {
        projectId: session?.projectId ?? activeArtifact.projectId,
        ...(session?.executionContext ? { executionContext: session.executionContext } : {}),
      },
      useProjectStore.getState().projects
    )
    // Save-into-workspace is always the source text: the point is to drop a
    // file the agent can then read and edit, not a picture of one.
    const rendered = await renderArtifactExport(activeArtifact, "raw")
    const filename = artifactExportFilename(activeArtifact, "raw")
    try {
      const outcome = await saveExport({
        filename,
        data: rendered.data,
        mimeType: rendered.mimeType,
        defaultDirectory: root ?? undefined,
      })
      if (outcome.kind === "error") throw new Error(outcome.message)
      if (outcome.kind !== "saved") return
      if (isDesktop) setLastDownloadPath(outcome.location)

      // The dialog lets the user leave the project entirely; only a path that
      // landed under a mounted root can be revealed in the workspace panel.
      const roots = project ? allRootPaths(project) : []
      const containing = roots.find((candidate) => outcome.location.startsWith(`${candidate}/`))
      if (sessionId && containing) {
        useArtifactDockLayoutStore.getState().revealWorkspaceFile({
          sessionId,
          rootPath: containing,
          relPath: outcome.location.slice(containing.length + 1),
        })
      } else if (isDesktop) {
        await revealInExplorer(outcome.location)
      }
      loggers.ui.info("artifacts.action.save-to-project", {
        artifactId: activeArtifact.id,
        revealed: Boolean(containing),
      })
    } catch (error) {
      loggers.ui.error("artifacts.action.save-to-project-failed", error, {
        artifactId: activeArtifact.id,
      })
      throw error
    }
  }

  const handleRevealInExplorer = async () => {
    if (!isDesktop || !lastDownloadPath) return
    try {
      const { downloadDir, isAbsolute, join } = await import("@tauri-apps/api/path")
      const fullPath = (await isAbsolute(lastDownloadPath))
        ? lastDownloadPath
        : await join(await downloadDir(), lastDownloadPath)
      await revealInExplorer(fullPath)
    } catch (revealError) {
      loggers.ui.warn("artifacts.reveal.failed", {
        error: revealError,
        artifactId: activeArtifact?.id,
      })
      try {
        const { downloadDir } = await import("@tauri-apps/api/path")
        const downloadsPath = await downloadDir()
        await openPath(downloadsPath)
      } catch (fallbackError) {
        // Best-effort: surfacing this is not a feature we have UI for yet.
        loggers.ui.warn("artifacts.reveal.fallback-failed", {
          error: fallbackError,
          artifactId: activeArtifact?.id,
        })
      }
    }
  }

  // Only html/svg render directly in a bare browser tab (react needs the
  // sandboxed bundler; other types aren't standalone documents).
  const isOpenableInNewTab = activeArtifact?.type === "html" || activeArtifact?.type === "svg"
  const panelMode: "desktop" | "tablet" | "mobile" | "fullscreen" = isFullscreen
    ? "fullscreen"
    : isMobileViewport
      ? "mobile"
      : isTabletViewport
        ? "tablet"
        : "desktop"
  const panelWidth =
    panelMode === "fullscreen"
      ? "w-full sm:w-full sm:max-w-full"
      : panelMode === "desktop"
        ? "w-full sm:w-[760px] sm:max-w-[760px]"
        : panelMode === "tablet"
          ? "w-full sm:w-[680px] sm:max-w-[680px]"
          : "w-full"

  const primaryActions: ArtifactPanelAction[] = [
    ...(isPreviewable ? ["modeTabs" as const] : []),
    "edit",
    "canvas",
    "fullscreen",
    "close",
  ]

  // Writing into the project needs a filesystem; the web shell has none.
  const canSaveToProject = isDesktop && hasWorkspaceFsBackend()

  const overflowActions: ArtifactPanelAction[] = [
    "copy",
    "download",
    ...(canSaveToProject ? ["saveToProject" as const] : []),
    ...(isOpenableInNewTab ? ["openInNewTab" as const] : []),
    ...(isDesktop && lastDownloadPath ? ["revealInExplorer" as const] : []),
    "versionHistory",
  ]

  return {
    // Translations
    t,
    tCommon,
    // Store state
    activeArtifact,
    pendingReview,
    theme,
    isDesktop,
    // Local state
    viewMode,
    setViewMode,
    copied,
    editContent,
    hasChanges,
    draftConflict,
    isFullscreen,
    showVersionHistory,
    setShowVersionHistory,
    lastDownloadPath,
    // Derived
    isPreviewable,
    isOpenableInNewTab,
    panelMode,
    panelWidth,
    primaryActions,
    overflowActions,
    // Actions
    closePanel,
    handleOpenInCanvas,
    handleEditMode,
    handleSaveEdit,
    handleOverwriteDraft,
    handleDiscardDraft,
    handleCancelEdit,
    handleEditorChange,
    handlePanelKeyDown,
    toggleFullscreen,
    handleCopy,
    handleDownload,
    handleDownloadAs,
    canDownloadAsDocument,
    exportFormats,
    handleExportAs,
    handleOpenInNewTab,
    handleRevealInExplorer,
    handleSaveToProject,
  }
}

/**
 * The Canvas document an artifact was sent to, if it still exists.
 *
 * The artifact's back-link (`derivedFromCanvasDocumentId`) is checked first;
 * the documents' own forward link (`sourceArtifactId`) answers when the
 * back-link is missing or points at a deleted document, because that one lives
 * on the document and no artifact write can drop it. The most recently edited
 * document wins when several were made from the same artifact.
 */
export function findCanvasDocumentForArtifact(
  artifactId: string,
  linkedId: string | undefined,
  documents: Record<string, CanvasDocument>
): string | null {
  if (linkedId && documents[linkedId]) return linkedId
  let found: CanvasDocument | null = null
  for (const doc of Object.values(documents)) {
    if (doc.sourceArtifactId !== artifactId) continue
    if (!found || new Date(doc.updatedAt).getTime() > new Date(found.updatedAt).getTime()) {
      found = doc
    }
  }
  return found?.id ?? null
}
