import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))
jest.mock("@cognia/logging", () => ({
  loggers: { ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}))

const setTheme = jest.fn()
jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", setTheme }) }))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

// Built inside the factory: `jest.mock` is hoisted above every `const`.
jest.mock("@/lib/desktop/menu-actions", () => ({
  automationKillSwitchAction: jest.fn().mockResolvedValue(undefined),
  clearCacheAction: jest.fn().mockResolvedValue(undefined),
  goAction: jest.fn(),
  manageConnectorsAction: jest.fn(),
  manageMcpServerAction: jest.fn(),
  newAgentAction: jest.fn(),
  newAgentTeamAction: jest.fn(),
  newChatAction: jest.fn(),
  newWorkflowAction: jest.fn(),
  pluginDevtoolsAction: jest.fn(),
  restartSidecarAction: jest.fn().mockResolvedValue(undefined),
  setLanguageAction: jest.fn().mockResolvedValue(undefined),
  setThemeAction: jest.fn().mockResolvedValue(undefined),
  toggleGuildRailAction: jest.fn(),
  toggleReduceMotionAction: jest.fn().mockResolvedValue(undefined),
  toggleStatusBarAction: jest.fn(),
}))
const actions = jest.requireMock("@/lib/desktop/menu-actions") as Record<string, jest.Mock>

const openExternal = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (url: string) => openExternal(url) }))

const requestCommandPalette = jest.fn()
jest.mock("@/lib/shell/command-palette-request", () => ({
  requestCommandPalette: () => requestCommandPalette(),
}))

const applyZoom = jest.fn(async (n: number) => n)
jest.mock("@/lib/tauri/webview-zoom", () => ({
  ...jest.requireActual("@/lib/tauri/webview-zoom"),
  applyZoom: (n: number) => applyZoom(n),
}))

const listSessions = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ listSessions: () => listSessions() }))
jest.mock("@/lib/workspace/open-folder", () => ({ openFolderAsWorkspace: jest.fn() }))
jest.mock("@/lib/terminal/spawn-default", () => ({ spawnDefaultTerminal: jest.fn() }))

function selectorStore<S>(state: () => S) {
  return Object.assign((selector: (s: S) => unknown) => selector(state()), { getState: state })
}

const ui = {
  toggleSidebar: jest.fn(),
  setSelectedGuild: jest.fn(),
  openFind: jest.fn(),
  sidebarCollapsed: false,
  guildRailCollapsed: true,
  statusBarCollapsed: false,
}
jest.mock("@/stores/ui/ui-store", () => ({ useUIStore: selectorStore(() => ui) }))

const shellColumns = { sidebarHostsNav: false }
jest.mock("@/stores/ui/shell-columns-store", () => ({
  useShellColumnsStore: selectorStore(() => shellColumns),
}))

const saveSettings = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: selectorStore(() => ({
    settings: { webviewZoom: 1, language: "zh-CN", reduceMotion: true },
    save: saveSettings,
  })),
}))

const terminal = {
  panelOpen: false,
  setPanelOpen: jest.fn(),
  togglePanel: jest.fn(),
  activeSessionIdByProject: {} as Record<string, string>,
  focusedPaneByAnchor: {} as Record<string, string>,
  splitPanes: {} as Record<string, string[]>,
  sessions: {} as Record<string, { kind: string; projectId?: string | null }>,
}
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: selectorStore(() => terminal),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: selectorStore(() => ({ activeProjectId: null })),
}))

const chat = { activeSessionId: null as string | null, setActiveSession: jest.fn() }
jest.mock("@/stores/chat/chat-store", () => ({ useChatStore: selectorStore(() => chat) }))

import type { TitleBarWindow } from "@/hooks/desktop/use-title-bar-window"
import { DOCS_URL } from "@/lib/constants/external-urls"
import { useAppMenuController, useRecentSessions } from "./use-app-menu-controller"

