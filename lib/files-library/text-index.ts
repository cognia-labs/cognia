/**
 * Content-addressed segmented full-text search index & snippet extraction for
 * the Files library (G01).
 *
 * Why a dedicated module:
 * - `aggregate.ts` is pure and synchronous; `filter.ts` is stateless.
 * - Full-body text for large artifacts, canvas documents and extracted uploads
 *   can exceed the 20k-char in-memory card excerpt (`FILES_BODY_EXCERPT_CHARS`).
 * - This module slices full bodies into `4–8 KiB` overlapping segments in
 *   `db.libraryTextSegments` (deduplicated by `contentHash` across uploads),
 *   extracts centered match snippets, and fuses native on-demand workspace
 *   content search (`fs_search_content_workspace`) for `workspace-file` items
 *   without mirroring workspace disk trees into IndexedDB.
 */

import { getDb } from "@/lib/db/schema"
import type { LibraryItemKind, LibraryTextSegment } from "@/lib/db/files-library-types"
import type { WorkspaceContentMatch } from "@/lib/files/types"
import { searchWorkspaceContent } from "@/lib/files/workspace-fs"
import type { FilesEntry } from "./types"
import { hasLocalWorkspaceFiles, workspaceFileRoots } from "./workspace-files-io"

/** 6 KiB per segment (within the 4–8 KiB budget). */
export const FILES_TEXT_SEGMENT_CHARS = 6_144
/** Small overlap so multi-word queries straddling a boundary still match inside one segment. */
export const FILES_TEXT_SEGMENT_OVERLAP_CHARS = 128
/** Hard cap on cached segments in IndexedDB across the profile. */
export const FILES_TEXT_SEGMENTS_MAX = 25_000
/** Maximum snippet length returned for a match. */
export const FILES_SNIPPET_MAX_CHARS = 140

export function uploadTextContentKey(contentHash: string): string {
  return `upload:${contentHash}`
}

export function documentTextContentKey(
  kind: Extract<LibraryItemKind, "artifact" | "canvas">,
  id: string,
  updatedAt: number,
  charLength: number
): string {
  return `doc:${kind}:${id}:${updatedAt}:${charLength}`
}

/** Split `text` into 6 KiB overlapping segments. Empty / whitespace-only text yields `[]`. */
export function splitIntoTextSegments(
  text: string,
  segmentChars = FILES_TEXT_SEGMENT_CHARS,
  overlapChars = FILES_TEXT_SEGMENT_OVERLAP_CHARS
): string[] {
  if (!text || !text.trim()) return []
  if (text.length <= segmentChars) return [text]
  const step = Math.max(1, segmentChars - Math.min(overlapChars, Math.floor(segmentChars / 2)))
  const segments: string[] = []
  for (let start = 0; start < text.length; start += step) {
    const slice = text.slice(start, start + segmentChars)
    segments.push(slice)
    if (start + segmentChars >= text.length) break
  }
  return segments
}

/**
 * Extract a concise single-line snippet centered around the earliest match of
 * any whitespace-separated term in `query`. Undefined when no term appears in `text`.
 */
