/**
 * Which workspaces get a shortcut: the ones the user pinned, and the ones they
 * used last.
 *
 * One definition, read by the workspace picker's Pinned / Recent groups
 * (`components/workspace/workspace-picker-list.tsx`) and by the expanded
 * sidebar's workspace shortcuts (`components/shell/sidebar-workspace-shortcuts.tsx`).
 * Two copies of "recent" is how two lists start disagreeing about it.
 */

import type { Project } from "@/types"

/** How many most-recently-used workspaces a shortcut list carries. */
export const RECENT_WORKSPACE_COUNT = 3

type QuickAccessRow = Pick<Project, "id" | "name"> &
  Partial<Pick<Project, "pinned" | "lastAccessedAt" | "isArchived">>

/**
 * When the workspace was last opened, in ms. `lastAccessedAt` is a `Date` in
 * the store but can arrive as an ISO string from a persisted row; a missing or
 * unreadable value sorts as never used rather than poisoning the comparator
 * with `NaN`.
 */
function lastUsedAt(row: QuickAccessRow): number {
  const at = new Date(row.lastAccessedAt ?? 0).getTime()
  return Number.isFinite(at) ? at : 0
}

/** Pinned workspaces, by name. */
export function pinnedWorkspaces<T extends QuickAccessRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.pinned).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The `count` most recently used workspaces, newest first. The sort is stable,
 * so workspaces never opened keep the order they came in.
 */
export function recentWorkspaces<T extends QuickAccessRow>(
  rows: readonly T[],
  {
    count = RECENT_WORKSPACE_COUNT,
    exclude,
  }: { count?: number; exclude?: (row: T) => boolean } = {}
): T[] {
  return rows
    .filter((row) => !exclude?.(row))
    .sort((a, b) => lastUsedAt(b) - lastUsedAt(a))
    .slice(0, count)
}

export interface WorkspaceShortcuts<T> {
  pinned: T[]
  /** Recently used and not pinned: a pinned workspace already has its row. */
  recent: T[]
}

/**
 * The workspaces worth one click from the sidebar: pinned first, then the
 * recent ones. The active workspace is left out (the sidebar is already
 * headed by it, and a shortcut to where you are switches nothing), and so is
 * an archived one.
 */
export function workspaceShortcuts<T extends QuickAccessRow>(
  rows: readonly T[],
  activeId: string | null
): WorkspaceShortcuts<T> {
  const candidates = rows.filter((row) => !row.isArchived && row.id !== activeId)
  return {
    pinned: pinnedWorkspaces(candidates),
    recent: recentWorkspaces(candidates, { exclude: (row) => Boolean(row.pinned) }),
  }
}
