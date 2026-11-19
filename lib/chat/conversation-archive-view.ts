/**
 * What a conversation list's Archived view changes about the list's own state
 * (ADR-0213), and the reach its "Search everywhere" hands on — the desktop
 * sidebar, the phone drawer and the conversation manager share these. Pure, so
 * the rules are pinned without mounting a list.
 */

import type { ChannelListView } from "@/stores/ui/ui-store"

/** Prefix the archive's section fold choices are stored under. */
export const ARCHIVED_COLLAPSE_PREFIX = "archived:"

/**
 * The key a fold choice is stored under for `view`. Section keys
 * (`team:<id>`, `date:today`, …) do not say which view they were folded in, so
 * without this a squad folded while browsing the archive was folded in the
 * active list too.
 */
export function collapseKeyForView(sectionKey: string, view: ChannelListView): string {
  return view === "archived" ? `${ARCHIVED_COLLAPSE_PREFIX}${sectionKey}` : sectionKey
}

/**
 * The fold choices `view` reads, keyed by plain section key. The active view
 * reads the stored map as it is (the prefixed entries are keys no section
 * has); the archive reads only its own entries, unprefixed.
 */
export function collapseOverridesForView(
  stored: Readonly<Record<string, boolean>>,
  view: ChannelListView
): Readonly<Record<string, boolean>> {
  if (view === "active") return stored
  const own: Record<string, boolean> = {}
  for (const [key, collapsed] of Object.entries(stored)) {
    if (key.startsWith(ARCHIVED_COLLAPSE_PREFIX)) {
      own[key.slice(ARCHIVED_COLLAPSE_PREFIX.length)] = collapsed
    }
  }
  return own
}

/**
 * The query "Search everywhere" hands the command palette (ADR-0129).
 *
 * The button promises every conversation ("Search every conversation, command
 * and file with these words"), so the hand-off carries that reach as tokens the
 * palette shows as chips: `is:archived`, because the palette leaves the archive
 * out by default, and — with more than one workspace — `workspace:all`,
 * because its default is the active workspace (ADR-0144). Opening ⌘K by itself
 * keeps both defaults; only this explicit hand-off widens them. The same from
 * the active list and from the archive: "everywhere" is not a view.
 */
export function everywhereSearchQuery(
  query: string,
  { multipleWorkspaces }: { multipleWorkspaces: boolean }
): string {
  const scope = multipleWorkspaces ? "is:archived workspace:all" : "is:archived"
  const words = query.trim()
  return words ? `${scope} ${words}` : scope
}
