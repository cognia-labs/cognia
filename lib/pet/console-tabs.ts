// The /pet console's places and the ids a link may name to reach one — one
// source shared by the console (navigation + `?tab=` deep link), every surface
// that opens it (popup, bubble action, agent `pet_show`, title bar), and the
// cross-window bridge's "open-console" message validation. Pure and
// dependency-free so the wire protocol can import it.
//
// The console has five places plus a plugins tab that exists only while a
// plugin fills it. Two of them hold segments: Collection (dex, achievements)
// and Activity (journal, insights). Appearance & settings is not a tab: it is
// a sub-page the header opens, so it has a destination id but no section.
//
// Ids from the console's earlier ten-tab layout stay accepted so links that
// were already written (bubbles in flight, a popup on an older build, an agent
// prompt) still land: `nurture` is Home, `customize` and `binding` open the
// appearance sub-page.

/** The console's top-level navigation, in display order. */
export const PET_CONSOLE_SECTIONS = [
  "home",
  "chat",
  "shop",
  "collection",
  "activity",
  "plugins",
] as const

export type PetConsoleSection = (typeof PET_CONSOLE_SECTIONS)[number]

export const PET_COLLECTION_SEGMENTS = ["dex", "achievements"] as const
export type PetCollectionSegment = (typeof PET_COLLECTION_SEGMENTS)[number]

export const PET_ACTIVITY_SEGMENTS = ["journal", "insights"] as const
export type PetActivitySegment = (typeof PET_ACTIVITY_SEGMENTS)[number]

export type PetConsoleSegment = PetCollectionSegment | PetActivitySegment

/** Every place a link can name, in the form new links should use. */
export const PET_CONSOLE_DESTINATIONS = [
  "home",
  "chat",
  "shop",
  "collection",
  "dex",
  "achievements",
  "activity",
  "journal",
  "insights",
  "appearance",
  "plugins",
] as const

export type PetConsoleDestination = (typeof PET_CONSOLE_DESTINATIONS)[number]

/** Ids of the earlier layout, and the destination each one now means. */
export const PET_CONSOLE_LEGACY_TABS = {
  nurture: "home",
  customize: "appearance",
  binding: "appearance",
} as const satisfies Record<string, PetConsoleDestination>

type PetConsoleLegacyTab = keyof typeof PET_CONSOLE_LEGACY_TABS

/** Every id `?tab=` and the bridge accept: the destinations plus legacy ids. */
export const PET_CONSOLE_TABS = [
  ...PET_CONSOLE_DESTINATIONS,
  ...(Object.keys(PET_CONSOLE_LEGACY_TABS) as PetConsoleLegacyTab[]),
] as const

export type PetConsoleTab = PetConsoleDestination | PetConsoleLegacyTab

const TAB_SET: ReadonlySet<string> = new Set(PET_CONSOLE_TABS)
const SECTION_SET: ReadonlySet<string> = new Set(PET_CONSOLE_SECTIONS)

export function isPetConsoleTab(value: unknown): value is PetConsoleTab {
  return typeof value === "string" && TAB_SET.has(value)
}

export function isPetConsoleSection(value: unknown): value is PetConsoleSection {
  return typeof value === "string" && SECTION_SET.has(value)
}

/** Where the console opens: a section (and segment) of the main view, or the
 *  appearance sub-page (optionally scrolled to the character binding). */
export type PetConsoleTarget =
  | { view: "main"; section: PetConsoleSection; segment?: PetConsoleSegment }
  | { view: "appearance"; focus?: "binding" }

export const PET_CONSOLE_DEFAULT_TARGET: PetConsoleTarget = { view: "main", section: "home" }

/** The section a segment lives in. */
export function petConsoleSegmentSection(segment: PetConsoleSegment): "collection" | "activity" {
  return (PET_COLLECTION_SEGMENTS as readonly string[]).includes(segment)
    ? "collection"
    : "activity"
}

export function resolvePetConsoleTarget(tab: PetConsoleTab): PetConsoleTarget {
  switch (tab) {
    case "nurture":
      return { view: "main", section: "home" }
    case "customize":
    case "appearance":
      return { view: "appearance" }
    case "binding":
      return { view: "appearance", focus: "binding" }
    case "dex":
    case "achievements":
    case "journal":
    case "insights":
      return { view: "main", section: petConsoleSegmentSection(tab), segment: tab }
    default:
      return { view: "main", section: tab }
  }
}

/**
 * The target a `/pet` URL names. `?view=appearance` is the sub-page's own
 * address; `?tab=` carries any destination (including `appearance`). Anything
 * unknown is `undefined`, and the console opens at its default.
 */
export function petConsoleTargetFromParams(
  tab: string | null | undefined,
  view: string | null | undefined
): PetConsoleTarget | undefined {
  if (view === "appearance") {
    return tab === "binding" ? { view: "appearance", focus: "binding" } : { view: "appearance" }
  }
  return isPetConsoleTab(tab) ? resolvePetConsoleTarget(tab) : undefined
}

/** The `/pet` href for a destination, in the canonical form. */
export function petConsoleHref(tab?: PetConsoleTab): string {
  if (!tab) return "/pet"
  const target = resolvePetConsoleTarget(tab)
  if (target.view === "appearance") {
    return target.focus ? "/pet?view=appearance&tab=binding" : "/pet?view=appearance"
  }
  if (target.section === "home" && !target.segment) return "/pet"
  return `/pet?tab=${target.segment ?? target.section}`
}
