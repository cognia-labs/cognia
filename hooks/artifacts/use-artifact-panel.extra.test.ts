/**
 * @jest-environment jsdom
 */

import { renderHook, act } from "@testing-library/react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

jest.mock("next/navigation", () => {
  const push = jest.fn()
  return { useRouter: () => ({ push }), usePathname: jest.fn(() => "/"), __push: push }
})

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const revealInExplorer = jest.fn().mockResolvedValue(undefined)
const openPath = jest.fn().mockResolvedValue(undefined)
const saveExport = jest.fn().mockResolvedValue({ kind: "saved", location: "Page.html" })

// `stores/index.ts` calls `isTauri()` at module top-level inside a Zustand
// `create()`; that fires during ES import hoisting, before any `let` in this
// file initialises. Owning the toggle ref inside the factory dodges the TDZ.
jest.mock("@/lib/tauri", () => {
  const ref = { value: true }
  return {
    isTauri: () => ref.value,
    __setIsTauri: (next: boolean) => {
      ref.value = next
    },
  }
})
const { __setIsTauri } = jest.requireMock("@/lib/tauri") as {
  __setIsTauri: (next: boolean) => void
}
function setIsTauriValue(next: boolean) {
  __setIsTauri(next)
}

jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: (...args: unknown[]) => revealInExplorer(...args),
  openPath: (...args: unknown[]) => openPath(...args),
}))

jest.mock("@/lib/files/save-export", () => ({
  saveExport: (...args: unknown[]) => saveExport(...args),
}))

jest.mock("@tauri-apps/api/path", () => ({
  downloadDir: jest.fn().mockResolvedValue("/Users/me/Downloads/"),
  isAbsolute: jest.fn(async (path: string) => /^(?:\/|\\|[A-Za-z]:\\)/.test(path)),
  join: jest.fn(async (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/")),
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => true,
}))

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(async (id: string) => ({ id, projectId: "p1" })),
}))

import { useArtifactPanelState } from "./use-artifact-panel"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { loggers } from "@cognia/logging"
import { useUIStore } from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings"
import { usePathname } from "next/navigation"
import { toast } from "sonner"
import { requestArtifactPreview } from "@/lib/artifacts/preview-view-request"
import type { AppSettings } from "@cognia/agent-config-types"

function setDefaultPanelMode(defaultPanelMode: "code" | "preview") {
  useSettingsStore.setState({
    settings: { id: "singleton", artifacts: { defaultPanelMode } } as AppSettings,
  })
}

/** A chat bound to a project rooted at /repo, the shape saveToProject needs. */
function bindSessionToProject() {
  useProjectStore.setState({
    projects: [{ id: "p1", name: "Repo", roots: [{ id: "r1", path: "/repo", isPrimary: true }] }],
  } as never)
  useChatStore.setState({ activeSessionId: "s" } as never)
}

beforeEach(() => {
  localStorage.clear()
  revealInExplorer.mockClear()
  openPath.mockClear()
  saveExport.mockClear().mockResolvedValue({ kind: "saved", location: "Page.html" })
  setIsTauriValue(true)
  useUIStore.getState().setSelectedGuild({ kind: "dm" })
  setDefaultPanelMode("code")
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactIdBySession: {},
    artifactVersions: {},
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
    content: "<!DOCTYPE html><html></html>",
    language: "html",
  })
}

