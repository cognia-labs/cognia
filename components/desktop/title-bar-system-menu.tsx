"use client"

/**
 * The title bar's right-click menu, anchored to the click point through a 0×0
 * invisible trigger.
 *
 * On Windows / Linux it carries the window commands (Restore, Minimize,
 * Maximize, Close) above "Customize layout"; on macOS the traffic lights own
 * the window commands, so it carries the customize entry alone — which is
 * where a user reaches for it after right-clicking the bottom bar.
 */

import { useTranslations } from "next-intl"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MENU_CONTENT_PERF } from "@/components/shared/menu-kit"
import type { TitleBarWindow } from "@/hooks/desktop/use-title-bar-window"

export interface TitleBarSystemMenuProps {
  /** Click point; `null` keeps the menu closed. */
  at: { x: number; y: number } | null
  onClose: () => void
  /** Whether this bar is the window chrome (Windows / Linux under Tauri). */
  windowChrome: boolean
  window: Pick<TitleBarWindow, "maximized" | "minimize" | "toggleMaximize" | "close">
  onCustomize: () => void
}

export function TitleBarSystemMenu({
  at,
  onClose,
  windowChrome,
  window: win,
  onCustomize,
}: TitleBarSystemMenuProps) {
  const tMenu = useTranslations("desktop.menu")
  const tShellLayout = useTranslations("desktop.shellLayout")
  if (!at) return null

  const act = (action: () => Promise<void> | void) => () => {
    onClose()
    void action()
  }

  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger
        data-testid="title-bar-system-menu-trigger"
        style={{
          position: "fixed",
          left: at.x,
          top: at.y,
          width: 0,
          height: 0,
          pointerEvents: "none",
        }}
        aria-hidden
      />
      <DropdownMenuContent align="start" sideOffset={0} className={MENU_CONTENT_PERF}>
        {windowChrome && (
          <>
            <DropdownMenuItem
              disabled={!win.maximized}
              onSelect={act(() => (win.maximized ? win.toggleMaximize() : undefined))}
            >
              {tMenu("window.restore")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={act(win.minimize)}>
              {tMenu("window.minimize")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={win.maximized}
              onSelect={act(() => (win.maximized ? undefined : win.toggleMaximize()))}
            >
              {tMenu("window.maximize")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={act(win.close)}>{tMenu("window.close")}</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem data-testid="title-bar-customize" onSelect={act(onCustomize)}>
          {tShellLayout("customizeTitleBar")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
