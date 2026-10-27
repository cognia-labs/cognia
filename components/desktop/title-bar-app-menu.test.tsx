/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

// Effective chords come from the shared label hook; pinned here so the hint a
// row prints is deterministic.
jest.mock("@/hooks/shortcuts/use-app-shortcut-label", () => ({
  useAppShortcutLabels: (ids: readonly string[]) =>
    ids.map((id) => ({
      label: id === "app.commandPalette.toggle" ? "Ctrl+K" : "",
      aria: undefined,
    })),
}))

import type { AppMenuController } from "@/hooks/desktop/use-app-menu-controller"
import { APP_MENUS, type AppMenuSpec } from "@/lib/desktop/app-menu"
import { TitleBarAppMenu } from "./title-bar-app-menu"

function makeController(overrides: Partial<AppMenuController> = {}): AppMenuController {
  return {
    run: jest.fn(),
    state: () => ({}),
    choice: () => ({ value: "system", select: jest.fn() }),
    recentSessions: [],
    openRecentSession: jest.fn(),
    go: jest.fn(),
    ...overrides,
  }
}

/** Radix opens a submenu from the keyboard reliably under jsdom; a click toggles it. */
async function openSubmenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  ;(await screen.findByText(label)).focus()
  await user.keyboard("{ArrowRight}")
}

const VIEW: AppMenuSpec[] = [APP_MENUS.find((m) => m.id === "view")!]

test("the Menubar draws one trigger per menu", () => {
  render(<TitleBarAppMenu controller={makeController()} folded={false} />)
  for (const menu of APP_MENUS) {
    expect(screen.getByText(`desktop.menu.${menu.labelKey}`)).toBeInTheDocument()
  }
  expect(screen.queryByTestId("title-bar-hamburger")).toBeNull()
})

test("folded, every menu becomes a labelled section of one dropdown", async () => {
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={makeController()} folded />)
  await user.click(screen.getByTestId("title-bar-hamburger"))
  const content = await screen.findByRole("menu")
  for (const menu of APP_MENUS) {
    expect(within(content).getByText(`desktop.menu.${menu.labelKey}`)).toBeInTheDocument()
  }
  // The Go destinations render inline, from the Go table.
  expect(within(content).getByTestId("go-menu-dropdown-go-scheduler")).toBeInTheDocument()
})

test("selecting an item runs its command through the controller", async () => {
  const controller = makeController()
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={controller} folded={false} menus={VIEW} />)
  await user.click(screen.getByText("desktop.menu.view.label"))
  await user.click(await screen.findByTestId("app-menu-menubar-reload"))
  expect(controller.run).toHaveBeenCalledWith("reload")
})

test("app shortcuts print their effective chord, fixed accelerators their label", async () => {
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={makeController()} folded={false} menus={VIEW} />)
  await user.click(screen.getByText("desktop.menu.view.label"))
  expect(await screen.findByTestId("app-menu-menubar-command-palette")).toHaveTextContent("Ctrl+K")
  expect(screen.getByTestId("app-menu-menubar-reload")).toHaveTextContent(
    "desktop.menu.shortcut.cmdOrCtrlR"
  )
  // An unbound app chord prints nothing rather than an empty hint.
  expect(screen.getByTestId("app-menu-menubar-zoom-in").textContent).toBe(
    "desktop.menu.view.zoomIn"
  )
})

test("toggles reflect the controller's state and run on change", async () => {
  const controller = makeController({
    state: (command) =>
      command === "toggle-sidebar"
        ? { checked: true }
        : command === "toggle-guild-rail"
          ? { checked: false, noteKey: "view.guildRailFolded" }
          : {},
  })
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={controller} folded={false} menus={VIEW} />)
  await user.click(screen.getByText("desktop.menu.view.label"))
  const sidebar = await screen.findByTestId("app-menu-menubar-toggle-sidebar")
  expect(sidebar).toHaveAttribute("aria-checked", "true")
  const rail = screen.getByTestId("app-menu-menubar-toggle-guild-rail")
  expect(rail).toHaveAttribute("aria-checked", "false")
  expect(rail).toHaveTextContent("desktop.menu.view.guildRailFolded")
  await user.click(sidebar)
  expect(controller.run).toHaveBeenCalledWith("toggle-sidebar")
})

