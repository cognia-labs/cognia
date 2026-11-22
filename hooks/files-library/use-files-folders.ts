"use client"

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { listLibraryCollections, listLibraryFolders } from "@/lib/db/files-library-folders"
import type { LibraryFolder, LibrarySmartCollection } from "@/lib/db/files-library-types"

const EMPTY: LibraryFolder[] = []
const EMPTY_COLLECTIONS: LibrarySmartCollection[] = []

/**
 * Every Files folder, live. Empty until the first read resolves, and while
 * `enabled` is false (the page draws another device's library).
 */
export function useFilesFolders({ enabled = true }: { enabled?: boolean } = {}): LibraryFolder[] {
  return (
    useClientLiveQuery(() => (enabled ? listLibraryFolders() : EMPTY), [enabled], EMPTY) ?? EMPTY
  )
}

/** Every saved Smart Collection, live. */
export function useFilesCollections({
  enabled = true,
}: { enabled?: boolean } = {}): LibrarySmartCollection[] {
  return (
    useClientLiveQuery(
      () => (enabled ? listLibraryCollections() : EMPTY_COLLECTIONS),
      [enabled],
      EMPTY_COLLECTIONS
    ) ?? EMPTY_COLLECTIONS
  )
}
