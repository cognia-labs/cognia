/**
 * Unified per-file Access & Sharing explanation for Files (G08 / ADR-0222 / ADR-0223 §10):
 * combines active snapshot share links (`sharedLinks`) and active/suspended/stale
 * live FileSpace grants (`cognia-file-share`) covering an entry.
 *
 * Secret decryption fragments (`#k=...`) are stripped from URLs before returning,
 * so paired devices can inspect active shares over `files_library_access_get`
 * without ever receiving decryption keys or owner tokens.
 */

import { getLibraryItem } from "@/lib/db/files-library-items"
import type { LibraryItemRow } from "@/lib/db/files-library-types"
import { listSharedLinks, type SharedLinkRow } from "@/lib/db/shared-links"
import { listLiveGrants } from "@/lib/filespace/grants-client"
import { loadConversationFileSpace } from "@/lib/filespace/load"
import { isFileSpacePathWithin, normalizeFileSpacePath } from "@/lib/filespace/paths"
import { listFileSpaceDexieEntries, type FileSpaceDexieListing } from "@/lib/filespace/sources"
import { isTauri } from "@/lib/platform/detect"
import type { ConversationFileSpace, FileSpacePath } from "@/types/filespace"
import type {
  LiveGrantStatus,
  LiveGrantView,
  LivePermission,
  LiveProtocol,
} from "@/types/filespace/live"

import type { FilesEntry } from "./types"

export interface FilesShareLinkAccess {
  code: string
  title: string
  kind: string
  createdAt: number
  expiresAt: number
  /** Public viewer URL with any `#k=` decryption fragment stripped. */
  url: string
}

export interface FilesLiveGrantAccess {
  id: string
  sessionId: string
  label: string | null
  audienceKind: "credentials" | "collab"
  protocols: LiveProtocol[]
  permissions: LivePermission[]
  status: Extract<LiveGrantStatus, "active" | "suspended" | "stale">
  expiresAt: number
  matchedPaths: string[]
}

export interface FilesEntryAccess {
  sharedLinks: FilesShareLinkAccess[]
  liveGrants: FilesLiveGrantAccess[]
}

export const EMPTY_FILES_ENTRY_ACCESS: FilesEntryAccess = {
  sharedLinks: [],
  liveGrants: [],
}

export interface FilesAccessDeps {
  now: () => number
  getLibraryItem: (key: string) => Promise<LibraryItemRow | undefined>
  listSharedLinks: () => Promise<SharedLinkRow[]>
  hasLiveGrants: () => boolean
  listLiveGrants: (query: { sessionId?: string }) => Promise<LiveGrantView[]>
  loadFileSpace: (sessionId: string) => Promise<ConversationFileSpace>
  listDexieEntries: (sessionId: string) => Promise<FileSpaceDexieListing>
}

const defaultDeps: FilesAccessDeps = {
  now: () => Date.now(),
  getLibraryItem,
  listSharedLinks: () => listSharedLinks({ includeRevoked: false }),
  hasLiveGrants: isTauri,
  listLiveGrants: (query) => listLiveGrants(query),
  loadFileSpace: loadConversationFileSpace,
  listDexieEntries: listFileSpaceDexieEntries,
}

function stripUrlFragment(url: string): string {
  const hashIndex = url.indexOf("#")
  return hashIndex === -1 ? url : url.slice(0, hashIndex)
}

function isGrantRelevantStatus(status: LiveGrantStatus): status is FilesLiveGrantAccess["status"] {
  return status === "active" || status === "suspended" || status === "stale"
}

function matchesVirtualTarget(target: FileSpacePath, grantVirtualPath: string): boolean {
  const prefix = normalizeFileSpacePath(grantVirtualPath)
  return prefix ? isFileSpacePathWithin(target, prefix) : false
}

