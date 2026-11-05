import { readFileSync } from "fs"
import { join } from "path"

import { buildNavCatalog, navCatalog } from "@/lib/shell/nav-catalog"
import { navEntryIcon } from "@/lib/shell/sidebar-nav"
import { SIDEBAR_NAV_META } from "@/types/shell/sidebar"

import {
  GO_MENU_IDS,
  GO_MENU_LAYOUT,
  GO_MENU_SECTIONS,
  getGoMenuItem,
  isGoMenuId,
  resolveGoMenuSections,
} from "./go-menu"

const EXTRA_IDS = ["go-dms", "go-canvas", "go-settings"]

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

/** The catalog's module destinations: the layout does not list them. */
const MODULE_IDS = navCatalog()
  .filter((entry) => entry.module)
  .map((entry) => entry.id)

describe("GO_MENU_LAYOUT", () => {
  it("places every built-in destination and every extra exactly once, and nothing else", () => {
    const placed = GO_MENU_LAYOUT.flat()
    expect(new Set(placed).size).toBe(placed.length)
    expect([...placed].sort()).toEqual(
      [...SIDEBAR_NAV_META.map((meta) => meta.id), "dms", "canvas", "settings"].sort()
    )
  })

  it("resolves without dropping or adding a section", () => {
    expect(
      GO_MENU_SECTIONS.map((section) =>
        section.map((item) => item.id).filter((id) => !MODULE_IDS.includes(id.slice(3)))
      )
    ).toEqual(GO_MENU_LAYOUT.map((section) => section.map((key) => `go-${key}`)))
  })
})

describe("GO_MENU_SECTIONS", () => {
  it("gives catalog destinations the rail's label key and icon", () => {
    for (const entry of navCatalog()) {
      const item = getGoMenuItem(`go-${entry.id}`)
      expect(item).toEqual({
        id: `go-${entry.id}`,
        labelKey: entry.labelKey,
        Icon: navEntryIcon(entry),
      })
    }
  })

  it("labels the extras with the rail's DM guild, Canvas mode and Settings button strings", () => {
    expect(getGoMenuItem("go-dms")?.labelKey).toBe("desktop.guildRail.directMessages")
    expect(getGoMenuItem("go-canvas")?.labelKey).toBe("desktop.guildRail.canvas")
    expect(getGoMenuItem("go-settings")?.labelKey).toBe("desktop.guildRail.settings")
    for (const id of EXTRA_IDS) expect(getGoMenuItem(id)?.Icon).toBeDefined()
  })

  it("has a label for every item in both locales", () => {
    for (const section of GO_MENU_SECTIONS) {
      for (const item of section) {
        expect(typeof message("en", item.labelKey)).toBe("string")
        expect(typeof message("zh-CN", item.labelKey)).toBe("string")
      }
    }
  })
})

describe("GO_MENU_IDS / isGoMenuId", () => {
  it("is the table flattened, one id per catalog entry plus the extras", () => {
    expect(GO_MENU_IDS).toEqual(GO_MENU_SECTIONS.flat().map((item) => item.id))
    expect([...GO_MENU_IDS].sort()).toEqual(
      [...navCatalog().map((entry) => `go-${entry.id}`), ...EXTRA_IDS].sort()
    )
  })

  it("accepts exactly the table's ids", () => {
    for (const id of GO_MENU_IDS) expect(isGoMenuId(id)).toBe(true)
    expect(isGoMenuId("go-agent-teams")).toBe(false)
    expect(isGoMenuId("go-")).toBe(false)
    expect(isGoMenuId("new-chat")).toBe(false)
    expect(getGoMenuItem("go-agent-teams")).toBeUndefined()
  })
})

const BUILTINS = buildNavCatalog(SIDEBAR_NAV_META, [])

describe("resolveGoMenuSections", () => {
  it("places a module destination right after its Go-menu anchor", () => {
    const entries = buildNavCatalog(SIDEBAR_NAV_META, [
      {
        id: "demo",
        nav: [
          {
            id: "demo",
            route: "/demo",
            label: "demo.nav.label",
            icon: "Users",
            spotIcon: "agent-teams",
            group: "feature",
            category: "agents",
            after: "agents",
            goMenuAfter: "plugins",
          },
          {
            id: "demo-orphan",
            route: "/demo-orphan",
            label: "demo.nav.orphan",
            icon: "Users",
            spotIcon: "agent-teams",
            group: "auxiliary",
            category: "system",
            goMenuAfter: "no-such-anchor",
          },
        ],
      },
    ])
    const sections = resolveGoMenuSections([["plugins", "scheduler"], ["settings"]], entries).map(
      (section) => section.map((item) => item.id)
    )
    expect(sections[0]).toEqual(["go-plugins", "go-demo", "go-scheduler"])
    // An anchor the layout lacks leaves it unplaced, which keeps it reachable.
    expect(sections.at(-2)).toContain("go-demo-orphan")
    expect(sections.at(-1)).toEqual(["go-settings"])
  })

  it("drops unknown and repeated ids and empty sections", () => {
    const sections = resolveGoMenuSections(
      [
        ["no-such-destination"],
        ["dms", "dms", ...SIDEBAR_NAV_META.map((meta) => meta.id)],
        ["settings"],
      ],
      BUILTINS
    )
    expect(sections.map((section) => section.map((item) => item.id))).toEqual([
      ["go-dms", ...SIDEBAR_NAV_META.map((meta) => `go-${meta.id}`)],
      ["go-settings"],
    ])
  })

  it("keeps a catalog destination the layout forgot reachable, just before the last section", () => {
    const [first, ...rest] = SIDEBAR_NAV_META.map((meta) => meta.id)
    const sections = resolveGoMenuSections([rest, ["settings"]], BUILTINS)
    expect(sections.map((section) => section.map((item) => item.id))).toEqual([
      rest.map((id) => `go-${id}`),
      [`go-${first}`],
      ["go-settings"],
    ])
  })

  it("puts forgotten destinations in their own section when the layout is empty", () => {
    const sections = resolveGoMenuSections([], BUILTINS)
    expect(sections).toHaveLength(1)
    expect(sections[0].map((item) => item.id)).toEqual(
      SIDEBAR_NAV_META.map((meta) => `go-${meta.id}`)
    )
  })
})
