import en from "@/i18n/messages/en/desktop.json"
import zhCN from "@/i18n/messages/zh-CN/desktop.json"
import { getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"

import {
  APP_MENU_SHORTCUT_IDS,
  APP_MENUS,
  shortcutReferenceRows,
  type AppMenuNode,
} from "./app-menu"

type Messages = Record<string, unknown>

function lookup(messages: Messages, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node && typeof node === "object") return (node as Messages)[key]
    return undefined
  }, messages)
}

const menuMessages = {
  en: lookup(en as Messages, "menu") as Messages,
  "zh-CN": lookup(zhCN as Messages, "menu") as Messages,
}

function labelKeys(node: AppMenuNode): string[] {
  switch (node.kind) {
    case "action":
    case "toggle":
    case "recentSessions":
      return [node.labelKey]
    case "choice":
      return [node.labelKey, ...node.options.map((o) => o.labelKey)]
    default:
      return []
  }
}

test("lists the menus in menubar order, with no Run menu", () => {
  expect(APP_MENUS.map((m) => m.id)).toEqual([
    "file",
    "edit",
    "view",
    "go",
    "tools",
    "terminal",
    "window",
    "help",
  ])
})

test("offers every command exactly once across all menus", () => {
  const commands = APP_MENUS.flatMap((menu) =>
    menu.items.flatMap((node) =>
      node.kind === "action" || node.kind === "toggle" ? [node.command] : []
    )
  )
  expect(commands.length).toBeGreaterThan(0)
  expect(new Set(commands).size).toBe(commands.length)
})

test("never repeats a label within the menus", () => {
  const labels = APP_MENUS.flatMap((menu) =>
    menu.items.flatMap((node) => (node.kind === "choice" ? [node.labelKey] : labelKeys(node)))
  )
  expect(new Set(labels).size).toBe(labels.length)
})

test("starts and ends no menu with a separator, and never doubles one", () => {
  for (const menu of APP_MENUS) {
    const kinds = menu.items.map((n) => n.kind)
    expect(kinds[0]).not.toBe("separator")
    expect(kinds[kinds.length - 1]).not.toBe("separator")
    kinds.forEach((kind, i) => {
      if (kind === "separator") expect(kinds[i + 1]).not.toBe("separator")
    })
  }
})

test.each(Object.entries(menuMessages))("every label resolves in %s", (_locale, messages) => {
  const keys = APP_MENUS.flatMap((menu) => [menu.labelKey, ...menu.items.flatMap(labelKeys)])
  for (const key of keys) expect([key, typeof lookup(messages, key)]).toEqual([key, "string"])
  for (const row of shortcutReferenceRows()) {
    expect([row.labelKey, typeof lookup(messages, row.labelKey)]).toEqual([row.labelKey, "string"])
    if ("label" in row.shortcut) {
      const key = `shortcut.${row.shortcut.label}`
      expect([key, typeof lookup(messages, key)]).toEqual([key, "string"])
    }
  }
})

test("prints app-shortcut hints only for descriptors that exist and fire on the desktop", () => {
  expect(APP_MENU_SHORTCUT_IDS.length).toBeGreaterThan(0)
  for (const id of APP_MENU_SHORTCUT_IDS) {
    const descriptor = getAppShortcutDescriptor(id)
    expect([id, descriptor?.defaultChord ? "bound" : "missing"]).toEqual([id, "bound"])
    // A web-only descriptor can be rebound without moving the native
    // accelerator that serves the desktop, so its chord would lie here.
    expect([id, descriptor?.when ?? ""]).not.toEqual([
      id,
      expect.stringContaining("!platform.tauri"),
    ])
  }
})

test("labels the command palette with the chord the dispatcher answers", () => {
  const view = APP_MENUS.find((m) => m.id === "view")!
  const palette = view.items.find((n) => n.kind === "action" && n.command === "command-palette")
  expect(palette).toMatchObject({ shortcut: { app: "app.commandPalette.toggle" } })
})

test("derives the shortcut reference from the menus, in menu order, plus unlisted chords", () => {
  const rows = shortcutReferenceRows()
  const labels = rows.map((r) => r.labelKey)
  expect(labels.indexOf("file.newChat")).toBeLessThan(labels.indexOf("view.commandPalette"))
  expect(labels).toContain("terminal.togglePanel")
  expect(labels.slice(-2)).toEqual(["view.toggleSidechat", "view.toggleDevtools"])
  // Items without a hint stay out of the reference.
  expect(labels).not.toContain("file.newAgent")
})

test("the reference follows the table it is given", () => {
  expect(
    shortcutReferenceRows([
      {
        id: "help",
        labelKey: "help.label",
        items: [
          { kind: "action", command: "about", labelKey: "help.about", shortcut: { label: "f11" } },
        ],
      },
    ]).map((r) => r.labelKey)
  ).toEqual(["help.about", "view.toggleSidechat", "view.toggleDevtools"])
})
