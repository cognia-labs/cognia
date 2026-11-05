/**
 * Icon mapping + catalog assembly + shortcut resolver for the phone's quick
 * module (`components/mobile/glance/mobile-glance-quick-module.tsx`) and its
 * editor (`components/mobile/glance/mobile-shortcuts-editor.tsx`).
 *
 * The pure (icon-free) catalog lives in
 * `@/types/shell/mobile-home`; this module is the only one that pulls in lucide,
 * so the persistence layer stays icon-free. `applyDragReorder` is shared with
 * the sidebar customizer (`@/lib/shell/sidebar-nav`).
 */

import {
  BotIcon,
  CompassIcon,
  FileArchiveIcon,
  InboxIcon,
  LayersIcon,
  PlusIcon,
  SearchIcon,
  SmartphoneIcon,
  ServerCogIcon,
  UserRoundIcon,
  WorkflowIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import type { MobileSpotIconName } from "@/components/mobile/mobile-spot-icon"
import { resolveLucideIcon } from "@/lib/icons/lucide-catalog"
import { navCatalog, type NavCatalogEntry } from "@/lib/shell/nav-catalog"
import {
  LEGACY_MOBILE_QUICK_ACTION_IDS,
  MOBILE_QUICK_ACTION_CATALOG,
  type MobileQuickActionMeta,
} from "@/types/shell/mobile-home"

/**
 * id → grid icon. Must cover every id in `MOBILE_QUICK_ACTION_CATALOG`; a
 * module's shortcut names its own icons in its manifest instead.
 */
export const MOBILE_QUICK_ACTION_ICONS: Record<string, LucideIcon> = {
  newChat: PlusIcon,
  search: SearchIcon,
  workflows: WorkflowIcon,
  discover: CompassIcon,
  inbox: InboxIcon,
  twin: BotIcon,
  // The same icon the Studio's own page header carries.
  templates: FileArchiveIcon,
  fleet: LayersIcon,
  servers: ServerCogIcon,
  devices: SmartphoneIcon,
  me: UserRoundIcon,
}

/** id → illustration used by shortcut tiles and editor rows in Anime mode. */
export const MOBILE_QUICK_ACTION_SPOT_ICONS: Record<string, MobileSpotIconName> = {
  newChat: "chat",
  search: "discover",
  workflows: "workflows",
  discover: "discover",
  inbox: "inbox",
  twin: "digital-twin",
  templates: "templates",
  fleet: "fleet",
  servers: "servers",
  devices: "devices",
  me: "profile",
}

/** The namespace the built-in shortcuts' labels live in. */
const BUILTIN_ACTION_NAMESPACE = "mobile.home.actions"

/** A catalog entry with its resolved icon. */
export interface MobileQuickActionItem extends Omit<MobileQuickActionMeta, "i18nKey"> {
  /**
   * Full i18n key of the label: a built-in's is `mobile.home.actions.<i18nKey>`,
   * a module shortcut's is its navigation label.
   */
  labelKey: string
  Icon: LucideIcon
  spotIcon: MobileSpotIconName
}

/**
 * The quick-action catalog with icons attached, in canonical order: the
 * built-ins, and each active module destination's `mobileShortcut` right
 * after the shortcut its `after` names (or at the end). Throws on an id the
 * catalog already has or an unknown anchor, as the rail's catalog does.
 */
export function getMobileQuickActionCatalog(
  entries: readonly NavCatalogEntry[] = navCatalog()
): MobileQuickActionItem[] {
  const catalog: MobileQuickActionItem[] = MOBILE_QUICK_ACTION_CATALOG.map(({ i18nKey, ...m }) => ({
    ...m,
    labelKey: `${BUILTIN_ACTION_NAMESPACE}.${i18nKey}`,
    Icon: MOBILE_QUICK_ACTION_ICONS[m.id] ?? PlusIcon,
    spotIcon: MOBILE_QUICK_ACTION_SPOT_ICONS[m.id] ?? "chat",
  }))
  for (const entry of entries) {
    const shortcut = entry.mobileShortcut
    if (!entry.module || !shortcut) continue
    const where = `lib/${entry.module}/module.ts: mobile shortcut "${entry.id}"`
    if (catalog.some((item) => item.id === entry.id))
      throw new Error(`${where} reuses an id the shortcut catalog already has`)
    const item: MobileQuickActionItem = {
      id: entry.id,
      kind: "route",
      route: entry.route,
      labelKey: entry.labelKey,
      Icon: (entry.iconName ? resolveLucideIcon(entry.iconName) : null) ?? PlusIcon,
      // The module gate checks the name against `MOBILE_SPOT_ICON_NAMES`.
      spotIcon: (entry.spotIcon ?? "chat") as MobileSpotIconName,
    }
    if (shortcut.after === undefined) {
      catalog.push(item)
      continue
    }
    const index = catalog.findIndex((existing) => existing.id === shortcut.after)
    if (index < 0)
      throw new Error(`${where} follows "${shortcut.after}", which the catalog does not have`)
    catalog.splice(index + 1, 0, item)
  }
  return catalog
}

/** Resolved partition of the catalog into shown vs. available-to-add. */
export interface ResolvedMobileQuickActions {
  /** Shortcuts shown, in the user's stored order. */
  active: MobileQuickActionItem[]
  /** Catalog − active, in catalog order — the editor's "add" pool. */
  available: MobileQuickActionItem[]
}

/**
 * Partition `catalog` by a stored shortcut list (`mobileGlanceLayout.shortcuts`,
 * formerly `mobileHomeLayout.quickActions`):
 *
 *  - **active**: the stored ids that exist in the catalog, in the user's
 *    stored order (deduped; renamed ids mapped; unknown ids dropped).
 *  - **available**: everything else (catalog − active), in catalog order — so a
 *    newly-added catalog item shows up in the editor automatically.
 */
export function resolveMobileShortcuts(
  catalog: MobileQuickActionItem[],
  shortcuts: readonly string[]
): ResolvedMobileQuickActions {
  const byId = new Map(catalog.map((item) => [item.id, item]))

  const seen = new Set<string>()
  const active: MobileQuickActionItem[] = []
  for (const stored of shortcuts) {
    // Renamed ids are mapped on read. Dropping them instead would delete the
    // tile from every saved grid rather than moving it.
    const id = LEGACY_MOBILE_QUICK_ACTION_IDS[stored] ?? stored
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    seen.add(id)
    active.push(item)
  }

  const available = catalog.filter((item) => !seen.has(item.id))
  return { active, available }
}
