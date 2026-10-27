"use client"

/**
 * What the in-window application menu (`lib/desktop/app-menu.ts`) does.
 *
 * The menu table is structure only; this hook answers, per
 * {@link AppMenuCommand}, how to run it and what state it shows (ticked,
 * disabled, an alternate label). The Menubar, the hamburger dropdown and the
 * right-click system menu all dispatch through it, so the same item can no
 * longer behave differently depending on the window width.
 *
 * Commands that the native menu also fires delegate to the shared actions in
 * `lib/desktop/menu-actions.ts` where the two must stay identical (New Chat,
 * the Go destinations, the Tools menu), and keep their title-bar log lines.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"

import type { TitleBarWindow } from "@/hooks/desktop/use-title-bar-window"
import type { AppMenuChoiceSetting, AppMenuCommand } from "@/lib/desktop/app-menu"
import type { GoMenuId } from "@/lib/desktop/go-menu"
import {
  automationKillSwitchAction,
  clearCacheAction,
  goAction,
  manageConnectorsAction,
  manageMcpServerAction,
  newAgentAction,
  newAgentTeamAction,
  newChatAction,
  newWorkflowAction,
  pluginDevtoolsAction,
  restartSidecarAction,
  setLanguageAction,
  setThemeAction,
  toggleGuildRailAction,
  toggleReduceMotionAction,
  toggleStatusBarAction,
} from "@/lib/desktop/menu-actions"
import { DOCS_URL } from "@/lib/constants/external-urls"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { listSessions } from "@/lib/db/sessions"
import { requestCommandPalette } from "@/lib/shell/command-palette-request"
import { getAppRegistration } from "@/lib/shortcuts/app-runtime"
import { applyZoom, clampZoom, DEFAULT_ZOOM, ZOOM_STEP } from "@/lib/tauri/webview-zoom"
import { spawnDefaultTerminal } from "@/lib/terminal/spawn-default"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useUIStore } from "@/stores/ui/ui-store"

const log = loggers.ui

/** A recent conversation, as the File menu and the command-centre caret list it. */
export interface RecentSessionEntry {
  id: string
  title: string
  characterId?: string
}

/** Per-command state the renderer reads. */
export interface AppMenuCommandState {
  checked?: boolean
  disabled?: boolean
  /** Replaces the item's label key (Window → Maximize reads Restore while maximized). */
  labelKey?: string
  /** Key under `desktop.menu.*` drawn as the item's trailing note. */
  noteKey?: string
}

export interface AppMenuController {
  run: (command: AppMenuCommand) => void
  state: (command: AppMenuCommand) => AppMenuCommandState
  choice: (setting: AppMenuChoiceSetting) => { value: string; select: (value: string) => void }
  recentSessions: RecentSessionEntry[]
  openRecentSession: (sessionId: string) => void
  go: (id: GoMenuId) => void
}

/**
 * The most recent conversations, refreshed whenever the active one changes so
 * a new conversation is listed the next time the menu opens. Not
 * Tauri-gated: the command-centre caret lists them in the web shell too.
 */
