/**
 * The in-window application menu, as data.
 *
 * The Windows / Linux title bar draws these menus twice — as a Menubar on a
 * wide window and as one long hamburger dropdown on a narrow one — and the
 * keyboard-shortcuts dialog lists their key hints. All three used to be
 * hand-written JSX that had already drifted apart (separators, items, hints).
 * Now `components/desktop/title-bar-app-menu.tsx` renders this one table
 * through the menu kits, and the dialog derives its rows from it.
 *
 * The table holds structure only. What a command does, whether a checkbox is
 * ticked and which label a stateful item shows (Maximize / Restore) are the
 * controller's (`hooks/desktop/use-app-menu-controller.ts`), keyed by
 * {@link AppMenuCommand}.
 *
 * Every command appears once. The menus used to repeat themselves (Command
 * Palette under View and Tools, the kill switch under Run and Tools, Open Logs
 * under File and View, Restart Sidecar under Tools and Terminal); the Run menu
 * only held items that already lived in File, Go and Tools, so it is gone.
 * `app-menu.test.ts` pins both rules.
 *
 * Command ids reuse the native menu's spelling (`MENU_COMMAND_IDS` in
 * `lib/desktop/menu-actions.ts`) wherever the native menu has the same item.
 */

/** Top-level menus, in menubar order. */
export type AppMenuId = "file" | "edit" | "view" | "go" | "tools" | "terminal" | "window" | "help"

/** Everything an in-window menu item can ask the controller to do. */
export type AppMenuCommand =
  // File
  | "new-chat"
  | "new-workflow"
  | "new-agent-team"
  | "new-agent"
  | "open-workspace"
  | "open-settings"
  | "open-logs"
  | "quit"
  // Edit
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "find"
  // View
  | "command-palette"
  | "toggle-sidebar"
  | "toggle-guild-rail"
  | "toggle-status-bar"
  | "toggle-reduce-motion"
  | "reload"
  | "toggle-fullscreen"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  // Tools
  | "automation-kill-switch"
  | "manage-connectors"
  | "manage-mcp-server"
  | "plugin-devtools"
  | "sidecar-restart"
  | "clear-cache"
  // Terminal
  | "new-terminal"
  | "toggle-terminal"
  | "toggle-ai-shell"
  // Window
  | "toggle-always-on-top"
  | "minimize"
  | "toggle-maximize"
  | "close-window"
  // Help
  | "keyboard-shortcuts"
  | "documentation"
  | "about"

/**
 * A trailing key hint.
 *
 * `app` names an app-scope shortcut (`lib/shortcuts/app-catalog.ts`), printed
 * as its *effective* chord — the user's rebinding, in the platform's glyphs.
 * Use it only for descriptors that fire on the desktop shell; a web-only
 * descriptor (`!platform.tauri`) may be rebound without moving the native
 * accelerator that actually serves the desktop.
 *
 * `label` is a key under `desktop.menu.shortcut.*` for a chord owned by the
 * native menu accelerator or a fixed listener (⌘N, F11, …).
 */
export type AppMenuShortcut = { app: string } | { label: string }

/** A user preference a radio submenu picks from. */
export type AppMenuChoiceSetting = "theme" | "language"

export type AppMenuNode =
  | {
      kind: "action"
      command: AppMenuCommand
      /** Key under `desktop.menu.*`. */
      labelKey: string
      shortcut?: AppMenuShortcut
      destructive?: boolean
    }
  | {
      /** A checkbox item; the controller reports `checked`. */
      kind: "toggle"
      command: AppMenuCommand
      labelKey: string
      shortcut?: AppMenuShortcut
    }
  | {
      /** A submenu of radio items bound to one preference. */
      kind: "choice"
      setting: AppMenuChoiceSetting
      labelKey: string
      options: readonly { value: string; labelKey: string }[]
    }
  /** The File menu's recent-conversations submenu (loaded by the controller). */
  | { kind: "recentSessions"; labelKey: string }
  /** Every Go-menu destination (`lib/desktop/go-menu.ts`), section by section. */
  | { kind: "goDestinations" }
  | { kind: "separator" }

