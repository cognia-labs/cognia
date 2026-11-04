/**
 * Settings sections that feature modules contribute (ADR-0250 §14).
 *
 * A module declares its section in `components/<id>/module.ui.ts` as data:
 * id, group, a Lucide icon name, full i18n keys, reachability and a lazy
 * `load` for the component. `settings-nav-config.ts` folds these into
 * `SETTINGS_NAV` and `SETTINGS_SEARCH_KEYWORDS`, and `settings-shell.tsx`
 * renders them, so adding a section edits no file of the settings shell.
 *
 * Everything here throws on a declaration the shell cannot honour (an unknown
 * group, icon or `after` target, a duplicate id). The module gate checks the
 * manifest's shape, but only the shell knows its groups and section ids, and a
 * section silently dropped or misplaced is worse than a page that fails loudly
 * in development and in `module-sections.test.ts`.
 */

import { activeUiModules, dormantUiModules } from "@/components/modules/registry"
import { resolveLucideIcon } from "@/lib/icons/lucide-catalog"
import type {
  LazyModule,
  ModuleSettingsSectionModule,
  UiModuleManifest,
} from "@/lib/modules/manifest-types"
import type { NavItem, SettingsGroup, SettingsSectionId } from "./settings-nav-config"

export interface ModuleSettingsSectionEntry {
  /** The contributing module's id. */
  module: string
  item: NavItem
  after?: SettingsSectionId
  /** Owns its scroll: rendered outside the capped `ScrollArea`. */
  fill: boolean
  keywords: readonly string[]
  load: LazyModule<ModuleSettingsSectionModule>
}

/** Every active module's sections, as nav items. */
export function moduleSettingsSections(
  modules: readonly UiModuleManifest[] = activeUiModules()
): ModuleSettingsSectionEntry[] {
  return modules.flatMap((manifest) =>
    (manifest.settingsSections ?? []).map((section): ModuleSettingsSectionEntry => {
      const icon = resolveLucideIcon(section.icon)
      if (!icon)
        throw new Error(
          `components/${manifest.id}/module.ui.ts: section "${section.id}" names icon "${section.icon}", which the Lucide catalog cannot draw`
        )
      return {
        module: manifest.id,
        item: {
          id: section.id as SettingsSectionId,
          // Built-in sections key their labels under `settings.tabs`; a module
          // section carries full keys in its own namespace instead.
          labelKey: section.id,
          descriptionKey: section.id,
          messages: { label: section.label, description: section.description },
          group: section.group as SettingsGroup,
          icon,
          ...(section.requires ? { requires: [...section.requires] } : {}),
          ...(section.profiles ? { profiles: [...section.profiles] } : {}),
        },
        ...(section.after ? { after: section.after as SettingsSectionId } : {}),
        fill: section.layout === "fill",
        keywords: section.keywords ?? [],
        load: section.load,
      }
    })
  )
}

/**
 * `base` with every module section placed: right after its `after` section,
 * or at the end of its group. `groups` is the settings nav's group order.
 */
export function insertModuleSections(
  base: readonly NavItem[],
  entries: readonly ModuleSettingsSectionEntry[],
  groups: readonly SettingsGroup[]
): NavItem[] {
  const nav = [...base]
  for (const { module, item, after } of entries) {
    const where = `components/${module}/module.ui.ts: section "${item.id}"`
    if (!groups.includes(item.group))
      throw new Error(`${where} names group "${item.group}", which the settings nav does not have`)
    if (nav.some((existing) => existing.id === item.id))
      throw new Error(`${where} reuses a section id the settings nav already has`)
    if (after) {
      const index = nav.findIndex((existing) => existing.id === after)
      if (index < 0)
        throw new Error(`${where} follows "${after}", which the settings nav does not have`)
      if (nav[index]!.group !== item.group)
        throw new Error(`${where} follows "${after}", which is in group "${nav[index]!.group}"`)
      nav.splice(index + 1, 0, item)
      continue
    }
    const last = nav.map((existing) => existing.group).lastIndexOf(item.group)
    nav.splice(last < 0 ? nav.length : last + 1, 0, item)
  }
  return nav
}

/** Finder keywords per module section, merged into `SETTINGS_SEARCH_KEYWORDS`. */
export function moduleSectionKeywords(
  entries: readonly ModuleSettingsSectionEntry[]
): Partial<Record<SettingsSectionId, string[]>> {
  return Object.fromEntries(
    entries
      .filter((entry) => entry.keywords.length)
      .map((entry) => [entry.item.id, [...entry.keywords]])
  )
}

/**
 * Section ids of dormant (`experimental`) modules. They are off the nav, so a
 * `?section=` deep link to one renders a notice that the section is off rather
 * than another section in its place.
 */
export function dormantSettingsSectionIds(
  modules: readonly UiModuleManifest[] = dormantUiModules()
): ReadonlySet<string> {
  return new Set(modules.flatMap((manifest) => (manifest.settingsSections ?? []).map((s) => s.id)))
}
