import type { NavItem, SettingsGroup } from "./settings-nav-config"
import type { ModuleSettingsSection, UiModuleManifest } from "@/lib/modules/manifest-types"
import { resolveLucideIcon } from "@/lib/icons/lucide-catalog"

import {
  dormantSettingsSectionIds,
  insertModuleSections,
  moduleSectionKeywords,
  moduleSettingsSections,
} from "./module-sections"

const load = async () => ({ default: () => null })

const section = (over: Partial<ModuleSettingsSection> = {}): ModuleSettingsSection => ({
  id: "crew",
  group: "agents",
  icon: "Users",
  label: "crew.settingsSection.label",
  description: "crew.settingsSection.description",
  load,
  ...over,
})

const ui = (id: string, sections: ModuleSettingsSection[]): UiModuleManifest => ({
  id,
  settingsSections: sections,
})

const nav = (id: string, group: SettingsGroup): NavItem =>
  ({ id, labelKey: id, descriptionKey: id, group, icon: () => null }) as unknown as NavItem

const GROUPS: SettingsGroup[] = ["account", "agents", "system"]
const BASE = [
  nav("account", "account"),
  nav("agents", "agents"),
  nav("subagents", "agents"),
  nav("about", "system"),
]

describe("moduleSettingsSections", () => {
  it("turns a manifest section into a nav item with full message keys and a drawn icon", () => {
    const [entry] = moduleSettingsSections([
      ui("crew", [
        section({
          requires: ["keyring"],
          profiles: ["desktop"],
          layout: "fill",
          keywords: ["crew", "小队"],
          after: "subagents",
        }),
      ]),
    ])
    expect(entry).toMatchObject({
      module: "crew",
      after: "subagents",
      fill: true,
      keywords: ["crew", "小队"],
      item: {
        id: "crew",
        group: "agents",
        messages: {
          label: "crew.settingsSection.label",
          description: "crew.settingsSection.description",
        },
        requires: ["keyring"],
        profiles: ["desktop"],
      },
    })
    expect(entry?.item.icon).toBe(resolveLucideIcon("Users"))
    expect(entry?.load).toBe(load)
  })

  it("leaves a section without layout or keywords capped and unindexed", () => {
    const [entry] = moduleSettingsSections([ui("crew", [section()])])
    expect(entry?.fill).toBe(false)
    expect(entry?.keywords).toEqual([])
    expect(entry?.item.requires).toBeUndefined()
  })

  it("refuses an icon the catalog cannot draw", () => {
    expect(() => moduleSettingsSections([ui("crew", [section({ icon: "NoSuchIcon" })])])).toThrow(
      'components/crew/module.ui.ts: section "crew" names icon "NoSuchIcon"'
    )
  })

  it("reads the generated registry, where squads declares its section", () => {
    const ids = moduleSettingsSections().map((entry) => entry.item.id)
    expect(ids).toContain("squads")
  })
})

describe("insertModuleSections", () => {
  const entries = (over: Partial<ModuleSettingsSection>) =>
    moduleSettingsSections([ui("crew", [section(over)])])

  it("places a section right after the one it follows", () => {
    const ids = insertModuleSections(BASE, entries({ after: "agents" }), GROUPS).map((n) => n.id)
    expect(ids).toEqual(["account", "agents", "crew", "subagents", "about"])
  })

  it("places a section without `after` at the end of its group", () => {
    const ids = insertModuleSections(BASE, entries({}), GROUPS).map((n) => n.id)
    expect(ids).toEqual(["account", "agents", "subagents", "crew", "about"])
  })

  it("leaves the base list untouched", () => {
    insertModuleSections(BASE, entries({}), GROUPS)
    expect(BASE.map((n) => n.id)).toEqual(["account", "agents", "subagents", "about"])
  })

  it("refuses an unknown group, a reused id and a bad `after`", () => {
    expect(() => insertModuleSections(BASE, entries({ group: "nowhere" }), GROUPS)).toThrow(
      'names group "nowhere"'
    )
    expect(() => insertModuleSections(BASE, entries({ id: "about" }), GROUPS)).toThrow(
      "reuses a section id"
    )
    expect(() => insertModuleSections(BASE, entries({ after: "missing" }), GROUPS)).toThrow(
      'follows "missing", which the settings nav does not have'
    )
    expect(() => insertModuleSections(BASE, entries({ after: "about" }), GROUPS)).toThrow(
      'follows "about", which is in group "system"'
    )
  })
})

describe("moduleSectionKeywords", () => {
  it("indexes only sections that declare keywords", () => {
    const list = moduleSettingsSections([
      ui("crew", [section({ keywords: ["crew"] }), section({ id: "quiet" })]),
    ])
    expect(moduleSectionKeywords(list)).toEqual({ crew: ["crew"] })
  })
})

describe("dormantSettingsSectionIds", () => {
  it("names every section a dormant module declares", () => {
    const ids = dormantSettingsSectionIds([
      ui("lab", [section({ id: "lab" }), section({ id: "lab-extra" })]),
    ])
    expect([...ids]).toEqual(["lab", "lab-extra"])
  })
})
