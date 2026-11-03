/**
 * @jest-environment jsdom
 */

import { createRef } from "react"
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import {
  SEARCH_DEBOUNCE_MS,
  WorkflowImportInput,
  WorkflowLibraryControls,
  useWorkflowLibrarySearch,
} from "./workflow-library-toolbar"
import { DEFAULT_WORKFLOW_FILTERS, useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(() => {
  useWorkflowLibraryStore.setState({
    query: "",
    searchResetKey: 0,
    currentFolderId: ROOT_FOLDER_ID,
    createFolderParentId: null,
    filters: { ...DEFAULT_WORKFLOW_FILTERS },
    sort: "updated",
    viewMode: "grid",
  })
})

describe("useWorkflowLibrarySearch", () => {
  it("starts from the store query", () => {
    useWorkflowLibraryStore.setState({ query: "digest" })
    const { result } = renderHook(() => useWorkflowLibrarySearch())
    expect(result.current.value).toBe("digest")
  })

  it("debounces the search text into the store query", () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useWorkflowLibrarySearch())
      act(() => result.current.onChange("digest"))
      // The box follows every keystroke; the store waits out the debounce.
      expect(result.current.value).toBe("digest")
      expect(useWorkflowLibraryStore.getState().query).toBe("")
      act(() => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 50)
      })
      expect(useWorkflowLibraryStore.getState().query).toBe("digest")
    } finally {
      jest.useRealTimers()
    }
  })

  it("empties the search text when the search and filters are cleared", () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useWorkflowLibrarySearch())
      act(() => result.current.onChange("digest"))
      act(() => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 50)
      })
      expect(useWorkflowLibraryStore.getState().query).toBe("digest")

      act(() => {
        useWorkflowLibraryStore.getState().clearSearchAndFilters()
      })
      expect(result.current.value).toBe("")
      expect(useWorkflowLibraryStore.getState().query).toBe("")
    } finally {
      jest.useRealTimers()
    }
  })

  it("drops a keystroke still inside the debounce window when the search is cleared", () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useWorkflowLibrarySearch())
      act(() => result.current.onChange("digest"))
      // Cleared before the 200ms write lands.
      act(() => {
        useWorkflowLibraryStore.getState().clearSearchAndFilters()
      })
      act(() => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 3)
      })
      // The pending write must not resurrect the query the user just cleared.
      expect(useWorkflowLibraryStore.getState().query).toBe("")
      expect(result.current.value).toBe("")
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps searching normally after a clear", () => {
    jest.useFakeTimers()
    try {
      const { result } = renderHook(() => useWorkflowLibrarySearch())
      act(() => {
        useWorkflowLibraryStore.getState().clearSearchAndFilters()
      })
      act(() => result.current.onChange("report"))
      act(() => {
        jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS + 50)
      })
      expect(useWorkflowLibraryStore.getState().query).toBe("report")
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("WorkflowLibraryControls", () => {
  it("renders the filter, sort and view controls", () => {
    render(<WorkflowLibraryControls />)
    expect(screen.getByTestId("workflow-filter-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-sort-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-library-view-toggle")).toBeInTheDocument()
  })
})

describe("WorkflowImportInput", () => {
  it("forwards picked files to onImportFiles and lets the same file be picked again", () => {
    const onImportFiles = jest.fn()
    const ref = createRef<HTMLInputElement>()
    render(<WorkflowImportInput inputRef={ref} onImportFiles={onImportFiles} />)
    expect(ref.current).toBe(screen.getByTestId("workflow-import-input"))
    const file = new File(['{"nodes":[],"edges":[]}'], "wf.json", { type: "application/json" })
    fireEvent.change(screen.getByTestId("workflow-import-input"), { target: { files: [file] } })
    expect(onImportFiles).toHaveBeenCalledTimes(1)
    expect(ref.current?.value).toBe("")
  })

  it("ignores an empty pick", () => {
    const onImportFiles = jest.fn()
    render(<WorkflowImportInput inputRef={createRef()} onImportFiles={onImportFiles} />)
    fireEvent.change(screen.getByTestId("workflow-import-input"), { target: { files: [] } })
    expect(onImportFiles).not.toHaveBeenCalled()
  })
})
