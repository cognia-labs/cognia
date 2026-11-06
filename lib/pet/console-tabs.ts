// The pet console's places and the ids a link may name to reach one — one
// source shared by the console (navigation + deep link), every surface that
// opens it (popup, bubble action, agent `pet_show`, title bar, ⌘K, the
// glance), and the cross-window bridge's "open-console" message validation.
// Pure and dependency-free so the wire protocol can import it.
//
// The console is Settings → Pet (ADR-0058 D16): there is no `/pet` page, so
// every link is a settings URL (on a phone, the `/me/pet` sub-page that embeds
// the same section) whose `petTab` / `petView` params name the place, the two
// params the Pet section reads.
//
// The console's rail lists five places plus Extensions (id `plugins`), which
// exists only while a module or a plugin fills it. Two of them hold segments:
// Collection (dex, achievements) and Activity (journal, insights). Appearance
// & settings is the rail's last row but not a section (it is the `appearance`
// view), so it has a destination id but no section.
//
// Ids from the console's earlier ten-tab layout stay accepted so links that
// were already written (bubbles in flight, a popup on an older build, an agent
// prompt) still land: `nurture` is Home, `customize` and `binding` open
// Appearance & settings.

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

/** Where the console opens: a section (and segment) of the main view, or
 *  Appearance & settings (optionally scrolled to the character binding). */
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

/** The settings section the console is. */
export const PET_SETTINGS_SECTION = "pet" as const
/** The Pet section's destination param: any console destination. */
export const PET_TAB_PARAM = "petTab" as const
/** The Pet section's view param: `appearance` (Appearance & settings) or absent. */
export const PET_VIEW_PARAM = "petView" as const

/**
 * The target a Pet section URL names. `petView=appearance` is Appearance & settings'
 * own address; `petTab` carries any destination (including `appearance`).
 * Anything unknown is `undefined`, and the console opens at its default.
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

/** The phone's home for the Pet section: a Me sub-page embedding it. */
export const PET_PHONE_ROUTE = "/me/pet" as const

export interface PetConsoleHrefOptions {
  /**
   * The phone's form: `/me/pet`, where settings sections live on a phone. A
   * phone's `/settings` is an ordinary scrolling route, which would collapse
   * the console's own scrolling pane.
   */
  phone?: boolean
}

/**
 * The href for a destination, in the canonical form: Settings → Pet, or its
 * phone sub-page. Spelled out rather than built with `settingsHref`, which
 * would pull the settings shell's types into the wire protocol;
 * `console-tabs.test.ts` checks the two agree.
 */
export function petConsoleHref(tab?: PetConsoleTab, options: PetConsoleHrefOptions = {}): string {
  const params = options.phone
    ? new URLSearchParams()
    : new URLSearchParams({ section: PET_SETTINGS_SECTION })
  if (tab) {
    const target = resolvePetConsoleTarget(tab)
    if (target.view === "appearance") {
      params.set(PET_VIEW_PARAM, "appearance")
      if (target.focus) params.set(PET_TAB_PARAM, "binding")
    } else if (target.section !== "home" || target.segment) {
      params.set(PET_TAB_PARAM, target.segment ?? target.section)
    }
  }
  const query = params.toString()
  if (options.phone) return query ? `${PET_PHONE_ROUTE}?${query}` : PET_PHONE_ROUTE
  return `/settings?${query}`
}
