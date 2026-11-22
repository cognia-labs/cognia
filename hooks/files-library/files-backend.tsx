"use client"

/**
 * Which library the Files page manages, and how (ADR-0223).
 *
 * `FilesLibrary` mounts one backend for the page: this device's own database
 * (`useLocalFilesBackend`) or, on a paired device, the host's library over
 * `files_library_*` (`useRemoteFilesBackend`, §9). Everything below reads it
 * from here — the page model, its actions, the folder dialogs, thumbnails and
 * the preview — so neither layout knows which one it is drawing.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import type { MissingMediaLoader } from "@/lib/chat/media/resolve-media"
import type { LibraryFolder, LibrarySmartCollection } from "@/lib/db/files-library-types"
import { documentDraftOf } from "@/lib/files-library/document-draft"
import { createLocalFilesOps, type FilesOps } from "@/lib/files-library/ops"
import { searchFilesBodies } from "@/lib/files-library/text-index"
import type { FilesEntry } from "@/lib/files-library/types"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useFilesLibraryStore } from "@/stores/files-library"

import { useFilesEntries } from "./use-files-entries"
import { useFilesCollections, useFilesFolders } from "./use-files-folders"

/** The library's contents as the page reads them. */
export interface FilesSource {
  /** Undefined until the first read resolves. */
  entries: FilesEntry[] | undefined
  imagesTruncated: boolean
  loadMoreImages: () => void
  folders: LibraryFolder[]
  collections?: LibrarySmartCollection[]
  /**
   * Items the search matched inside their content, beyond what the entries'
   * own haystack holds — full segmented text past the 20k excerpt, workspace
   * disk content, or a paired device's titles-only entries.
   */
  contentMatches?: ReadonlySet<string>
  /** Match snippets (`entry.key -> snippet`) for the active search query. */
  searchSnippets?: ReadonlyMap<string, string>
  /** True when the host's body search stopped at its hit ceiling (`limit`). */
  searchTruncated?: boolean
  /** The last host body search failed (`files.errors.*` code). */
  searchError?: string
  /** Re-run a failed host body search. */
  retrySearch?: () => void
  /** Read the library again (pull to refresh, Retry). Absent where it is live. */
  refresh?: () => Promise<void>
  /** The last read failed; the page offers Retry. */
  error?: string
}

export interface FilesBackend {
  source: FilesSource
  ops: FilesOps
  /**
   * Where an entry's missing image bytes come from. Absent for this device's
   * own library, where every byte is already in the media store.
   */
  mediaLoaderFor?: (entry: FilesEntry) => MissingMediaLoader | undefined
}

const FilesBackendContext = createContext<FilesBackend | null>(null)

export function FilesBackendProvider({
  backend,
  children,
}: {
  backend: FilesBackend
  children: ReactNode
}) {
  return <FilesBackendContext.Provider value={backend}>{children}</FilesBackendContext.Provider>
}

const LOCAL_OPS = createLocalFilesOps()

/**
 * The page's backend. Outside a provider — a component rendered on its own,
 * or a test — it is this device's library, the page's long-standing default.
 */
export function useFilesOps(): FilesOps {
  return useContext(FilesBackendContext)?.ops ?? LOCAL_OPS
}

export function useFilesBackendContext(): FilesBackend | null {
  return useContext(FilesBackendContext)
}

/** The loader for one entry's image bytes, when they live on another device. */
export function useFilesMediaLoader(entry: FilesEntry | undefined): MissingMediaLoader | undefined {
  const loaderFor = useContext(FilesBackendContext)?.mediaLoaderFor
  // A re-read list hands over new entry objects, and so a new loader; the
  // media cache answers the re-acquire from memory, so nothing is fetched again.
  return useMemo(() => (entry && loaderFor ? loaderFor(entry) : undefined), [loaderFor, entry])
}

/**
 * This device's own library: live Dexie reads and the local writers.
 * `enabled: false` keeps the hook mounted without reading anything, for a
 * page whose provider already supplies the library.
 */
export function useLocalFilesBackend({ enabled = true }: { enabled?: boolean } = {}): FilesBackend {
  const { entries, imagesTruncated, loadMoreImages, entryContentKeys } = useFilesEntries({
    enabled,
  })
  const folders = useFilesFolders({ enabled })
  const collections = useFilesCollections({ enabled })
  const search = useFilesLibraryStore((s) => s.search)
  const searchGenRef = useRef(0)
  const [bodyState, setBodyState] = useState<{
    for: string
    matchedKeys: ReadonlySet<string>
    snippets: ReadonlyMap<string, string>
    truncated: boolean
  } | null>(null)

  useEffect(() => {
    if (!enabled || !entries) return
    const query = search.trim()
    if (!query) {
      searchGenRef.current += 1
      return
    }
    const run = ++searchGenRef.current
    const timer = setTimeout(() => {
      void searchFilesBodies({
        query,
        entries,
        ...(entryContentKeys ? { entryContentKeys } : {}),
        readDocumentText: (entry) =>
          documentDraftOf(entry, useArtifactStore.getState())?.content ?? null,
      })
        .then((res) => {
          if (run !== searchGenRef.current) return
          setBodyState({
            for: search,
            matchedKeys: res.matchedKeys,
            snippets: res.snippets,
            truncated: res.truncated,
          })
        })
        .catch(() => undefined)
    }, 120)
    return () => clearTimeout(timer)
  }, [enabled, entries, entryContentKeys, search])

  const activeSearch = bodyState && bodyState.for === search ? bodyState : undefined

  return useMemo(
    () => ({
      source: {
        entries,
        imagesTruncated,
        loadMoreImages,
        folders,
        collections,
        ...(activeSearch ? { contentMatches: activeSearch.matchedKeys } : {}),
        ...(activeSearch ? { searchSnippets: activeSearch.snippets } : {}),
        ...(activeSearch?.truncated ? { searchTruncated: true } : {}),
      },
      ops: LOCAL_OPS,
    }),
    [entries, imagesTruncated, loadMoreImages, folders, collections, activeSearch]
  )
}