export function useRecentSessions(limit = 8): RecentSessionEntry[] {
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const [recent, setRecent] = useState<RecentSessionEntry[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await listSessions()
        if (!cancelled) setRecent(filterExposedSessions(rows, "global-search").slice(0, limit))
      } catch (err) {
        log.warn("title-bar load recent-sessions failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeSessionId, limit])
  return recent
}

/** Whether Terminal → AI Shell has a non-serial terminal to act on in this project. */
function useAiShellAvailable(): boolean {
  const projectId = useProjectStore((s) => s.activeProjectId)
  return useTerminalStore((s) => {
    const anchorId = s.activeSessionIdByProject?.[projectId ?? ""]
    if (!anchorId || !s.panelOpen) return false
    const focused = s.focusedPaneByAnchor?.[anchorId]
    const targetId =
      focused && (focused === anchorId || s.splitPanes?.[anchorId]?.includes(focused))
        ? focused
        : anchorId
    const row = s.sessions[targetId]
    return !!row && row.kind !== "serial" && (row.projectId ?? "") === (projectId ?? "")
  })
}

export function useAppMenuController({
  window: win,
  recentSessions,
  onShowShortcuts,
}: {
  window: TitleBarWindow
  recentSessions: RecentSessionEntry[]
  onShowShortcuts: () => void
}): AppMenuController {
  const t = useTranslations("desktop.titleBar")
  const router = useRouter()
  const { theme: rawTheme, setTheme } = useTheme()

  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const openFind = useUIStore((s) => s.openFind)
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
  const guildRailCollapsed = useUIStore((s) => s.guildRailCollapsed)
  const statusBarCollapsed = useUIStore((s) => s.statusBarCollapsed)
  // The icon column folds into the expanded conversation sidebar while that
  // hosts the navigation rows; the checkbox keeps reporting the preference
  // and says so, instead of claiming a rail that is not drawn.
  const sidebarHostsNav = useShellColumnsStore((s) => s.sidebarHostsNav)

  const persistedZoom = useSettingsStore((s) => s.settings?.webviewZoom)
  const persistedLanguage = useSettingsStore((s) => s.settings?.language)
  const persistedReduceMotion = useSettingsStore((s) => s.settings?.reduceMotion)
  const saveSettings = useSettingsStore((s) => s.save)

  const terminalOpen = useTerminalStore((s) => s.panelOpen)
  const setTerminalPanelOpen = useTerminalStore((s) => s.setPanelOpen)
  const toggleTerminalPanel = useTerminalStore((s) => s.togglePanel)
  const aiShellAvailable = useAiShellAvailable()

  // next-themes rehydrates after mount; "system" keeps the radio group valid
  // on the first render.
  const theme = (rawTheme ?? "system") as "light" | "dark" | "system"
  const language = persistedLanguage ?? "en"
  const reduceMotion = persistedReduceMotion ?? false
  const zoom = clampZoom(persistedZoom ?? DEFAULT_ZOOM)

  const openRecentSession = useCallback(
    (sessionId: string) => {
      log.info("title-bar menu open-recent-session", { sessionId })
      useChatStore.getState().setActiveSession(sessionId)
      setSelectedGuild({ kind: "dm" })
      router.push("/")
    },
    [router, setSelectedGuild]
  )

  const go = useCallback((id: GoMenuId) => goAction(router, id), [router])

  const run = useCallback(
    (command: AppMenuCommand) => {
      const execEdit = (cmd: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll") => {
        log.info("title-bar edit", { cmd })
        try {
          // execCommand is deprecated but it's the only way to trigger
          // selection-aware behavior for arbitrary contenteditable / input
          // targets without going through the OS clipboard explicitly.
          document.execCommand(cmd)
        } catch (err) {
          log.warn("title-bar edit failed", {
            cmd,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const zoomTo = async (kind: "in" | "out" | "reset") => {
        const target =
          kind === "reset" ? DEFAULT_ZOOM : kind === "in" ? zoom + ZOOM_STEP : zoom - ZOOM_STEP
        const next = await applyZoom(target)
        try {
          await saveSettings({ webviewZoom: next })
        } catch (err) {
          log.warn("title-bar zoom persist failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const logged = async (event: string, action: () => Promise<void>) => {
        log.info(`title-bar tools ${event}`)
        try {
          await action()
        } catch (err) {
          log.warn(`title-bar tools ${event} failed`, {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      switch (command) {
        // ---- File
        case "new-chat":
          log.info("title-bar menu new-chat")
          // Delegates so this menu and the native one (`menu://new-chat`)
          // cannot drift apart.
          newChatAction()
          return
        case "new-workflow":
          newWorkflowAction(router)
          return
        case "new-agent-team":
          newAgentTeamAction(router)
          return
        case "new-agent":
          newAgentAction(router)
          return
        case "open-workspace":
          log.info("title-bar menu open-workspace")
          // Unified flow: pick a folder and create/activate a real workspace
          // Project (mirrors the native File menu / Cmd+O / the switcher).
          void openFolderAsWorkspace().catch((err: unknown) => {
            log.warn("title-bar open-workspace failed", {
              error: err instanceof Error ? err.message : String(err),
            })
          })
          return
        case "open-settings":
          log.info("title-bar menu open-settings")
          router.push("/settings")
          return
        case "open-logs":
          log.info("title-bar menu open-logs")
          router.push("/logs")
          return
        case "quit":
          void win.close()
          return
        // ---- Edit
        case "undo":
        case "redo":
        case "cut":
        case "copy":
        case "paste":
          execEdit(command)
          return
        case "select-all":
          execEdit("selectAll")
          return
        case "find":
          log.info("title-bar menu find")
          // The desktop shell mounts the in-app find bar; it also answers
          // Ctrl/Cmd+F globally.
          openFind()
          return
        // ---- View
        case "command-palette":
          log.info("title-bar menu command-palette")
          // Ask the palette directly instead of forging its chord: the
          // keystroke had to guess the platform modifier.
          requestCommandPalette()
          return
        case "toggle-sidebar":
          log.info("title-bar menu toggle-sidebar")
          toggleSidebar()
          return
        case "toggle-guild-rail":
          toggleGuildRailAction()
          return
        case "toggle-status-bar":
          toggleStatusBarAction()
          return
        case "toggle-reduce-motion":
          void toggleReduceMotionAction(reduceMotion, saveSettings)
          return
        case "reload":
          log.info("title-bar menu reload")
          window.location.reload()
          return
        case "toggle-fullscreen":
          void win.toggleFullscreen()
          return
        case "zoom-in":
          void zoomTo("in")
          return
        case "zoom-out":
          void zoomTo("out")
          return
        case "zoom-reset":
          void zoomTo("reset")
          return
        // ---- Tools
        case "automation-kill-switch":
          void logged("automation-kill-switch", automationKillSwitchAction)
          return
        case "manage-connectors":
          manageConnectorsAction(router)
          return
        case "manage-mcp-server":
          manageMcpServerAction(router)
          return
        case "plugin-devtools":
          pluginDevtoolsAction(router)
          return
        case "sidecar-restart":
          void logged("sidecar-restart", restartSidecarAction)
          return
        case "clear-cache":
          void logged("clear-cache", clearCacheAction)
          return
        // ---- Terminal
        case "new-terminal":
          log.info("title-bar terminal new")
          // Open the dock AND spawn — a "New terminal" that only revealed an
          // empty panel was the item lying about what it does. The shell /
          // profile / cwd precedence is the dock's own "+" (`spawnDefaultTerminal`).
          setTerminalPanelOpen(true)
          void spawnDefaultTerminal().then((outcome) => {
            if (outcome.kind === "error")
              toast.error(t("terminalSpawnError", { message: outcome.message }))
            else if (outcome.kind === "denied") toast.error(t("terminalSpawnDenied"))
          })
          return
        case "toggle-terminal":
          log.info("title-bar terminal toggle")
          toggleTerminalPanel()
          return
        case "toggle-ai-shell":
          getAppRegistration("terminal.aiShell.toggle")?.handler(new KeyboardEvent("keydown"))
          return
        // ---- Window
        case "toggle-always-on-top":
          void win.toggleAlwaysOnTop()
          return
        case "minimize":
          void win.minimize()
          return
        case "toggle-maximize":
          void win.toggleMaximize()
          return
        case "close-window":
          void win.close()
          return
        // ---- Help
        case "keyboard-shortcuts":
          log.info("title-bar help keyboard-shortcuts")
          onShowShortcuts()
          return
        case "documentation":
          log.info("title-bar menu documentation")
          void (async () => {
            try {
              const { openExternal } = await import("@/lib/tauri/opener")
              await openExternal(DOCS_URL)
            } catch (err) {
              log.error("title-bar documentation failed", err)
            }
          })()
          return
        case "about":
          log.info("title-bar menu about")
          router.push("/settings?section=about")
          return
      }
    },
    [
      onShowShortcuts,
      openFind,
      reduceMotion,
      router,
      saveSettings,
      setTerminalPanelOpen,
      t,
      toggleSidebar,
      toggleTerminalPanel,
      win,
      zoom,
    ]
  )

  const state = useCallback(
    (command: AppMenuCommand): AppMenuCommandState => {
      switch (command) {
        case "toggle-sidebar":
          return { checked: !sidebarCollapsed }
        case "toggle-guild-rail":
          return {
            checked: !guildRailCollapsed,
            noteKey: sidebarHostsNav ? "view.guildRailFolded" : undefined,
          }
        case "toggle-status-bar":
          return { checked: !statusBarCollapsed }
        case "toggle-reduce-motion":
          return { checked: reduceMotion }
        case "toggle-terminal":
          return { checked: terminalOpen }
        case "toggle-ai-shell":
          return { disabled: !aiShellAvailable }
        case "toggle-always-on-top":
          return { checked: win.alwaysOnTop }
        case "toggle-maximize":
          return win.maximized ? { labelKey: "window.restore" } : {}
        default:
          return {}
      }
    },
    [
      aiShellAvailable,
      guildRailCollapsed,
      reduceMotion,
      sidebarCollapsed,
      sidebarHostsNav,
      statusBarCollapsed,
      terminalOpen,
      win.alwaysOnTop,
      win.maximized,
    ]
  )

  const choice = useCallback(
    (setting: AppMenuChoiceSetting) =>
      setting === "theme"
        ? {
            value: theme,
            select: (next: string) =>
              void setThemeAction(setTheme, saveSettings, next as "light" | "dark" | "system"),
          }
        : {
            value: language,
            select: (next: string) => void setLanguageAction(saveSettings, next as "en" | "zh-CN"),
          },
    [language, saveSettings, setTheme, theme]
  )

  return useMemo(
    () => ({ run, state, choice, recentSessions, openRecentSession, go }),
    [run, state, choice, recentSessions, openRecentSession, go]
  )
}
