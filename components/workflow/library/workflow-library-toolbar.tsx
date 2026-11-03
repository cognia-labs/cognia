"use client"

// The workflow library's view-bar pieces. The page header owns the layout
// (search, then filter/sort/view pushed right, and the import / new-folder
// buttons in its identity row), so this module hands it data and parts rather
// than drawing a toolbar of its own:
//
//  - `useWorkflowLibrarySearch` keeps a local controlled value for
//    responsiveness and writes through to the store query on a 200ms trailing
//    debounce, so filtering doesn't run every keystroke. "Clear search and
//    filters" bumps the store's `searchResetKey`; the hook then empties the
//    text, and a keystroke still waiting out the debounce is dropped rather
//    than re-applying the query after the clear.
//  - `WorkflowLibraryControls` is the filter, sort and view toggle.
//  - `WorkflowImportInput` is the hidden file picker the header's Import
//    button opens.

import { useState } from "react"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { WorkflowLibraryViewToggle } from "./workflow-library-view-toggle"
import { WorkflowSortMenu } from "./workflow-sort-menu"
import { WorkflowFilterBar } from "./workflow-filter-bar"

/** Debounce between the last keystroke and the store query write. */
export const SEARCH_DEBOUNCE_MS = 200

export interface WorkflowLibrarySearchState {
  value: string
  onChange: (value: string) => void
}

export function useWorkflowLibrarySearch(): WorkflowLibrarySearchState {
  const setQuery = useWorkflowLibraryStore((s) => s.setQuery)
  const storeQuery = useWorkflowLibraryStore((s) => s.query)
  const searchResetKey = useWorkflowLibraryStore((s) => s.searchResetKey)
  const [text, setText] = useState(storeQuery)
  // Each keystroke carries the reset generation it was typed under, so a write
  // still waiting out the debounce when "Clear search and filters" lands is
  // dropped instead of hiding every row again.
  const { call } = useDebouncedCallback((value: string, generation: number) => {
    if (generation === useWorkflowLibraryStore.getState().searchResetKey) setQuery(value)
  }, SEARCH_DEBOUNCE_MS)

  // A clear re-reads the (now empty) store query during render rather than in
  // an effect, so the box never paints one frame still holding the old text.
  const [seenResetKey, setSeenResetKey] = useState(searchResetKey)
  if (searchResetKey !== seenResetKey) {
    setSeenResetKey(searchResetKey)
    setText(storeQuery)
  }

  return {
    value: text,
    onChange: (value: string) => {
      setText(value)
      call(value, searchResetKey)
    },
  }
}

/** Filter, sort and view toggle: the right end of the header's view bar. */
export function WorkflowLibraryControls() {
  return (
    <>
      <WorkflowFilterBar />
      <WorkflowSortMenu />
      <WorkflowLibraryViewToggle />
    </>
  )
}

export interface WorkflowImportInputProps {
  inputRef: React.Ref<HTMLInputElement>
  onImportFiles: (files: FileList) => void
}

/** The hidden JSON picker behind the header's Import button. */
export function WorkflowImportInput({ inputRef, onImportFiles }: WorkflowImportInputProps) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="application/json,.json"
      multiple
      className="hidden"
      data-testid="workflow-import-input"
      onChange={(e) => {
        if (e.target.files && e.target.files.length > 0) onImportFiles(e.target.files)
        e.target.value = "" // allow re-importing the same file
      }}
    />
  )
}