export async function resolveFilesEntryAccess(
  entry: FilesEntry,
  overrides: Partial<FilesAccessDeps> = {}
): Promise<FilesEntryAccess> {
  const deps = { ...defaultDeps, ...overrides }
  const now = deps.now()

  const [item, links] = await Promise.all([
    deps.getLibraryItem(entry.key).catch(() => undefined),
    deps.listSharedLinks().catch(() => [] as SharedLinkRow[]),
  ])

  const recordedCodes = new Set(item?.sharedLinkCodes ?? [])
  const sharedLinks: FilesShareLinkAccess[] = links
    .filter((link) => {
      if (link.revoked || link.expiresAt <= now) return false
      if (recordedCodes.has(link.code)) return true
      if (entry.contentHash && link.files?.some((file) => file.sha256 === entry.contentHash)) {
        return true
      }
      return false
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((link) => ({
      code: link.code,
      title: link.title,
      kind: link.kind,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      url: stripUrlFragment(link.url),
    }))

  if (!deps.hasLiveGrants()) {
    return { sharedLinks, liveGrants: [] }
  }

  const sessionIds = [
    ...new Set(
      [entry.originSessionId, ...entry.sessionIds].filter(
        (id): id is string => typeof id === "string" && id.length > 0
      )
    ),
  ]
  if (sessionIds.length === 0) {
    return { sharedLinks, liveGrants: [] }
  }

  const grantsById = new Map<string, FilesLiveGrantAccess>()
  for (const sessionId of sessionIds) {
    let views: LiveGrantView[]
    try {
      views = await deps.listLiveGrants({ sessionId })
    } catch {
      continue
    }
    const candidates = views.filter(
      ({ grant }) => isGrantRelevantStatus(grant.status) && grant.expiresAt > now
    )
    if (candidates.length === 0) continue

    let spacePromise: Promise<ConversationFileSpace | null> | null = null
    let dexiePromise: Promise<FileSpaceDexieListing | null> | null = null
    const getSpace = () => {
      spacePromise ??= deps.loadFileSpace(sessionId).catch(() => null)
      return spacePromise
    }
    const getDexie = () => {
      dexiePromise ??= deps.listDexieEntries(sessionId).catch(() => null)
      return dexiePromise
    }

    for (const { grant } of candidates) {
      if (!isGrantRelevantStatus(grant.status)) continue
      const matchedPaths = new Set<string>()

      if (entry.kind === "workspace-file" && entry.workspace) {
        const space = await getSpace()
        const matchingMountIds = new Set(
          (space?.mounts ?? [])
            .filter(
              (mount) =>
                mount.backing === "disk" && mount.hostPath === entry.workspace!.workspaceRoot
            )
            .map((mount) => mount.id)
        )
        for (const gp of grant.paths) {
          if (!matchingMountIds.has(gp.mountId as never)) continue
          if (
            gp.relPath === "" ||
            entry.workspace.relPath === gp.relPath ||
            entry.workspace.relPath.startsWith(`${gp.relPath}/`)
          ) {
            matchedPaths.add(gp.virtualPath)
          }
        }
      } else if (entry.kind === "artifact") {
        for (const gp of grant.paths) {
          if (gp.mountId !== "artifacts") continue
          if (gp.relPath === "") {
            matchedPaths.add(gp.virtualPath)
            continue
          }
          const dexie = await getDexie()
          const target = dexie?.artifacts.find((a) => a.sourceId === entry.sourceId)
          if (target && matchesVirtualTarget(target.path, gp.virtualPath)) {
            matchedPaths.add(gp.virtualPath)
          }
        }
      } else if (
        entry.kind === "upload" ||
        entry.kind === "session-upload" ||
        entry.kind === "image" ||
        entry.kind === "generated-video"
      ) {
        for (const gp of grant.paths) {
          if (gp.mountId !== "uploads") continue
          if (gp.relPath === "") {
            matchedPaths.add(gp.virtualPath)
            continue
          }
          const dexie = await getDexie()
          const targets = (dexie?.uploads ?? []).filter(
            (u) =>
              u.sourceId === entry.sourceId ||
              (Boolean(entry.contentHash) && u.contentHash === entry.contentHash)
          )
          if (targets.some((target) => matchesVirtualTarget(target.path, gp.virtualPath))) {
            matchedPaths.add(gp.virtualPath)
          }
        }
      }

      if (matchedPaths.size > 0) {
        const existing = grantsById.get(grant.id)
        if (existing) {
          for (const p of matchedPaths) {
            if (!existing.matchedPaths.includes(p)) existing.matchedPaths.push(p)
          }
        } else {
          grantsById.set(grant.id, {
            id: grant.id,
            sessionId: grant.sessionId,
            label: grant.label,
            audienceKind: grant.audience.kind,
            protocols: [...grant.protocols],
            permissions: [...grant.permissions],
            status: grant.status,
            expiresAt: grant.expiresAt,
            matchedPaths: [...matchedPaths],
          })
        }
      }
    }
  }

  return {
    sharedLinks,
    liveGrants: [...grantsById.values()].sort((a, b) => b.expiresAt - a.expiresAt),
  }
}
