/**
 * The phone's glance layout (ADR-0225 §9, §10): presets, normalization, and
 * copying to and from the desktop's layout.
 *
 * One layout feeds two surfaces. The Glance drawer renders every visible
 * entry; the home screen renders the visible entries pinned with `home`, in
 * the same order. The quick module's content on a phone is the layout's own
 * shortcut list (`shortcuts`), not the desktop tray's action catalogue.
 */

import { hostModules } from "@/lib/modules/registry"
import { MOBILE_QUICK_ACTION_CATALOG } from "@/types/shell/mobile-home"
import {
  DEFAULT_GLANCE_MODULE_OPTIONS,
  GLANCE_MAX_PLUGIN_ENTRIES,
  GLANCE_MODULE_IDS,
  GLANCE_MODULE_SIZES,
  GLANCE_PRESET_IDS,
  isPluginEntryId,
  type GlanceEntryId,
  type GlanceLayoutEntry,
  type GlanceMobileEntry,
  type GlanceMobileSettings,
  type GlanceModuleId,
  type GlanceModuleSize,
  type GlancePresetId,
} from "@/types/glance/layout"

import { normalizeGlanceModuleOptions, storedEntrySize } from "./presets"
import { effectiveSize, glanceModule, GLANCE_MODULES } from "./registry"

/**
 * The visible entries of each preset on a phone, in order, with their home
 * pin. Everything else is hidden. `balanced` is the home screen as it was
 * before ADR-0225: the running-work line, the shortcut grid, the usage and
 * activity dashboard, recent conversations.
 */
export const GLANCE_MOBILE_PRESETS: Readonly<
  Record<
    GlancePresetId,
    ReadonlyArray<readonly [id: GlanceModuleId, size: GlanceModuleSize, home: boolean]>
  >
> = {
  balanced: [
    ["fleet", "compact", true],
    ["quick", "standard", true],
    ["usage", "standard", true],
    ["activity", "standard", true],
    ["recents", "standard", true],
    ["quota", "standard", false],
    ["agenda", "compact", false],
  ],
  "usage-first": [
    ["usage", "expanded", true],
    ["quota", "expanded", true],
    ["activity", "expanded", true],
    ["fleet", "compact", true],
    ["quick", "compact", false],
  ],
  "agent-ops": [
    ["fleet", "expanded", true],
    ["agenda", "standard", true],
    ["recents", "standard", true],
    ["quick", "standard", true],
    ["quota", "compact", false],
  ],
  minimal: [
    ["fleet", "compact", true],
    ["quick", "standard", true],
    ["usage", "compact", false],
  ],
}

/** A full mobile entry list for a preset: its visible entries, then the rest hidden. */
export function mobileLayoutFromPreset(preset: GlancePresetId): GlanceMobileEntry[] {
  const visible = GLANCE_MOBILE_PRESETS[preset].map(([id, size, home]) => ({
    id,
    size,
    hidden: false,
    home,
  }))
  const rest = GLANCE_MODULE_IDS.filter((id) => !visible.some((entry) => entry.id === id)).map(
    (id) => ({ id, size: GLANCE_MODULES[id].sizes[0], hidden: true, home: false })
  )
  return [...visible, ...rest]
}

/**
 * The shortcut grid a fresh phone starts with: places with no other door on
 * the home screen. The old grid's four (new chat, search, workflows, discover)
 * were each one tap away already, in the composer under the grid, the app
 * bar's search and the tab bar, so the grid only ever repeated them.
 */
export const DEFAULT_GLANCE_MOBILE_SHORTCUTS: readonly string[] = [
  "inbox",
  "templates",
  "squads",
  "devices",
]

