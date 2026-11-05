/**
 * The navigation catalog: the built-in destinations (`SIDEBAR_NAV_META`) with
 * every active module's `nav` entries placed among them (ADR-0250 §14).
 *
 * Every surface that lists destinations reads this one list: the desktop
 * rail and its More menu and customizer (`lib/shell/sidebar-nav.ts`), the Go
 * menu (`lib/desktop/go-menu.ts`), ⌘K, the bar title, the native menu's
 * action routing and the surface boundary. A module adds a destination in
 * `lib/<id>/module.ts`, and edits none of them.
 *
 * Icon-free on purpose, like `SIDEBAR_NAV_META`: `lib/shell/sidebar-nav.ts`
 * resolves icons, so a reader that only needs ids, routes or labels does not
 * pull the icon set into its graph.
 *
 * Everything here throws on a declaration the catalog cannot honour (an
 * unknown `after` anchor, an id the catalog already has). The module gate
 * checks the manifest's shape, but only the catalog knows the built-in ids,
 * and a destination silently dropped or misplaced is worse than a shell that
 * fails loudly in development and in `nav-catalog.test.ts`.
 */

import { activeHostModules, hostModules } from "@/lib/modules/registry"
import type { HostModuleManifest, ModuleNavEntry } from "@/lib/modules/manifest-types"
import { SIDEBAR_NAV_META, type SidebarNavMeta } from "@/types/shell/sidebar"

/** The namespace the built-in destinations' labels and aliases live in. */
export const BUILTIN_NAV_NAMESPACE = "desktop.guildRail"

/** One destination of the catalog. */
export interface NavCatalogEntry extends Omit<SidebarNavMeta, "i18nKey" | "aliasKey"> {
  /**
   * Full i18n key of the label, for a root-scoped translator. A built-in's is
   * `desktop.guildRail.<i18nKey>`; a module's is the one its manifest names,
   * in the module's own namespace.
   */
  labelKey: string
  /** Full i18n key of the comma-separated ⌘K aliases, if the destination has any. */
  aliasesKey?: string
  /** The contributing module's id; absent for a built-in destination. */
  module?: string
  /** A module entry's Lucide icon name. Built-ins draw from `SIDEBAR_NAV_ICONS`. */
  iconName?: string
  /**
   * A module entry's illustration (a `MobileSpotIconName`). Built-ins take
   * theirs from the icon manifest's `coverage.desktopNavigation`.
   */
  spotIcon?: string
  /** Where the Go menu places a module entry (its `goMenuAfter`, else its `after`). */
  goMenuAfter?: string
  /** The route owns the viewport (`lib/shell/full-viewport-routes.ts`). */
  fullViewport?: boolean
  /** A shortcut in the phone's quick-action grid. */
  mobileShortcut?: ModuleNavEntry["mobileShortcut"]
}

/** A built-in row as a catalog entry. */
export function builtinNavEntry(meta: SidebarNavMeta): NavCatalogEntry {
  const { i18nKey, aliasKey, ...rest } = meta
  return {
    ...rest,
    labelKey: `${BUILTIN_NAV_NAMESPACE}.${i18nKey}`,
    ...(aliasKey ? { aliasesKey: `${BUILTIN_NAV_NAMESPACE}.aliases.${aliasKey}` } : {}),
  }
}

/** A module's `nav` entry as a catalog entry. */
export function moduleNavEntry(module: string, entry: ModuleNavEntry): NavCatalogEntry {
  const goMenuAfter = entry.goMenuAfter ?? entry.after
  return {
    id: entry.id,
    route: entry.route,
    group: entry.group,
    category: entry.category,
    labelKey: entry.label,
    ...(entry.aliases ? { aliasesKey: entry.aliases } : {}),
    ...(entry.desktopOnly ? { desktopOnly: true } : {}),
    ...(entry.hostOperationGated ? { hostOperationGated: true } : {}),
    module,
    iconName: entry.icon,
    spotIcon: entry.spotIcon,
    ...(goMenuAfter ? { goMenuAfter } : {}),
    ...(entry.fullViewport ? { fullViewport: true } : {}),
    ...(entry.mobileShortcut ? { mobileShortcut: entry.mobileShortcut } : {}),
  }
}

/**
 * `builtins` with every module's entries placed: right after the entry its
 * `after` names (a built-in or an earlier module entry), or at the end.
 * Modules are taken in registry order, entries in manifest order.
 */
export function buildNavCatalog(
  builtins: readonly SidebarNavMeta[],
  modules: readonly Pick<HostModuleManifest, "id" | "nav">[]
): NavCatalogEntry[] {
  const catalog = builtins.map(builtinNavEntry)
  for (const manifest of modules) {
    for (const entry of manifest.nav ?? []) {
      const where = `lib/${manifest.id}/module.ts: nav entry "${entry.id}"`
      if (catalog.some((existing) => existing.id === entry.id))
        throw new Error(`${where} reuses an id the navigation catalog already has`)
      if (catalog.some((existing) => existing.route === entry.route))
        throw new Error(`${where} reuses route ${entry.route}, which the catalog already lists`)
      const item = moduleNavEntry(manifest.id, entry)
      if (entry.after === undefined) {
        catalog.push(item)
        continue
      }
      const index = catalog.findIndex((existing) => existing.id === entry.after)
      if (index < 0)
        throw new Error(`${where} follows "${entry.after}", which the catalog does not have`)
      catalog.splice(index + 1, 0, item)
    }
  }
  return catalog
}

let cached: readonly NavCatalogEntry[] | undefined

/**
 * The catalog the shells read: the built-ins and the active modules' entries.
 * An `experimental` module contributes none (`isActiveModule`). Built once;
 * the registry is static.
 */
export function navCatalog(): readonly NavCatalogEntry[] {
  cached ??= buildNavCatalog(SIDEBAR_NAV_META, activeHostModules())
  return cached
}

/**
 * Every id the catalog can ever contain, whatever the module stages: a stored
 * pin outside this set names a retired destination, while one inside it may
 * only be off the catalog for now (an `experimental` module's, a
 * platform-filtered one).
 */
export function knownNavIds(
  modules: readonly Pick<HostModuleManifest, "nav">[] = hostModules()
): ReadonlySet<string> {
  return new Set([
    ...SIDEBAR_NAV_META.map((meta) => meta.id),
    ...modules.flatMap((manifest) => (manifest.nav ?? []).map((entry) => entry.id)),
  ])
}

/** The catalog entry with `id`, if the catalog has one. */
export function navCatalogEntry(id: string): NavCatalogEntry | undefined {
  return navCatalog().find((entry) => entry.id === id)
}
