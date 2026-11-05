import {
  getMobileQuickActionCatalog,
  resolveMobileShortcuts,
  MOBILE_QUICK_ACTION_ICONS,
} from "./mobile-home-nav"
import { MOBILE_QUICK_ACTION_CATALOG, DEFAULT_MOBILE_HOME_LAYOUT } from "@/types/shell/mobile-home"
import { resolveLucideIcon } from "@/lib/icons/lucide-catalog"
import { buildNavCatalog, navCatalog } from "@/lib/shell/nav-catalog"
import type { ModuleNavEntry } from "@/lib/modules/manifest-types"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

function moduleCatalog(nav: ModuleNavEntry[]) {
  return buildNavCatalog(SIDEBAR_NAV_META, [{ id: "demo", nav }])
}

function destination(id: string, over: Partial<ModuleNavEntry> = {}): ModuleNavEntry {
  return {
    id,
    route: `/${id}`,
    label: `demo.nav.${id}`,
    icon: "Users",
    spotIcon: "fleet",
    group: "feature",
    category: "agents",
    ...over,
  }
}

describe("mobile-home-nav", () => {
  it("uses distinct matching illustrations for infrastructure and template shortcuts", () => {
    const catalog = getMobileQuickActionCatalog()
    for (const id of ["inbox", "templates", "fleet", "servers", "devices"]) {
      expect(catalog.find((item) => item.id === id)?.spotIcon).toBe(id)
    }
  })
  it("attaches an icon to every catalog id", () => {
    const catalog = getMobileQuickActionCatalog()
    const moduleShortcuts = navCatalog().filter((entry) => entry.module && entry.mobileShortcut)
    expect(catalog).toHaveLength(MOBILE_QUICK_ACTION_CATALOG.length + moduleShortcuts.length)
    for (const item of catalog) {
      const destination = moduleShortcuts.find((entry) => entry.id === item.id)
      expect(item.Icon).toBe(
        destination?.iconName
          ? resolveLucideIcon(destination.iconName)
          : MOBILE_QUICK_ACTION_ICONS[item.id]
      )
    }
  })

  it("places a module shortcut after its anchor, under the destination's label", () => {
    const catalog = getMobileQuickActionCatalog(
      moduleCatalog([
        destination("alpha", {
          mobileShortcut: { after: "twin" },
        }),
        destination("omega", { mobileShortcut: {} }),
        // A destination without a shortcut stays off the grid.
        destination("rail-only"),
      ])
    )
    const ids = catalog.map((item) => item.id)
    expect(ids[ids.indexOf("twin") + 1]).toBe("alpha")
    expect(ids.at(-1)).toBe("omega")
    expect(ids).not.toContain("rail-only")
    expect(catalog.find((item) => item.id === "alpha")).toMatchObject({
      kind: "route",
      route: "/alpha",
      labelKey: "demo.nav.alpha",
      spotIcon: "fleet",
    })
  })

  it("refuses a shortcut anchor or id the catalog does not allow", () => {
    expect(() =>
      getMobileQuickActionCatalog(
        moduleCatalog([
          destination("alpha", {
            mobileShortcut: { after: "x" },
          }),
        ])
      )
    ).toThrow('lib/demo/module.ts: mobile shortcut "alpha" follows "x"')
    expect(() =>
      getMobileQuickActionCatalog(
        moduleCatalog([
          destination("search", {
            route: "/search-page",
            mobileShortcut: {},
          }),
        ])
      )
    ).toThrow("reuses an id")
  })

  it("resolves active in stored order and available as the remainder", () => {
    const catalog = getMobileQuickActionCatalog()
    const { active, available } = resolveMobileShortcuts(catalog, ["discover", "newChat"])
    expect(active.map((i) => i.id)).toEqual(["discover", "newChat"])
    // Everything else stays in catalog order.
    expect(available.map((i) => i.id)).toEqual(
      catalog.map((i) => i.id).filter((id) => id !== "discover" && id !== "newChat")
    )
  })

  it("dedupes and drops unknown ids", () => {
    const catalog = getMobileQuickActionCatalog()
    const { active } = resolveMobileShortcuts(catalog, [
      "newChat",
      "newChat",
      "does-not-exist",
      "search",
    ])
    expect(active.map((i) => i.id)).toEqual(["newChat", "search"])
  })

  /**
   * `/templates` had a full phone body and no way in: no quick action, no `/me`
   * row, no tab-bar prefix. A catalog reachable only by typing the URL is a
   * feature that shipped switched off.
   */
  it("offers the template catalog as a quick action", () => {
    const templates = getMobileQuickActionCatalog().find((item) => item.id === "templates")
    expect(templates).toMatchObject({
      kind: "route",
      route: "/templates",
      labelKey: "mobile.home.actions.templates",
    })
    expect(templates?.Icon).toBeDefined()
    expect(templates?.spotIcon).toBe("templates")
  })

  it("the default shortcut list resolves to four active actions", () => {
    const catalog = getMobileQuickActionCatalog()
    const { active } = resolveMobileShortcuts(catalog, DEFAULT_MOBILE_HOME_LAYOUT.quickActions)
    expect(active.map((i) => i.id)).toEqual(DEFAULT_MOBILE_HOME_LAYOUT.quickActions)
  })
})

/**
 * ADR-0140 retired `/agent-teams` and took it out of navigation, but the mobile
 * quick action still pointed at it, so the tile was a shortcut to a route
 * nothing else links to. The id doubles as the persistence key, so it has to be
 * mapped on read rather than dropped: dropping it deletes the tile from every
 * saved grid instead of moving it.
 */
describe("the retired agent-teams tile", () => {
  it("resolves a saved agentTeams tile to the squads one", () => {
    const { active } = resolveMobileShortcuts(getMobileQuickActionCatalog(), ["agentTeams"])
    expect(active.map((item) => item.id)).toEqual(["squads"])
    expect(active[0]!.route).toBe("/squads")
  })

  it("does not offer the tile twice when both ids are stored", () => {
    const { active, available } = resolveMobileShortcuts(getMobileQuickActionCatalog(), [
      "agentTeams",
      "squads",
    ])
    expect(active.filter((item) => item.id === "squads")).toHaveLength(1)
    expect(available.some((item) => item.id === "squads")).toBe(false)
  })
})

it("keeps the Squads fallback ordinary and supplies its separate anime artwork", () => {
  // Squads names both in its module manifest (`lib/squads/module.ts`).
  const squads = getMobileQuickActionCatalog().find((item) => item.id === "squads")
  expect(squads?.Icon).toBe(resolveLucideIcon("Users"))
  expect(squads?.spotIcon).toBe("agent-teams")
  expect(squads?.labelKey).toBe("squads.nav.label")
})