test("a stateful label replaces the table's label", async () => {
  const windowMenu = [APP_MENUS.find((m) => m.id === "window")!]
  const controller = makeController({
    state: (command) => (command === "toggle-maximize" ? { labelKey: "window.restore" } : {}),
  })
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={controller} folded={false} menus={windowMenu} />)
  await user.click(screen.getByText("desktop.menu.window.label"))
  expect(await screen.findByTestId("app-menu-menubar-toggle-maximize")).toHaveTextContent(
    "desktop.menu.window.restore"
  )
})

test("disabled commands render disabled", async () => {
  const terminalMenu = [APP_MENUS.find((m) => m.id === "terminal")!]
  const controller = makeController({
    state: (command) => (command === "toggle-ai-shell" ? { disabled: true } : {}),
  })
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={controller} folded={false} menus={terminalMenu} />)
  await user.click(screen.getByText("desktop.menu.terminal.label"))
  expect(await screen.findByTestId("app-menu-menubar-toggle-ai-shell")).toHaveAttribute(
    "aria-disabled",
    "true"
  )
})

test("the kill switch is drawn as destructive", async () => {
  const tools = [APP_MENUS.find((m) => m.id === "tools")!]
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={makeController()} folded={false} menus={tools} />)
  await user.click(screen.getByText("desktop.menu.tools.label"))
  expect(await screen.findByTestId("app-menu-menubar-automation-kill-switch")).toHaveAttribute(
    "data-variant",
    "destructive"
  )
})

test("Go destinations dispatch through the controller", async () => {
  const go = [APP_MENUS.find((m) => m.id === "go")!]
  const controller = makeController()
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={controller} folded={false} menus={go} />)
  await user.click(screen.getByText("desktop.menu.go.label"))
  await user.click(await screen.findByTestId("go-menu-menubar-go-scheduler"))
  expect(controller.go).toHaveBeenCalledWith("go-scheduler")
})

test("theme choices check the current value and select through the controller", async () => {
  const select = jest.fn()
  const controller = makeController({
    choice: (setting) => ({ value: setting === "theme" ? "dark" : "en", select }),
  })
  const user = userEvent.setup()
  render(<TitleBarAppMenu controller={controller} folded={false} menus={VIEW} />)
  await user.click(screen.getByText("desktop.menu.view.label"))
  await openSubmenu(user, "desktop.menu.view.theme")
  const dark = await screen.findByRole("menuitemradio", { name: "desktop.menu.view.themeDark" })
  expect(dark).toHaveAttribute("aria-checked", "true")
  await user.click(screen.getByRole("menuitemradio", { name: "desktop.menu.view.themeLight" }))
  expect(select).toHaveBeenCalledWith("light")
})

test("recent sessions list in File, with an empty-state row", async () => {
  const file = [APP_MENUS.find((m) => m.id === "file")!]
  const controller = makeController({
    recentSessions: [{ id: "s-1", title: "Refactor the parser" }],
  })
  const user = userEvent.setup()
  const { unmount } = render(
    <TitleBarAppMenu controller={controller} folded={false} menus={file} />
  )
  await user.click(screen.getByText("desktop.menu.file.label"))
  await openSubmenu(user, "desktop.menu.file.recentSessions")
  await user.click(await screen.findByText("Refactor the parser"))
  expect(controller.openRecentSession).toHaveBeenCalledWith("s-1")
  unmount()

  render(<TitleBarAppMenu controller={makeController()} folded={false} menus={file} />)
  await user.click(screen.getByText("desktop.menu.file.label"))
  await openSubmenu(user, "desktop.menu.file.recentSessions")
  expect(await screen.findByText("desktop.menu.file.recentSessionsEmpty")).toBeInTheDocument()
})