export function extractMatchSnippet(
  text: string,
  query: string,
  maxChars = FILES_SNIPPET_MAX_CHARS
): string | undefined {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!text || terms.length === 0) return undefined
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  const lower = normalized.toLowerCase()
  let bestIndex = -1
  let matchedLen = 0
  for (const term of terms) {
    const idx = lower.indexOf(term)
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx
      matchedLen = term.length
    }
  }
  if (bestIndex === -1) return undefined
  if (normalized.length <= maxChars) return normalized
  const half = Math.max(16, Math.floor((maxChars - matchedLen) / 2))
  let start = Math.max(0, bestIndex - half)
  const end = Math.min(normalized.length, start + maxChars)
  if (end - start < maxChars) {
    start = Math.max(0, end - maxChars)
  }
  const prefix = start > 0 ? "…" : ""
  const suffix = end < normalized.length ? "…" : ""
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`
}

/**
 * Reconcile `db.libraryTextSegments` against the active library's text sources:
 * - Inserts segments for `contentKey`s not yet indexed.
 * - Deletes segments whose `contentKey` is no longer present in `sources`.
 * - Enforces `FILES_TEXT_SEGMENTS_MAX` by evicting oldest `contentKey` groups.
 */
export async function syncFilesTextIndex(sources: ReadonlyMap<string, string>): Promise<void> {
  const db = getDb()
  const existingKeys = new Set<string>(
    (await db.libraryTextSegments.orderBy("contentKey").uniqueKeys()).map(String)
  )
  const staleKeys = [...existingKeys].filter((key) => !sources.has(key))
  const missingEntries = [...sources.entries()].filter(
    ([key, text]) => !existingKeys.has(key) && text.trim().length > 0
  )
  if (staleKeys.length === 0 && missingEntries.length === 0) return

  const now = Date.now()
  const toInsert: LibraryTextSegment[] = []
  for (const [contentKey, fullText] of missingEntries) {
    const parts = splitIntoTextSegments(fullText)
    for (let index = 0; index < parts.length; index += 1) {
      if (toInsert.length >= FILES_TEXT_SEGMENTS_MAX) break
      toInsert.push({
        id: `${contentKey}:${index}`,
        contentKey,
        segmentIndex: index,
        text: parts[index]!,
        updatedAt: now,
      })
    }
    if (toInsert.length >= FILES_TEXT_SEGMENTS_MAX) break
  }

  await db.transaction("rw", db.libraryTextSegments, async () => {
    if (staleKeys.length > 0) {
      await db.libraryTextSegments.where("contentKey").anyOf(staleKeys).delete()
    }
    if (toInsert.length > 0) {
      await db.libraryTextSegments.bulkPut(toInsert)
    }
    const total = await db.libraryTextSegments.count()
    if (total > FILES_TEXT_SEGMENTS_MAX) {
      const excess = total - FILES_TEXT_SEGMENTS_MAX
      const oldest = await db.libraryTextSegments.orderBy("updatedAt").limit(excess).primaryKeys()
      if (oldest.length > 0) await db.libraryTextSegments.bulkDelete(oldest)
    }
  })
}

export function entryContentKey(entry: FilesEntry): string | undefined {
  if (entry.kind === "artifact" || entry.kind === "canvas") {
    return undefined
  }
  if (entry.contentHash) return uploadTextContentKey(entry.contentHash)
  return undefined
}

export interface SearchFilesBodiesOptions {
  query: string
  entries: readonly FilesEntry[]
  /** Optional explicit map of `entry.key -> contentKey` from `loadFilesSources`. */
  entryContentKeys?: ReadonlyMap<string, string>
  /** Optional document reader fallback when segments are still syncing. */
  readDocumentText?: (entry: FilesEntry) => string | null
  /** Optional native workspace content search override (defaults to `searchWorkspaceContent` on Tauri). */
  searchWorkspace?: (
    root: string,
    query: string,
    options?: { maxResults?: number }
  ) => Promise<WorkspaceContentMatch[]>
  /** Max matches per workspace root (default 200). */
  workspaceLimit?: number
}

export interface SearchFilesBodiesResult {
  matchedKeys: Set<string>
  snippets: Map<string, string>
  /** True when native workspace content search hit its per-root ceiling. */
  truncated: boolean
}

function normalizeRelPath(relPath: string): string {
  return relPath.replaceAll("\\", "/").replace(/^\/+/, "")
}

/**
 * Search full segmented bodies in `db.libraryTextSegments` plus on-demand
 * native workspace content (`fs_search_content_workspace`), returning both the
 * set of matching entry keys and a match snippet per entry.
 */
export async function searchFilesBodies(
  options: SearchFilesBodiesOptions
): Promise<SearchFilesBodiesResult> {
  const trimmed = options.query.trim()
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  const matchedKeys = new Set<string>()
  const snippets = new Map<string, string>()
  if (terms.length === 0) return { matchedKeys, snippets, truncated: false }

  const liveEntries = options.entries.filter(
    (entry) => entry.trashedAt === undefined && !entry.hidden
  )
  const keyToContentKey = new Map<string, string>()
  const wantedContentKeys = new Set<string>()
  for (const entry of liveEntries) {
    const ck = options.entryContentKeys?.get(entry.key) ?? entryContentKey(entry)
    if (ck) {
      keyToContentKey.set(entry.key, ck)
      wantedContentKeys.add(ck)
    }
  }

  const segmentsByContentKey = new Map<string, LibraryTextSegment[]>()
  if (wantedContentKeys.size > 0) {
    const rows = await getDb()
      .libraryTextSegments.where("contentKey")
      .anyOf([...wantedContentKeys])
      .toArray()
    for (const row of rows) {
      const list = segmentsByContentKey.get(row.contentKey)
      if (list) list.push(row)
      else segmentsByContentKey.set(row.contentKey, [row])
    }
    for (const list of segmentsByContentKey.values()) {
      list.sort((a, b) => a.segmentIndex - b.segmentIndex)
    }
  }

  for (const entry of liveEntries) {
    if (entry.kind === "workspace-file") continue
    const ck = keyToContentKey.get(entry.key)
    const segments = ck ? segmentsByContentKey.get(ck) : undefined
    const headerLower = [
      entry.title,
      entry.sourceTitle,
      entry.mediaType ?? "",
      entry.subtype ?? "",
      entry.language ?? "",
      ...(entry.tags ?? []),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase()

    if (segments && segments.length > 0) {
      const lowerSegments = segments.map((seg) => seg.text.toLowerCase())
      const allFound = terms.every(
        (term) => headerLower.includes(term) || lowerSegments.some((seg) => seg.includes(term))
      )
      if (!allFound) continue
      matchedKeys.add(entry.key)
      for (const seg of segments) {
        const snippet = extractMatchSnippet(seg.text, trimmed)
        if (snippet) {
          snippets.set(entry.key, snippet)
          break
        }
      }
      continue
    }

    // Immediate fallback before async segment sync finishes (or when called in unit tests without sync).
    const fallbackBody = options.readDocumentText?.(entry) ?? entry.excerpt ?? undefined
    const fullLower = fallbackBody
      ? `${headerLower}\n${fallbackBody.toLowerCase()}`
      : entry.searchText
    if (terms.every((term) => fullLower.includes(term))) {
      matchedKeys.add(entry.key)
      if (fallbackBody) {
        const snippet = extractMatchSnippet(fallbackBody, trimmed)
        if (snippet) snippets.set(entry.key, snippet)
      }
    }
  }

  // On-demand native workspace content search for `workspace-file` items.
  let truncated = false
  const wsSearch =
    options.searchWorkspace ?? (hasLocalWorkspaceFiles() ? searchWorkspaceContent : undefined)
  if (wsSearch && trimmed.length >= 2) {
    const workspaceLimit = options.workspaceLimit ?? 200
    const entriesByRootAndPath = new Map<string, FilesEntry[]>()
    const roots = new Set<string>()
    for (const entry of liveEntries) {
      if (entry.kind !== "workspace-file" || !entry.workspace) continue
      const candidateRoots = workspaceFileRoots(entry.workspace)
      const normPath = normalizeRelPath(entry.workspace.relPath)
      for (const root of candidateRoots) {
        if (!root) continue
        roots.add(root)
        const mapKey = `${root}\u0000${normPath}`
        const bucket = entriesByRootAndPath.get(mapKey)
        if (bucket) bucket.push(entry)
        else entriesByRootAndPath.set(mapKey, [entry])
      }
    }
    const primaryTerm = [...terms].sort((a, b) => b.length - a.length)[0]!
    await Promise.all(
      [...roots].map(async (root) => {
        try {
          const hits = await wsSearch(root, primaryTerm, { maxResults: workspaceLimit })
          if (hits.length >= workspaceLimit) truncated = true
          for (const hit of hits) {
            const matched = entriesByRootAndPath.get(
              `${root}\u0000${normalizeRelPath(hit.relPath)}`
            )
            if (!matched) continue
            const lineLower = hit.preview.toLowerCase()
            for (const entry of matched) {
              const combined = `${entry.searchText}\n${lineLower}`
              if (terms.every((term) => combined.includes(term))) {
                matchedKeys.add(entry.key)
                if (!snippets.has(entry.key)) {
                  const snippet =
                    extractMatchSnippet(hit.preview, trimmed) ??
                    hit.preview.trim().slice(0, FILES_SNIPPET_MAX_CHARS)
                  if (snippet) snippets.set(entry.key, snippet)
                }
              }
            }
          }
        } catch {
          // Unreachable or missing workspace root degrades gracefully to path/title search.
        }
      })
    )
  }

  return { matchedKeys, snippets, truncated }
}