export interface AppMenuSpec {
  id: AppMenuId
  /** Key under `desktop.menu.*` for the trigger / section label. */
  labelKey: string
  items: readonly AppMenuNode[]
}

const SEPARATOR: AppMenuNode = { kind: "separator" }

export const APP_MENUS: readonly AppMenuSpec[] = [
  {
    id: "file",
    labelKey: "file.label",
    items: [
      {
        kind: "action",
        command: "new-chat",
        labelKey: "file.newChat",
        shortcut: { label: "cmdOrCtrlN" },
      },
      {
        kind: "action",
        command: "new-workflow",
        labelKey: "file.newWorkflow",
        shortcut: { label: "cmdOrCtrlShiftN" },
      },
      { kind: "action", command: "new-agent-team", labelKey: "file.newAgentTeam" },
      { kind: "action", command: "new-agent", labelKey: "file.newAgent" },
      SEPARATOR,
      {
        kind: "action",
        command: "open-workspace",
        labelKey: "file.openWorkspace",
        shortcut: { label: "cmdOrCtrlO" },
      },
      {
        kind: "action",
        command: "open-settings",
        labelKey: "file.openSettings",
        shortcut: { label: "cmdOrCtrlComma" },
      },
      {
        kind: "action",
        command: "open-logs",
        labelKey: "file.openLogs",
        shortcut: { label: "cmdOrCtrlShiftL" },
      },
      { kind: "recentSessions", labelKey: "file.recentSessions" },
      SEPARATOR,
      { kind: "action", command: "quit", labelKey: "file.quit" },
    ],
  },
  {
    id: "edit",
    labelKey: "edit.label",
    items: [
      { kind: "action", command: "undo", labelKey: "edit.undo" },
      { kind: "action", command: "redo", labelKey: "edit.redo" },
      SEPARATOR,
      { kind: "action", command: "cut", labelKey: "edit.cut" },
      { kind: "action", command: "copy", labelKey: "edit.copy" },
      { kind: "action", command: "paste", labelKey: "edit.paste" },
      { kind: "action", command: "select-all", labelKey: "edit.selectAll" },
      SEPARATOR,
      {
        kind: "action",
        command: "find",
        labelKey: "edit.find",
        shortcut: { label: "cmdOrCtrlF" },
      },
    ],
  },
  {
    id: "view",
    labelKey: "view.label",
    items: [
      {
        kind: "action",
        command: "command-palette",
        labelKey: "view.commandPalette",
        shortcut: { app: "app.commandPalette.toggle" },
      },
      {
        kind: "toggle",
        command: "toggle-sidebar",
        labelKey: "view.toggleSidebar",
        shortcut: { label: "cmdOrCtrlB" },
      },
      { kind: "toggle", command: "toggle-guild-rail", labelKey: "view.toggleGuildRail" },
      { kind: "toggle", command: "toggle-status-bar", labelKey: "view.toggleStatusBar" },
      SEPARATOR,
      {
        kind: "choice",
        setting: "theme",
        labelKey: "view.theme",
        options: [
          { value: "light", labelKey: "view.themeLight" },
          { value: "dark", labelKey: "view.themeDark" },
          { value: "system", labelKey: "view.themeSystem" },
        ],
      },
      {
        kind: "choice",
        setting: "language",
        labelKey: "view.language",
        options: [
          { value: "en", labelKey: "view.languageEnglish" },
          { value: "zh-CN", labelKey: "view.languageChinese" },
        ],
      },
      { kind: "toggle", command: "toggle-reduce-motion", labelKey: "view.reduceMotion" },
      SEPARATOR,
      {
        kind: "action",
        command: "reload",
        labelKey: "view.reload",
        shortcut: { label: "cmdOrCtrlR" },
      },
      {
        kind: "action",
        command: "toggle-fullscreen",
        labelKey: "view.toggleFullscreen",
        shortcut: { label: "f11" },
      },
      SEPARATOR,
      { kind: "action", command: "zoom-in", labelKey: "view.zoomIn", shortcut: { app: "zoom.in" } },
      {
        kind: "action",
        command: "zoom-out",
        labelKey: "view.zoomOut",
        shortcut: { app: "zoom.out" },
      },
      {
        kind: "action",
        command: "zoom-reset",
        labelKey: "view.zoomReset",
        shortcut: { app: "zoom.reset" },
      },
    ],
  },
  { id: "go", labelKey: "go.label", items: [{ kind: "goDestinations" }] },
  {
    id: "tools",
    labelKey: "tools.label",
    items: [
      {
        kind: "action",
        command: "automation-kill-switch",
        labelKey: "tools.automationKillSwitch",
        shortcut: { label: "ctrlAltK" },
        destructive: true,
      },
      { kind: "action", command: "manage-connectors", labelKey: "tools.manageConnectors" },
      { kind: "action", command: "manage-mcp-server", labelKey: "tools.manageMcpServer" },
      SEPARATOR,
      { kind: "action", command: "plugin-devtools", labelKey: "tools.pluginDevtools" },
      { kind: "action", command: "sidecar-restart", labelKey: "tools.sidecarRestart" },
      { kind: "action", command: "clear-cache", labelKey: "tools.clearCache" },
    ],
  },
  {
    id: "terminal",
    labelKey: "terminal.label",
    items: [
      { kind: "action", command: "new-terminal", labelKey: "terminal.new" },
      {
        kind: "toggle",
        command: "toggle-terminal",
        labelKey: "terminal.togglePanel",
        shortcut: { app: "terminal.toggle" },
      },
      {
        kind: "action",
        command: "toggle-ai-shell",
        labelKey: "terminal.aiShellToggle",
        shortcut: { app: "terminal.aiShell.toggle" },
      },
    ],
  },
  {
    id: "window",
    labelKey: "window.label",
    items: [
      { kind: "toggle", command: "toggle-always-on-top", labelKey: "window.alwaysOnTop" },
      SEPARATOR,
      { kind: "action", command: "minimize", labelKey: "window.minimize" },
      // The controller swaps in `window.restore` while the window is maximized.
      { kind: "action", command: "toggle-maximize", labelKey: "window.maximize" },
      SEPARATOR,
      { kind: "action", command: "close-window", labelKey: "window.close" },
    ],
  },
  {
    id: "help",
    labelKey: "help.label",
    items: [
      { kind: "action", command: "keyboard-shortcuts", labelKey: "help.keyboardShortcuts" },
      SEPARATOR,
      { kind: "action", command: "documentation", labelKey: "help.documentation" },
      { kind: "action", command: "about", labelKey: "help.about" },
    ],
  },
]