export const DEFAULT_GLANCE_MOBILE_SETTINGS: GlanceMobileSettings = {
  version: 1,
  preset: "balanced",
  entries: mobileLayoutFromPreset("balanced"),
  scope: "all",
  options: DEFAULT_GLANCE_MODULE_OPTIONS,
  shortcuts: [...DEFAULT_GLANCE_MOBILE_SHORTCUTS],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Repair a mobile entry list against the current catalogue. Plugin entries
 * are kept as the desktop layout keeps them (`normalizeEntries`).
 */
export function normalizeMobileEntries(raw: unknown): GlanceMobileEntry[] {
  if (!Array.isArray(raw)) return mobileLayoutFromPreset("balanced")
  const seen = new Set<GlanceEntryId>()
  const out: GlanceMobileEntry[] = []
  let plugins = 0
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string") continue
    if (isPluginEntryId(item.id)) {
      if (seen.has(item.id) || plugins >= GLANCE_MAX_PLUGIN_ENTRIES) continue
      seen.add(item.id)
      plugins += 1
      out.push({
        id: item.id,
        size: storedEntrySize(item.id, item.size),
        hidden: item.hidden === true,
        home: item.home === true,
      })
      continue
    }
    const def = glanceModule(item.id)
    if (!def || seen.has(def.id)) continue
    seen.add(def.id)
    const size =
      typeof item.size === "string" &&
      (GLANCE_MODULE_SIZES as readonly string[]).includes(item.size)
        ? effectiveSize(def.id, item.size as GlanceModuleSize)
        : def.sizes[0]
    out.push({ id: def.id, size, hidden: item.hidden === true, home: item.home === true })
  }
  // A module a newer build added is opt-in: hidden, and off the home screen.
  for (const id of GLANCE_MODULE_IDS) {
    if (!seen.has(id))
      out.push({ id, size: GLANCE_MODULES[id].sizes[0], hidden: true, home: false })
  }
  return out
}

/**
 * Every shortcut id a grid may store: the built-ins and each module
 * destination's `mobileShortcut`, whatever the module's stage, so a stored
 * shortcut of a module that is off for now is kept rather than dropped.
 */
const SHORTCUT_IDS: ReadonlySet<string> = new Set([
  ...MOBILE_QUICK_ACTION_CATALOG.map((a) => a.id),
  ...hostModules().flatMap((manifest) =>
    (manifest.nav ?? []).filter((entry) => entry.mobileShortcut).map((entry) => entry.id)
  ),
])

/**
 * Repair a shortcut list: unknown ids dropped, duplicates
 * keep their first place. An explicitly empty list is honoured (the user
 * removed every shortcut); only a missing or malformed one gets the default.
 */
export function normalizeShortcuts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_GLANCE_MOBILE_SHORTCUTS]
  const out: string[] = []
  for (const id of raw) {
    if (typeof id !== "string") continue
    if (!SHORTCUT_IDS.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/** Read whatever is stored into a valid mobile layout. Never throws. */
export function normalizeGlanceMobileSettings(raw: unknown): GlanceMobileSettings {
  if (!isRecord(raw))
    return {
      ...DEFAULT_GLANCE_MOBILE_SETTINGS,
      entries: mobileLayoutFromPreset("balanced"),
      shortcuts: [...DEFAULT_GLANCE_MOBILE_SHORTCUTS],
    }
  const preset =
    raw.preset === "custom" ||
    (typeof raw.preset === "string" &&
      (GLANCE_PRESET_IDS as readonly string[]).includes(raw.preset))
      ? (raw.preset as GlanceMobileSettings["preset"])
      : DEFAULT_GLANCE_MOBILE_SETTINGS.preset
  return {
    version: 1,
    preset,
    entries:
      raw.entries === undefined
        ? mobileLayoutFromPreset("balanced")
        : normalizeMobileEntries(raw.entries),
    scope: raw.scope === "workspace" ? "workspace" : "all",
    options: normalizeGlanceModuleOptions(raw.options),
    shortcuts: normalizeShortcuts(raw.shortcuts),
  }
}

/** The entries the home screen renders: visible and pinned, in layout order. */
export function homeEntries(entries: readonly GlanceMobileEntry[]): GlanceMobileEntry[] {
  return entries.filter((entry) => !entry.hidden && entry.home)
}

/**
 * Copy the desktop's order, sizes and visibility onto the phone. Home pins
 * stay the phone's own: the desktop has no home screen to say anything about
 * them, so a module keeps its pin, and one the copy newly shows starts
 * unpinned.
 */
export function mobileEntriesFromDesktop(
  desktop: readonly GlanceLayoutEntry[],
  current: readonly GlanceMobileEntry[]
): GlanceMobileEntry[] {
  const pin = new Map(current.map((entry) => [entry.id, entry.home]))
  return normalizeMobileEntries(
    desktop.map((entry) => ({ ...entry, home: !entry.hidden && pin.get(entry.id) === true }))
  )
}

/** Copy the phone's order, sizes and visibility onto the desktop. Pins are dropped. */
export function desktopEntriesFromMobile(
  mobile: readonly GlanceMobileEntry[]
): GlanceLayoutEntry[] {
  return mobile.map(({ id, size, hidden }) => ({ id, size, hidden }))
}
