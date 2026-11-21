import {
  FILES_SIDEBAR_DEFAULT_PX,
  FILES_SIDEBAR_MAX_PX,
  FILES_SIDEBAR_MIN_PX,
  useFilesLibraryStore,
} from "./files-library-store"

const initial = useFilesLibraryStore.getState()
beforeEach(() => useFilesLibraryStore.setState(initial, true))

describe("files library store", () => {
  it("starts on All, Suggested, default order, nothing selected", () => {
    expect(useFilesLibraryStore.getState()).toMatchObject({
      viewMode: "grid",
      sort: null,
      projectScope: "current",
      sidebarWidthPx: FILES_SIDEBAR_DEFAULT_PX,
      expandedFolderIds: [],
      templatesCollapsed: false,
      section: { kind: "all" },
      lens: "suggested",
      search: "",
      filters: { formats: [], modified: "any", size: "any" },
      selectedKey: null,
    })
  })

  it("closes the preview when the place changes, but not when the lens does", () => {
    const s = useFilesLibraryStore.getState()
    s.select("image:h")
    s.setLens("favorites")
    expect(useFilesLibraryStore.getState().selectedKey).toBe("image:h")
    s.setSection({ kind: "trash" })
    expect(useFilesLibraryStore.getState()).toMatchObject({
      section: { kind: "trash" },
      lens: "favorites",
      selectedKey: null,
    })
  })

  it("patches filters and resets them together with the search", () => {
    const s = useFilesLibraryStore.getState()
    s.setFilters({ formats: ["image"] })
    s.setFilters({ size: "large" })
    s.setSearch("plan")
    expect(useFilesLibraryStore.getState().filters).toEqual({
      formats: ["image"],
      modified: "any",
      size: "large",
    })
    s.resetFilters()
    expect(useFilesLibraryStore.getState()).toMatchObject({
      filters: { formats: [], modified: "any", size: "any" },
      search: "",
    })
  })

  it("clamps the sidebar width and remembers open folders once each", () => {
    const s = useFilesLibraryStore.getState()
    s.setSidebarWidth(10)
    expect(useFilesLibraryStore.getState().sidebarWidthPx).toBe(FILES_SIDEBAR_MIN_PX)
    s.setSidebarWidth(9_999)
    expect(useFilesLibraryStore.getState().sidebarWidthPx).toBe(FILES_SIDEBAR_MAX_PX)
    s.setSidebarWidth(Number.NaN)
    expect(useFilesLibraryStore.getState().sidebarWidthPx).toBe(FILES_SIDEBAR_DEFAULT_PX)
    s.setFolderExpanded("lbf_a", true)
    s.setFolderExpanded("lbf_a", true)
    s.setFolderExpanded("lbf_b", true)
    s.setFolderExpanded("lbf_a", false)
    expect(useFilesLibraryStore.getState().expandedFolderIds).toEqual(["lbf_b"])
  })

  it("opens and closes every dialog target", () => {
    const s = useFilesLibraryStore.getState()
    s.openMove(["a", "b"])
    s.openRename("a")
    s.openDeleteForever(["a"])
    s.setEmptyTrashOpen(true)
    s.openFolderDialog({ mode: "create", parentId: "root" })
    s.openMoveFolder("lbf_b")
    s.openDeleteFolder("lbf_a")
    s.openSaveTemplate("canvas:c1")
    s.openShare(["canvas:c1", "image:h"])
    expect(useFilesLibraryStore.getState()).toMatchObject({
      moveTarget: ["a", "b"],
      renameTarget: "a",
      deleteForeverTarget: ["a"],
      emptyTrashOpen: true,
      folderDialog: { mode: "create", parentId: "root" },
      moveFolderTarget: "lbf_b",
      deleteFolderTarget: "lbf_a",
      saveTemplateTarget: "canvas:c1",
      shareTarget: ["canvas:c1", "image:h"],
    })
    s.closeMove()
    s.closeRename()
    s.closeDeleteForever()
    s.setEmptyTrashOpen(false)
    s.closeFolderDialog()
    s.closeMoveFolder()
    s.closeDeleteFolder()
    s.closeSaveTemplate()
    s.closeShare()
    expect(useFilesLibraryStore.getState()).toMatchObject({
      moveTarget: null,
      renameTarget: null,
      deleteForeverTarget: null,
      emptyTrashOpen: false,
      folderDialog: null,
      moveFolderTarget: null,
      deleteFolderTarget: null,
      saveTemplateTarget: null,
      shareTarget: null,
    })
  })
})