describe("saveToProject", () => {
  beforeEach(() => {
    bindSessionToProject()
    act(() => useArtifactDockLayoutStore.getState().resetLayout())
  })

  it("offers the action only where there is a filesystem to write to", () => {
    makeArtifact()
    const { result, rerender } = renderHook(() => useArtifactPanelState())
    expect(result.current.overflowActions).toContain("saveToProject")

    setIsTauriValue(false)
    rerender()
    expect(result.current.overflowActions).not.toContain("saveToProject")
  })

  it("opens the save dialog in the session's project root", async () => {
    const a = makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/repo/src/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    // Without this the dialog lands wherever the user saved last, which is
    // rarely the project they are working in.
    expect(saveExport).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDirectory: "/repo", filename: `${a.title}.html` })
    )
  })

  it("reveals a file saved inside the project in the workspace panel", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/repo/src/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    // The point of the action: land in the workspace with the diff one tab away.
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toMatchObject({
      kind: "file",
      rootPath: "/repo",
      relPath: "src/Page.html",
    })
    expect(revealInExplorer).not.toHaveBeenCalled()
  })

  it("falls back to the OS file manager when the user saves outside the project", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/elsewhere/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
    expect(revealInExplorer).toHaveBeenCalledWith("/elsewhere/Page.html")
  })

  it("does nothing when the save dialog is cancelled", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "cancelled" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
    expect(revealInExplorer).not.toHaveBeenCalled()
  })

  it("does nothing without an active artifact", async () => {
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(saveExport).not.toHaveBeenCalled()
  })

  it("falls back to the artifact's own project when the chat is unbound", async () => {
    // An artifact with no conversation behind it (the workspace route, a
    // plugin-created one) lands in the session-less bucket, which is what the
    // panel resolves against when no chat is mounted.
    useChatStore.setState({ activeSessionId: null } as never)
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "",
      messageId: "m",
      type: "html",
      title: "Page",
      content: "<!DOCTYPE html><html></html>",
      language: "html",
    })
    act(() =>
      useArtifactStore.setState((state) => ({
        artifacts: { ...state.artifacts, [a.id]: { ...state.artifacts[a.id], projectId: "p1" } },
      }))
    )
    saveExport.mockResolvedValue({ kind: "saved", location: "/repo/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    expect(saveExport).toHaveBeenCalledWith(expect.objectContaining({ defaultDirectory: "/repo" }))
    // No session id means nothing to scope a workspace reveal to.
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
    expect(revealInExplorer).toHaveBeenCalledWith("/repo/Page.html")
  })

  it("still saves when neither the chat nor the artifact names a project", async () => {
    useProjectStore.setState({ projects: [] } as never)
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "saved", location: "/anywhere/Page.html" })
    const { result } = renderHook(() => useArtifactPanelState())

    await act(async () => {
      await result.current.handleSaveToProject()
    })

    // A rootless workspace still gets a save dialog — it just opens wherever
    // the OS last left it, and the result is revealed in the file manager.
    expect(saveExport).toHaveBeenCalledWith(
      expect.objectContaining({ defaultDirectory: undefined })
    )
    expect(revealInExplorer).toHaveBeenCalledWith("/anywhere/Page.html")
  })

  it("surfaces a write failure instead of reporting success", async () => {
    makeArtifact()
    saveExport.mockResolvedValue({ kind: "error", message: "disk full" })
    const { result } = renderHook(() => useArtifactPanelState())

    await expect(result.current.handleSaveToProject()).rejects.toThrow("disk full")
    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
  })
})