/** One row of the keyboard-shortcuts reference. */
export interface ShortcutReferenceRow {
  /** Key under `desktop.menu.*`. */
  labelKey: string
  shortcut: AppMenuShortcut
}

/**
 * Chords the desktop shell answers that have no menu item of their own, so
 * the reference would otherwise omit them.
 */
const UNLISTED_SHORTCUT_ROWS: readonly ShortcutReferenceRow[] = [
  { labelKey: "view.toggleSidechat", shortcut: { app: "chat.sidechat.toggle" } },
  { labelKey: "view.toggleDevtools", shortcut: { label: "cmdOrCtrlAltI" } },
]

/**
 * The keyboard-shortcuts reference: every menu item that carries a key hint,
 * in menu order, then the unlisted chords. Derived, so a hint added to the
 * menu shows up in the reference without a second list to keep in step.
 */
export function shortcutReferenceRows(
  menus: readonly AppMenuSpec[] = APP_MENUS
): ShortcutReferenceRow[] {
  const rows: ShortcutReferenceRow[] = []
  for (const menu of menus) {
    for (const node of menu.items) {
      if ((node.kind === "action" || node.kind === "toggle") && node.shortcut) {
        rows.push({ labelKey: node.labelKey, shortcut: node.shortcut })
      }
    }
  }
  return [...rows, ...UNLISTED_SHORTCUT_ROWS]
}

/** Every app-scope shortcut id the menus and the reference print, deduplicated. */
export const APP_MENU_SHORTCUT_IDS: readonly string[] = Array.from(
  new Set(
    shortcutReferenceRows()
      .map((row) => ("app" in row.shortcut ? row.shortcut.app : null))
      .filter((id): id is string => id !== null)
  )
)
