import { readFileSync } from "node:fs"
import { join } from "node:path"

import { activeHostModules, hostModules } from "@/lib/modules/registry"
import type { HostModuleManifest, ModuleNavEntry } from "@/lib/modules/manifest-types"
import { SIDEBAR_NAV_META, type SidebarNavMeta } from "@/types/shell/sidebar"

import {
  BUILTIN_NAV_NAMESPACE,
  buildNavCatalog,
  builtinNavEntry,
  knownNavIds,
  moduleNavEntry,
  navCatalog,
  navCatalogEntry,
} from "./nav-catalog"

const BUILTINS: SidebarNavMeta[] = [
  { id: "inbox", route: "/inbox", i18nKey: "inbox", group: "feature", category: "you" },
  {
    id: "devices",
    route: "/devices",
    i18nKey: "devices",
    group: "auxiliary",
    category: "system",
    aliasKey: "devices",
  },
  { id: "logs", route: "/logs", i18nKey: "logs", group: "auxiliary", category: "insights" },
]

function entry(over: Partial<ModuleNavEntry> & Pick<ModuleNavEntry, "id">): ModuleNavEntry {
  return {
    route: `/${over.id}`,
    label: `${over.id}.nav.label`,
    icon: "Users",
    spotIcon: "agent-teams",
    group: "feature",
    category: "agents",
    ...over,
  }
}

function module(id: string, nav: ModuleNavEntry[]): Pick<HostModuleManifest, "id" | "nav"> {
  return { id, nav }
}

/** The message at a full key in a locale's aggregate. */
function message(locale: "en" | "zh-CN", key: string): unknown {
  const file = join(__dirname, "..", "..", "i18n", "messages", `${locale}.json`)
  const messages = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      messages
    )
}

describe("builtinNavEntry", () => {
  it("turns the rail-relative keys into full ones", () => {
    expect(builtinNavEntry(BUILTINS[1]!)).toEqual({
      id: "devices",
      route: "/devices",
      group: "auxiliary",
      category: "system",
      labelKey: "desktop.guildRail.devices",
      aliasesKey: "desktop.guildRail.aliases.devices",
    })
    expect(builtinNavEntry(BUILTINS[0]!)).not.toHaveProperty("aliasesKey")
  })
})

describe("moduleNavEntry", () => {
  it("keeps the module's own full keys and records who contributed it", () => {
    expect(
      moduleNavEntry(
        "squads",
        entry({
          id: "squads",
          aliases: "squads.nav.aliases",
          after: "agents",
          goMenuAfter: "plugins",
          fullViewport: true,
          hostOperationGated: true,
          mobileShortcut: { after: "twin" },
        })
      )
    ).toEqual({
      id: "squads",
      route: "/squads",
      group: "feature",
      category: "agents",
      labelKey: "squads.nav.label",
      aliasesKey: "squads.nav.aliases",
      hostOperationGated: true,
      module: "squads",
      iconName: "Users",
      spotIcon: "agent-teams",
      goMenuAfter: "plugins",
      fullViewport: true,
      mobileShortcut: { after: "twin" },
    })
  })

  it("places the Go-menu entry by `after` when no `goMenuAfter` is given", () => {
    expect(moduleNavEntry("demo", entry({ id: "demo", after: "inbox" })).goMenuAfter).toBe("inbox")
    expect(moduleNavEntry("demo", entry({ id: "demo" }))).not.toHaveProperty("goMenuAfter")
  })
})

describe("buildNavCatalog", () => {
  it("is the built-ins alone when no module contributes", () => {
    expect(buildNavCatalog(BUILTINS, []).map((item) => item.id)).toEqual([
      "inbox",
      "devices",
      "logs",
    ])
  })

  it("places each entry right after its anchor, or at the end", () => {
    const catalog = buildNavCatalog(BUILTINS, [
      module("a", [entry({ id: "alpha", after: "inbox" }), entry({ id: "omega" })]),
      // An anchor can be another module's entry, already placed.
      module("b", [entry({ id: "beta", after: "alpha" })]),
    ])
    expect(catalog.map((item) => item.id)).toEqual([
      "inbox",
      "alpha",
      "beta",
      "devices",
      "logs",
      "omega",
    ])
  })

  it("refuses an anchor the catalog does not have", () => {
    expect(() =>
      buildNavCatalog(BUILTINS, [module("a", [entry({ id: "alpha", after: "nope" })])])
    ).toThrow('lib/a/module.ts: nav entry "alpha" follows "nope"')
  })

  it("refuses an id or a route the catalog already has", () => {
    expect(() => buildNavCatalog(BUILTINS, [module("a", [entry({ id: "inbox" })])])).toThrow(
      "reuses an id"
    )
    expect(() =>
      buildNavCatalog(BUILTINS, [module("a", [entry({ id: "mail", route: "/inbox" })])])
    ).toThrow("reuses route /inbox")
  })
})

describe("the generated catalog", () => {
  it("is the built-ins plus every active module's entries, each once", () => {
    const ids = navCatalog().map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(SIDEBAR_NAV_META.map((meta) => meta.id)))
    const moduleIds = activeHostModules().flatMap((m) => (m.nav ?? []).map((e) => e.id))
    expect(ids).toEqual(expect.arrayContaining(moduleIds))
    expect(ids).toHaveLength(SIDEBAR_NAV_META.length + moduleIds.length)
  })

  it("draws a label for every destination in both locales", () => {
    for (const item of navCatalog()) {
      expect([item.id, typeof message("en", item.labelKey)]).toEqual([item.id, "string"])
      expect([item.id, typeof message("zh-CN", item.labelKey)]).toEqual([item.id, "string"])
      if (item.aliasesKey) {
        expect([item.id, typeof message("en", item.aliasesKey)]).toEqual([item.id, "string"])
        expect([item.id, typeof message("zh-CN", item.aliasesKey)]).toEqual([item.id, "string"])
      }
    }
  })

  it("names the module behind every contributed destination, and only those", () => {
    const builtinIds = new Set(SIDEBAR_NAV_META.map((meta) => meta.id))
    for (const item of navCatalog()) expect(item.module === undefined).toBe(builtinIds.has(item.id))
  })

  it("is looked up by id", () => {
    expect(navCatalogEntry("inbox")?.labelKey).toBe(`${BUILTIN_NAV_NAMESPACE}.inbox`)
    expect(navCatalogEntry("no-such-destination")).toBeUndefined()
  })
})

describe("knownNavIds", () => {
  it("keeps an experimental module's ids, which the catalog leaves out", () => {
    const known = knownNavIds([{ nav: [entry({ id: "dormant" })] }, { nav: undefined }])
    expect(known.has("dormant")).toBe(true)
    for (const meta of SIDEBAR_NAV_META) expect(known.has(meta.id)).toBe(true)
  })

  it("defaults to every module, whatever its stage", () => {
    const known = knownNavIds()
    for (const manifest of hostModules())
      for (const nav of manifest.nav ?? []) expect(known.has(nav.id)).toBe(true)
  })
})