describe("useArtifactPanelState — extra coverage", () => {
  it("B18 consumes a capture request made before the panel mounts", () => {
    bindSessionToProject()
    const artifact = makeArtifact()
    const release = requestArtifactPreview(artifact.id)
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.viewMode).toBe("preview")
    release()
  })

  it("B18 targets only the requested artifact", () => {
    bindSessionToProject()
    const artifact = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    const releaseOther = requestArtifactPreview("other")
    expect(result.current.viewMode).toBe("code")
    let release!: () => void
    act(() => {
      release = requestArtifactPreview(artifact.id)
    })
    expect(result.current.viewMode).toBe("preview")
    release()
    releaseOther()
  })

  it("B18 keeps a pending review from taking Preview away from a capture", () => {
    bindSessionToProject()
    const artifact = makeArtifact()
    useArtifactStore.getState().proposeArtifactUpdate(artifact.id, "<p>proposed</p>")
    const release = requestArtifactPreview(artifact.id)
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.viewMode).toBe("preview")
    release()
  })

  it("DG01 an already-mounted panel follows the current default until the user picks a mode", () => {
    bindSessionToProject()
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.viewMode).toBe("code")
    act(() => setDefaultPanelMode("preview"))
    expect(result.current.viewMode).toBe("preview")
    act(() => result.current.setViewMode("code"))
    act(() => setDefaultPanelMode("code"))
    act(() => setDefaultPanelMode("preview"))
    // An explicit choice wins over later default changes.
    expect(result.current.viewMode).toBe("code")
  })

  it("B01 opens a scriptless outer document containing only an opaque sandbox", async () => {
    const artifact = makeArtifact()
    useArtifactStore.getState().updateArtifact(artifact.id, {
      content: '<p id="artifact-content">private</p><script>localStorage.clear()</script>',
    })
    const createObjectURL = jest.fn((_blob: Blob) => "blob:safe-tab")
    Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() })
    window.open = jest.fn()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleOpenInNewTab())
    const markup = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(createObjectURL.mock.calls[0][0])
    })
    const doc = new DOMParser().parseFromString(markup, "text/html")
    expect(doc.querySelector("script, #artifact-content")).toBeNull()
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull()
    const frame = doc.querySelector("iframe")!
    expect(frame).not.toBeNull()
    expect(frame.getAttribute("sandbox")).toBe("")
    expect(frame.srcdoc).toContain('id="artifact-content"')
  })

  it.each(["/elsewhere/Page.html", "C:\\Exports\\Page.html", "\\\\server\\share\\Page.html"])(
    "B20 reveals an absolute save-dialog path unchanged: %s",
    async (location) => {
      bindSessionToProject()
      makeArtifact()
      saveExport.mockResolvedValueOnce({ kind: "saved", platform: "tauri", location })
      const { result } = renderHook(() => useArtifactPanelState())
      await act(async () => {
        await result.current.handleDownload()
      })
      await act(async () => {
        await result.current.handleRevealInExplorer()
      })
      expect(revealInExplorer).toHaveBeenCalledWith(location)
    }
  )

  it("B20 joins relative filenames with the downloads directory", async () => {
    bindSessionToProject()
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleDownload()
    })
    await act(async () => {
      await result.current.handleRevealInExplorer()
    })
    expect(revealInExplorer).toHaveBeenCalledWith("/Users/me/Downloads/Page.html")
  })

  it("DG01 uses the default on first open and artifact switches, falling back for code", () => {
    bindSessionToProject()
    setDefaultPanelMode("preview")
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.viewMode).toBe("preview")
    act(() => result.current.setViewMode("code"))
    act(() => makeArtifact())
    expect(result.current.viewMode).toBe("preview")
    act(() =>
      useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "code",
        title: "Code",
        content: "x",
      })
    )
    expect(result.current.viewMode).toBe("code")
    expect(result.current.exportFormats).toContain("pdf")
    expect(result.current.exportFormats).not.toContain("png")
  })

  /** A key press inside the panel, as `ArtifactPanelContent` forwards it. */
  function pressInPanel(
    handler: (event: ReactKeyboardEvent) => void,
    init: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
  ) {
    const preventDefault = jest.fn()
    handler({
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...init,
      preventDefault,
    } as unknown as ReactKeyboardEvent)
    return preventDefault
  }

  it("Ctrl+E inside the panel enters edit mode", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    let prevented!: jest.Mock
    act(() => {
      prevented = pressInPanel(result.current.handlePanelKeyDown, { key: "e", ctrlKey: true })
    })
    expect(prevented).toHaveBeenCalled()
    expect(result.current.viewMode).toBe("edit")
  })

  it("Cmd+S inside the panel (the editor included) saves the draft", () => {
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleEditMode())
    act(() => result.current.handleEditorChange("<html>changed</html>"))
    act(() => {
      pressInPanel(result.current.handlePanelKeyDown, { key: "s", metaKey: true })
    })
    expect(result.current.viewMode).toBe("code")
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("<html>changed</html>")
  })

  it("keystrokes elsewhere in the app no longer drive the panel", () => {
    makeArtifact()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true }))
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(result.current.viewMode).toBe("code")
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("handleRevealInExplorer is a no-op when not desktop", async () => {
    setIsTauriValue(false)
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    await act(async () => {
      await result.current.handleRevealInExplorer()
    })
    expect(revealInExplorer).not.toHaveBeenCalled()
  })

  it("handleRevealInExplorer falls back to openPath when reveal throws and logs the failure", async () => {
    const warnSpy = jest.spyOn(loggers.ui, "warn").mockImplementation()
    revealInExplorer.mockRejectedValueOnce(new Error("boom"))
    const a = makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    // Mark a download path so the action arms.
    Object.assign(URL, {
      createObjectURL: jest.fn(() => "blob:x"),
      revokeObjectURL: jest.fn(),
    })
    await act(async () => {
      await result.current.handleDownload()
    })
    await act(async () => {
      await result.current.handleRevealInExplorer()
    })
    expect(revealInExplorer).toHaveBeenCalled()
    expect(openPath).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      "artifacts.reveal.failed",
      expect.objectContaining({ artifactId: expect.any(String) })
    )
    warnSpy.mockRestore()
    void a
  })

  it("marks html/svg as openable in a new tab and exposes the overflow action", () => {
    makeArtifact() // html
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.isOpenableInNewTab).toBe(true)
    expect(result.current.overflowActions).toContain("openInNewTab")
  })

  it("handleOpenInNewTab opens a blob URL and revokes it after a grace period", () => {
    jest.useFakeTimers()
    makeArtifact()
    const createObjectURL = jest.fn(() => "blob:mock")
    const revokeObjectURL = jest.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const open = jest.fn()
    window.open = open as unknown as typeof window.open

    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.handleOpenInNewTab())
    expect(createObjectURL).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("blob:mock", "_blank", "noopener,noreferrer")
    act(() => jest.advanceTimersByTime(10001))
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock")
    jest.useRealTimers()
  })

  it("code artifacts are not openable in a new tab", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Snippet",
      content: "x=1",
      language: "python",
    })
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.isOpenableInNewTab).toBe(false)
    expect(result.current.overflowActions).not.toContain("openInNewTab")
  })

  it("setViewMode accepts the split mode", () => {
    makeArtifact()
    const { result } = renderHook(() => useArtifactPanelState())
    act(() => result.current.setViewMode("split"))
    expect(result.current.viewMode).toBe("split")
  })

  it("buildReturnContext is exposed via handleOpenInCanvas with no active artifact", () => {
    // Without an active artifact, handleOpenInCanvas is a no-op.
    const { result } = renderHook(() => useArtifactPanelState())
    expect(result.current.activeArtifact).toBeNull()
    act(() => result.current.handleOpenInCanvas())
    expect(Object.keys(useArtifactStore.getState().canvasDocuments)).toHaveLength(0)
  })

  describe("handleOpenInCanvas document reuse", () => {
    function openArtifactInCanvas() {
      const artifact = useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "html",
        title: "page",
        content: "<p>hi</p>",
      })
      act(() => useArtifactStore.getState().setActiveArtifact(artifact.id))
      const { result, rerender } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleOpenInCanvas())
      return { artifact, result, rerender }
    }

    it("links the artifact to the document it created", () => {
      const { artifact } = openArtifactInCanvas()

      const docId = useArtifactStore.getState().activeCanvasId
      expect(docId).toBeTruthy()
      expect(useUIStore.getState().selectedGuild.kind).toBe("canvas")
      // Both directions of the lineage, so either side can find the other.
      expect(useArtifactStore.getState().canvasDocuments[docId!]?.sourceArtifactId).toBe(
        artifact.id
      )
      expect(
        useArtifactStore.getState().artifacts[artifact.id]?.metadata?.derivedFromCanvasDocumentId
      ).toBe(docId)
    })

    it("reopens the same document instead of minting duplicates", () => {
      // Alternating between the panel and the canvas used to leave a trail of
      // copies, with the user's edits stranded in whichever one they left.
      const { result } = openArtifactInCanvas()
      const firstDocId = useArtifactStore.getState().activeCanvasId

      act(() => useArtifactStore.getState().setActiveCanvas(null))
      act(() => useUIStore.getState().setSelectedGuild({ kind: "dm" }))
      act(() => result.current.handleOpenInCanvas())

      expect(useArtifactStore.getState().activeCanvasId).toBe(firstDocId)
      expect(useUIStore.getState().selectedGuild.kind).toBe("canvas")
      expect(Object.keys(useArtifactStore.getState().canvasDocuments)).toHaveLength(1)
    })

    it.each([true, false])(
      "B19 routes back home on native=%s for new and reused documents",
      (native) => {
        setIsTauriValue(native)
        jest.mocked(usePathname).mockReturnValueOnce("/artifacts")
        const push = jest.requireMock("next/navigation").__push as jest.Mock
        push.mockClear()
        const { result, rerender } = openArtifactInCanvas()
        expect(useUIStore.getState().selectedGuild.kind).toBe("canvas")
        expect(push).toHaveBeenCalledWith("/")
        expect(result.current.activeArtifact).not.toBeNull()
        jest.mocked(usePathname).mockReturnValue("/artifacts")
        act(() => useUIStore.getState().setSelectedGuild({ kind: "dm" }))
        // Picks up the new pathname, as navigating to /artifacts would.
        rerender()
        act(() => result.current.handleOpenInCanvas())
        expect(useUIStore.getState().selectedGuild.kind).toBe("canvas")
        expect(push).toHaveBeenCalledTimes(2)
        jest.mocked(usePathname).mockReturnValue("/")
      }
    )

    it("C04 reuses the edited document after an older version is restored", () => {
      const artifact = useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "html",
        title: "page",
        content: "<p>hi</p>",
      })
      act(() => useArtifactStore.getState().setActiveArtifact(artifact.id))
      const snapshot = useArtifactStore.getState().saveArtifactVersion(artifact.id, "before")!
      const { result } = renderHook(() => useArtifactPanelState())
      act(() => result.current.handleOpenInCanvas())
      const firstDocId = useArtifactStore.getState().activeCanvasId!
      act(() => {
        useArtifactStore.getState().updateCanvasDocument(firstDocId, { content: "Canvas edits" })
        useArtifactStore.getState().restoreArtifactVersion(artifact.id, snapshot.id)
        useUIStore.getState().setSelectedGuild({ kind: "dm" })
      })
      act(() => result.current.handleOpenInCanvas())
      const state = useArtifactStore.getState()
      expect(state.activeCanvasId).toBe(firstDocId)
      expect(Object.keys(state.canvasDocuments)).toEqual([firstDocId])
      expect(state.canvasDocuments[firstDocId].content).toBe("Canvas edits")
    })

    it("C04 finds the document through its own link when the artifact's link is gone", () => {
      const { artifact, result } = openArtifactInCanvas()
      const firstDocId = useArtifactStore.getState().activeCanvasId!
      act(() => {
        const current = useArtifactStore.getState().artifacts[artifact.id]
        useArtifactStore.setState((state) => ({
          artifacts: { ...state.artifacts, [artifact.id]: { ...current, metadata: {} } },
        }))
        useUIStore.getState().setSelectedGuild({ kind: "dm" })
      })
      act(() => result.current.handleOpenInCanvas())
      expect(useArtifactStore.getState().activeCanvasId).toBe(firstDocId)
      expect(Object.keys(useArtifactStore.getState().canvasDocuments)).toEqual([firstDocId])
      expect(useUIStore.getState().selectedGuild.kind).toBe("canvas")
    })

    it("C04 says why a document in another workspace cannot open, and offers a copy", () => {
      const { result } = openArtifactInCanvas()
      const firstDocId = useArtifactStore.getState().activeCanvasId!
      act(() => {
        useArtifactStore.setState((state) => ({
          canvasDocuments: {
            ...state.canvasDocuments,
            [firstDocId]: { ...state.canvasDocuments[firstDocId], projectId: "elsewhere" },
          },
        }))
        useProjectStore.setState({ activeProjectId: "here" })
        useUIStore.getState().setSelectedGuild({ kind: "dm" })
        useArtifactStore.getState().setActiveCanvas(null)
      })
      const info = jest.spyOn(toast, "info").mockImplementation(() => "toast-id")
      act(() => result.current.handleOpenInCanvas())
      expect(useUIStore.getState().selectedGuild.kind).toBe("dm")
      expect(info).toHaveBeenCalledWith(
        "canvasInOtherWorkspace",
        expect.objectContaining({ action: expect.objectContaining({ label: "canvasCopyHere" }) })
      )
      const action = info.mock.calls[0][1]!.action as unknown as { onClick: () => void }
      act(() => action.onClick())
      const docs = Object.values(useArtifactStore.getState().canvasDocuments)
      expect(docs).toHaveLength(2)
      expect(useArtifactStore.getState().activeCanvasId).not.toBe(firstDocId)
      expect(useUIStore.getState().selectedGuild.kind).toBe("canvas")
      info.mockRestore()
      useProjectStore.setState({ activeProjectId: null })
    })

    it("creates a fresh document when the linked one was deleted", () => {
      const { result } = openArtifactInCanvas()
      const firstDocId = useArtifactStore.getState().activeCanvasId!

      act(() => useArtifactStore.getState().deleteCanvasDocument(firstDocId))
      act(() => result.current.handleOpenInCanvas())

      const nextDocId = useArtifactStore.getState().activeCanvasId
      expect(nextDocId).toBeTruthy()
      expect(nextDocId).not.toBe(firstDocId)
    })
  })
})