function makeWindow(overrides: Partial<TitleBarWindow> = {}): TitleBarWindow {
  return {
    platform: "win32",
    maximized: false,
    alwaysOnTop: false,
    minimize: jest.fn().mockResolvedValue(undefined),
    toggleMaximize: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    toggleFullscreen: jest.fn().mockResolvedValue(undefined),
    toggleAlwaysOnTop: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function setup(win = makeWindow()) {
  const onShowShortcuts = jest.fn()
  const hook = renderHook(() =>
    useAppMenuController({ window: win, recentSessions: [], onShowShortcuts })
  )
  return { ...hook, win, onShowShortcuts }
}

beforeEach(() => {
  jest.clearAllMocks()
  shellColumns.sidebarHostsNav = false
  terminal.panelOpen = false
  terminal.activeSessionIdByProject = {}
  terminal.sessions = {}
})

test("File commands delegate to the shared menu actions", () => {
  const { result } = setup()
  act(() => {
    result.current.run("new-chat")
    result.current.run("new-workflow")
    result.current.run("new-agent")
  })
  expect(actions.newChatAction).toHaveBeenCalled()
  expect(actions.newWorkflowAction).toHaveBeenCalled()
  expect(actions.newAgentAction).toHaveBeenCalled()
})

test("Quit and Window → Close both close the window", () => {
  const { result, win } = setup()
  act(() => {
    result.current.run("quit")
    result.current.run("close-window")
  })
  expect(win.close).toHaveBeenCalledTimes(2)
})

test("Help → Documentation opens the Cognia docs site", async () => {
  const { result } = setup()
  act(() => result.current.run("documentation"))
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith(DOCS_URL))
})

test("Help → Keyboard Shortcuts asks the bar to show the reference", () => {
  const { result, onShowShortcuts } = setup()
  act(() => result.current.run("keyboard-shortcuts"))
  expect(onShowShortcuts).toHaveBeenCalled()
})

test("View → Command Palette asks the palette directly", () => {
  const { result } = setup()
  act(() => result.current.run("command-palette"))
  expect(requestCommandPalette).toHaveBeenCalled()
})

test("zoom steps from the persisted level and saves the applied one", async () => {
  const { result } = setup()
  act(() => result.current.run("zoom-in"))
  await waitFor(() => expect(saveSettings).toHaveBeenCalled())
  const applied = applyZoom.mock.calls[0][0]
  expect(applied).toBeGreaterThan(1)
  expect(saveSettings).toHaveBeenCalledWith({ webviewZoom: applied })
})

test("reports checkbox state from the stores", () => {
  terminal.panelOpen = true
  const { result } = setup(makeWindow({ alwaysOnTop: true }))
  expect(result.current.state("toggle-sidebar")).toEqual({ checked: true })
  expect(result.current.state("toggle-guild-rail").checked).toBe(false)
  expect(result.current.state("toggle-reduce-motion")).toEqual({ checked: true })
  expect(result.current.state("toggle-terminal")).toEqual({ checked: true })
  expect(result.current.state("toggle-always-on-top")).toEqual({ checked: true })
  expect(result.current.state("about")).toEqual({})
})

test("notes the guild rail as folded while the sidebar hosts the navigation", () => {
  shellColumns.sidebarHostsNav = true
  const { result } = setup()
  expect(result.current.state("toggle-guild-rail").noteKey).toBe("view.guildRailFolded")
})

test("Maximize reads Restore while the window is maximized", () => {
  expect(setup().result.current.state("toggle-maximize")).toEqual({})
  expect(setup(makeWindow({ maximized: true })).result.current.state("toggle-maximize")).toEqual({
    labelKey: "window.restore",
  })
})

test("AI Shell is disabled without a non-serial terminal to act on", () => {
  expect(setup().result.current.state("toggle-ai-shell")).toEqual({ disabled: true })
  terminal.panelOpen = true
  terminal.activeSessionIdByProject = { "": "t1" }
  terminal.sessions = { t1: { kind: "pty", projectId: null } }
  expect(setup().result.current.state("toggle-ai-shell")).toEqual({ disabled: false })
})

test("theme and language choices read and write the preferences", () => {
  const { result } = setup()
  expect(result.current.choice("theme").value).toBe("dark")
  expect(result.current.choice("language").value).toBe("zh-CN")
  act(() => result.current.choice("theme").select("light"))
  expect(actions.setThemeAction).toHaveBeenCalledWith(setTheme, saveSettings, "light")
  act(() => result.current.choice("language").select("en"))
  expect(actions.setLanguageAction).toHaveBeenCalledWith(saveSettings, "en")
})

test("opening a recent session activates it on the DM home", () => {
  const { result } = setup()
  act(() => result.current.openRecentSession("s-1"))
  expect(chat.setActiveSession).toHaveBeenCalledWith("s-1")
  expect(ui.setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
  expect(routerPush).toHaveBeenCalledWith("/")
})

test("useRecentSessions lists the latest sessions, capped", async () => {
  listSessions.mockResolvedValue(
    Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `Chat ${i}` }))
  )
  const { result } = renderHook(() => useRecentSessions(3))
  await waitFor(() => expect(result.current).toHaveLength(3))
  expect(result.current[0].id).toBe("s0")
})

test("useRecentSessions keeps an empty list when loading fails", async () => {
  listSessions.mockRejectedValue(new Error("db closed"))
  const { result } = renderHook(() => useRecentSessions())
  await act(async () => {})
  expect(result.current).toEqual([])
})
