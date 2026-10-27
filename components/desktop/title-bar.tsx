"use client"

import { Button } from "@/components/ui/button"
import { isTauri } from "@/lib/tauri"
import { useElementWidth } from "@/hooks/use-element-width"
import {
  useTitleBarOutletRef,
  useTitleBarProjectionState,
} from "@/components/shell/title-bar-outlets"
import { useEdgePanelTransition } from "@/hooks/shell/use-edge-panel-transition"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { DEFAULT_SIDEBAR_SIDE } from "@/types/shell/sidebar"
import { computeTitleBarGeometry } from "@/lib/desktop/title-bar-geometry"
import { menubarFolds, navigationFolds } from "@/lib/desktop/title-bar-density"
import { goAction } from "@/lib/desktop/menu-actions"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import { MaximizeIcon, MinimizeIcon, MinusIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { usePathname, useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { TitleBarZone, type TitleBarItemContext } from "@/components/desktop/title-bar-zone"
import { TitleBarAppMenu } from "@/components/desktop/title-bar-app-menu"
import { TitleBarSystemMenu } from "@/components/desktop/title-bar-system-menu"
import { KeyboardShortcutsDialog } from "@/components/desktop/keyboard-shortcuts-dialog"
import { useNativeFullscreen } from "@/components/desktop/window-controls"
import { ShellLayoutDialog } from "@/components/shell/shell-layout-dialog"
import { useBarLayout } from "@/components/shell/use-bar-layout"
import { recordNavigation } from "@/hooks/desktop/use-nav-history"
import { useTitleBarWindow } from "@/hooks/desktop/use-title-bar-window"
import { useTitleBarTier } from "@/hooks/desktop/use-title-bar-tier"
import { useAppMenuController, useRecentSessions } from "@/hooks/desktop/use-app-menu-controller"

/** Ignore pointer gestures that land on real controls rather than the bare drag region. */
function onControl(target: EventTarget): boolean {
  return !!(target as HTMLElement).closest("button, [role='menuitem'], [data-radix-menu-content]")
}

/**
 * VSCode-style frameless title bar (active when `decorations: false`).
 *
 * Layout per platform:
 *   • macOS:    [traffic-light room] · [centre zone] · [end zone]
 *   • Windows / Linux:
 *     [start zone + application menu] · [centre zone] · [end zone] ·
 *     [min / max / close]
 *
 * This component only composes the bar. The pieces live beside it:
 *
 * - segments and their order — `title-bar-zone.tsx`, resolved from
 *   `AppSettings.titleBarLayout` by `useBarLayout("title")`; edited from
 *   `/settings?section=sidebar`, this bar's right-click menu or the Views menu;
 * - the Windows / Linux application menu — `title-bar-app-menu.tsx`, drawn
 *   from the one table in `lib/desktop/app-menu.ts` and driven by
 *   `useAppMenuController`;
 * - the frameless window's state and commands — `useTitleBarWindow`;
 * - the right-click menu — `title-bar-system-menu.tsx`;
 * - where the projected column headers sit — `lib/desktop/title-bar-geometry.ts`.
 *
 * Right-clicking the drag region opens the system menu; on Windows / Linux
 * double-clicking it toggles maximize.
 */
export function TitleBar() {
  const t = useTranslations("desktop.titleBar")
  const router = useRouter()
  const pathname = usePathname()
  const [mounted, setMounted] = useState(false)
  const [systemMenuAt, setSystemMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  const win = useTitleBarWindow()
  const recentSessions = useRecentSessions()
  const showShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const menu = useAppMenuController({ window: win, recentSessions, onShowShortcuts: showShortcuts })

  // Segment order + visibility, per zone. Edited in the customizer, persisted
  // in settings; see `components/shell/use-bar-layout.ts`.
  const { resolved: bar } = useBarLayout("title")
  // How much of the bar fits — the one input every fold below reads
  // (`lib/desktop/title-bar-density.ts`).
  const tier = useTitleBarTier()

  // ---- Column-header projection (see `components/shell/title-bar-outlets.tsx`)
  //
  // The chat workspace's column headers render into this bar. The start and
  // end outlets are sized to the measured widths of the conversation rail and
  // the artifact dock beneath them (`computeTitleBarGeometry`). Measured, not
  // derived: both columns animate, and the bar has to track them frame for
  // frame. While a column animates, the *target* width is the honest number —
  // under a View Transition the measured width is already final on the first
  // frame — so the outlets slide on the same clock as the snapshot below them.
  // `null` targets at rest and on every manual drag keep a divider drag live.
  const projected = useTitleBarProjectionState()
  const measuredRailPx = useShellColumnsStore((s) => s.widths.rail)
  const sidebarPx = useShellColumnsStore((s) => s.widths.sidebar)
  const dockPx = useShellColumnsStore((s) => s.widths.dock)
  const railTargetPx = useShellColumnsStore((s) => s.targets.rail)
  const sidebarTargetPx = useShellColumnsStore((s) => s.targets.sidebar)
  const dockTargetPx = useShellColumnsStore((s) => s.targets.dock)
  // Outlets settle like the edge panels above them do: when a projector stands
  // down at the *end* of a collapse the outlet still holds a strip of bar, and
  // hiding it on the same frame popped that strip back to the centre zone in
  // one jolt. The edge-panel flag keeps it mounted for one more transition —
  // to width 0 — then `hidden` takes it.
  const startOutletElRef = useRef<HTMLElement | null>(null)
  const endOutletElRef = useRef<HTMLElement | null>(null)
  const startSettling = useEdgePanelTransition(projected.start, { element: startOutletElRef })
  const endSettling = useEdgePanelTransition(projected.end, { element: endOutletElRef })
  const registerStartOutlet = useTitleBarOutletRef("start")
  const centerOutletRef = useTitleBarOutletRef("center")
  const registerEndOutlet = useTitleBarOutletRef("end")
  const sessionActionsOutletRef = useTitleBarOutletRef("sessionActions")
  const actionsOutletRef = useTitleBarOutletRef("actions")
  const startOutletRef = useCallback(
    (el: HTMLElement | null) => {
      startOutletElRef.current = el
      registerStartOutlet(el)
    },
    [registerStartOutlet]
  )
  const endOutletRef = useCallback(
    (el: HTMLElement | null) => {
      endOutletElRef.current = el
      registerEndOutlet(el)
    },
    [registerEndOutlet]
  )
  const sidebarSide = useSettingsStore((s) => s.settings?.sidebarSide ?? DEFAULT_SIDEBAR_SIDE)
  const barRef = useRef<HTMLElement | null>(null)
  const leftChromeRef = useRef<HTMLDivElement | null>(null)
  const rightChromeRef = useRef<HTMLDivElement | null>(null)
  const barPx = useElementWidth(barRef)
  const leftChromePx = useElementWidth(leftChromeRef)
  const rightChromePx = useElementWidth(rightChromeRef)
  // Beside a projected chat header, navigation folds below the workspace
  // segment's `lg` floor. Chat projection alone never moves it into a menu.
  const navigationFolded = navigationFolds(tier)
  const navigationItems = bar.zones.center.filter((item) => item.id !== "search")
  const searchItems = bar.zones.center.filter((item) => item.id === "search")

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true)
  }, [])

  // Feed the back/forward history (the title bar is mounted once for the whole
  // desktop shell, so this observes every route change).
  useEffect(() => {
    recordNavigation(pathname)
  }, [pathname])

  // macOS hides the traffic lights in native fullscreen, so the leading
  // reserve below has to go with them — kept, it was an 88px blank in front of
  // the app icon. `platform` is only set inside Tauri, so this is false (and
  // subscribes to nothing) in the web shell.
  const macFullscreen = useNativeFullscreen(win.platform.includes("mac"))

  if (!mounted) return null

  /**
   * Whether this bar is also the *window* chrome. Inside Tauri it owns the
   * frameless window's drag region, the Windows/Linux application menu and the
   * min / max / close cluster; in the web shell it is a plain 40px application
   * bar with the same customizable zones and none of the window plumbing — the
   * bar the column headers project into.
   */
  const tauri = isTauri()
  const isMac = tauri && win.platform.includes("mac")
  const windowChrome = tauri && !isMac
  // Room for the overlay traffic lights — none while they are hidden in
  // fullscreen. Must match the header's `pl-22` / `pl-2` below.
  const reserveTrafficLights = isMac && !macFullscreen
  const { startOutletPx, endOutletPx } = computeTitleBarGeometry({
    barPx,
    paddingLeftPx: reserveTrafficLights ? 88 : 8,
    leftChromePx,
    rightChromePx,
    sidebarSide,
    railPx: railTargetPx ?? measuredRailPx,
    sidebarPx: sidebarTargetPx ?? sidebarPx,
    dockPx: dockTargetPx ?? dockPx,
    projectedStart: projected.start,
    projectedEnd: projected.end,
  })
  // With the conversation rail's header in the bar the application menu would
  // sit over that column and push its header off its own rail, so the menus
  // fold into the hamburger whenever the start zone is projected — the same
  // fold the bar already does when it is compact.
  const menubarFolded = menubarFolds(tier, projected.start)

  const onTitleBarContextMenu = (event: React.MouseEvent) => {
    // Only the bare drag region opens the system menu.
    if (onControl(event.target)) return
    event.preventDefault()
    setSystemMenuAt({ x: event.clientX, y: event.clientY })
  }

  // Everything the customizable segments need from this component. Rebuilt
  // per render: the zones were already re-rendering with the bar.
  const itemCtx: TitleBarItemContext = {
    appName: t("appName"),
    separator: t("separator"),
    searchPlaceholder: t("searchPlaceholder"),
    recentSessions,
    onCommandPalette: () => menu.run("command-palette"),
    onOpenRecentSession: menu.openRecentSession,
    onGo: (id) => goAction(router, id),
  }

  return (
    <>
      <header
        ref={barRef}
        data-tauri-drag-region
        data-app-chrome
        data-window-controls={windowChrome ? true : undefined}
        data-testid="title-bar"
        onDoubleClick={(e) => {
          if (!windowChrome || onControl(e.target)) return
          void win.toggleMaximize()
        }}
        onContextMenu={onTitleBarContextMenu}
        className={cn(
          // Tint, no border — see `guild-rail.tsx`. The tone already reads as
          // "not content"; a border on top of it is a second seam.
          // `--chrome-h` (40px) is the shared column-header height: the
          // conversation rail, chat and workbench headers project their content
          // into this bar's zones (see `title-bar-outlets.tsx`), so the row has
          // to be as tall as the headers it replaces.
          //
          // macOS: the overlay traffic lights are native chrome this bar has to
          // make room for on BOTH axes. Vertically that is
          // `trafficLightPosition.y` in `tauri.macos.conf.json` — tao insets
          // them by growing the title-bar container and leaving the buttons at
          // their original offset inside it, so the drawn top edge lands at
          // `y - 7`, and centring a 14pt button in this 40px row wants y=20.
          // Horizontally the cluster ends around 72px, so `pl-22` (88px) keeps
          // the app icon off the green button. In native fullscreen the buttons
          // are gone, so the bar starts at the edge like Windows/Linux.
          "relative flex h-[var(--chrome-h)] shrink-0 items-center bg-muted/40 text-xs select-none",
          reserveTrafficLights ? "pl-22" : "pl-2"
        )}
      >
        <div ref={leftChromeRef} className="flex items-center gap-1">
          <TitleBarZone items={bar.zones.start} ctx={itemCtx} tier={tier} region="start" />
          <PluginExtensionSlot
            point="toolbar.left"
            className="flex items-center gap-1 empty:hidden"
          />
          {windowChrome && <TitleBarAppMenu controller={menu} folded={menubarFolded} />}
        </div>

        {/* Conversation-rail header lands here, sized to the rail below. */}
        <div
          ref={startOutletRef}
          data-testid="title-bar-outlet-start"
          data-title-bar-outlet="start"
          // `hidden` (the attribute) while nothing projects: an empty outlet is
          // not a control, and must not read as one to the chrome budget. The
          // settle keeps it mounted for the width-0 transition instead.
          hidden={!projected.start && !startSettling}
          className={cn(
            "flex h-full min-w-0 shrink-0 items-center overflow-hidden",
            // Armed while a column gesture has somewhere for this outlet to
            // slide to, or while the outlet itself is settling out — never at
            // rest, where a standing transition would lag manual resizes.
            (startSettling || railTargetPx !== null || sidebarTargetPx !== null) &&
              `transition-[width] ${SHELL_DOCK_TIMING_CLASS}`
          )}
          style={{ width: startOutletPx }}
        />

        <div
          data-tauri-drag-region
          className="flex flex-1 items-center justify-center gap-1 px-2 min-w-0"
        >
          {/* Navigation keeps its leading position on a wide window. It shares
              the title capture; session actions stay in the fixed right chrome. */}
          <div
            ref={centerOutletRef}
            data-testid="title-bar-outlet-center"
            data-title-bar-outlet="center"
            hidden={!projected.center}
            className="flex h-full min-w-0 flex-1 items-center"
          >
            {projected.center && !navigationFolded && (
              <div className="order-first flex shrink-0 items-center gap-1">
                <TitleBarZone items={navigationItems} ctx={itemCtx} tier={tier} />
              </div>
            )}
          </div>
          {!projected.center && <TitleBarZone items={bar.zones.center} ctx={itemCtx} tier={tier} />}
          <PluginExtensionSlot
            point="toolbar.center"
            className="ml-2 flex items-center gap-1 empty:hidden"
          />
        </div>

        {/* Artifact-dock header lands here, sized to the dock below. */}
        <div
          ref={endOutletRef}
          data-testid="title-bar-outlet-end"
          data-title-bar-outlet="end"
          hidden={!projected.end && !endSettling}
          className={cn(
            "flex h-full min-w-0 shrink-0 items-center overflow-hidden",
            (endSettling ||
              railTargetPx !== null ||
              sidebarTargetPx !== null ||
              dockTargetPx !== null) &&
              `transition-[width] ${SHELL_DOCK_TIMING_CLASS}`
          )}
          style={{ width: endOutletPx }}
        />

        <div
          ref={rightChromeRef}
          data-testid="title-bar-right-chrome"
          className="flex items-center"
        >
          <div
            ref={sessionActionsOutletRef}
            data-testid="title-bar-outlet-session-actions"
            data-title-bar-outlet="sessionActions"
            hidden={!projected.sessionActions}
            className="flex h-full shrink-0 items-center"
          />
          {projected.center && (
            <TitleBarZone
              items={navigationFolded ? bar.zones.center : searchItems}
              ctx={itemCtx}
              tier={tier}
              compact
            />
          )}
          <PluginExtensionSlot
            point="toolbar.right"
            className="flex items-center gap-1 px-1 empty:hidden"
          />

          <TitleBarZone items={bar.zones.end} ctx={itemCtx} tier={tier} region="end" />

          <div
            ref={actionsOutletRef}
            data-testid="title-bar-outlet-actions"
            hidden={!projected.actions}
            className="flex h-full shrink-0 items-center"
          />

          {windowChrome ? (
            <div className="flex items-center">
              <TitleBarButton onClick={win.minimize} aria-label={t("minimize")}>
                <MinusIcon className="size-3.5" />
              </TitleBarButton>
              <TitleBarButton
                onClick={win.toggleMaximize}
                aria-label={win.maximized ? t("restore") : t("maximize")}
              >
                {win.maximized ? (
                  <MinimizeIcon className="size-3.5" />
                ) : (
                  <MaximizeIcon className="size-3.5" />
                )}
              </TitleBarButton>
              <TitleBarButton
                onClick={win.close}
                aria-label={t("close")}
                className="hover:bg-destructive hover:text-destructive-foreground"
              >
                <XIcon className="size-3.5" />
              </TitleBarButton>
            </div>
          ) : (
            <div data-tauri-drag-region className="w-2" />
          )}
        </div>

        <TitleBarSystemMenu
          at={systemMenuAt}
          onClose={() => setSystemMenuAt(null)}
          windowChrome={windowChrome}
          window={win}
          onCustomize={() => setCustomizeOpen(true)}
        />
      </header>
      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ShellLayoutDialog open={customizeOpen} onOpenChange={setCustomizeOpen} surface="title" />
    </>
  )
}

function TitleBarButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-10 w-10 rounded-none transition-colors", className)}
      {...props}
    />
  )
}
