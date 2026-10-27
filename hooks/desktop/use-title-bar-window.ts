"use client"

/**
 * The frameless window, as the title bar sees it: which platform's chrome to
 * draw, whether the window is maximized / pinned on top, and the window
 * commands the min / max / close cluster, the Window menu and the right-click
 * system menu all dispatch.
 *
 * Outside Tauri every command is a logged no-op failure path and the state
 * stays at its defaults; `platform` is only set inside Tauri, which is what
 * keeps the web shell from drawing any window chrome.
 */

import { useCallback, useEffect, useState } from "react"
import { loggers } from "@cognia/logging"

import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

const log = loggers.ui

type WindowApi = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  isFullscreen: () => Promise<boolean>
  setFullscreen: (full: boolean) => Promise<void>
  setAlwaysOnTop?: (on: boolean) => Promise<void>
  isAlwaysOnTop?: () => Promise<boolean>
  onResized: (cb: () => void) => Promise<() => void>
}

async function getWin(): Promise<WindowApi> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window")
  return getCurrentWindow() as unknown as WindowApi
}

export interface TitleBarWindow {
  /** `navigator.platform`, lower-cased — `""` outside Tauri and before setup. */
  platform: string
  maximized: boolean
  alwaysOnTop: boolean
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  toggleFullscreen: () => Promise<void>
  toggleAlwaysOnTop: () => Promise<void>
}

export function useTitleBarWindow(): TitleBarWindow {
  const [platform, setPlatform] = useState("")
  const [maximized, setMaximized] = useState(false)
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)

  useEffect(() => {
    if (!isTauri()) return

    let unlisten: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        const win = await getWin()
        const initiallyMaximized = await win.isMaximized()
        if (cancelled) return
        setMaximized(initiallyMaximized)
        try {
          if (win.isAlwaysOnTop) {
            const onTop = await win.isAlwaysOnTop()
            if (!cancelled) setAlwaysOnTop(onTop)
          }
        } catch {
          /* not all platforms support isAlwaysOnTop in older Tauri builds */
        }
        if (cancelled) return
        if (typeof navigator !== "undefined") {
          setPlatform(navigator.platform.toLowerCase())
        }
        const dispose = await win.onResized(async () => {
          const next = await win.isMaximized()
          if (!cancelled) setMaximized(next)
        })
        // Unmounted while the registration was in flight: release it now.
        if (cancelled) {
          safeUnlisten(dispose)
          return
        }
        unlisten = dispose
      } catch (err) {
        log.warn("title-bar window setup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [])

  const minimize = useCallback(async () => {
    log.info("title-bar minimize")
    try {
      await (await getWin()).minimize()
    } catch (err) {
      log.error("title-bar minimize failed", err)
    }
  }, [])

  const toggleMaximize = useCallback(async () => {
    log.info("title-bar toggle maximize", { wasMaximized: maximized })
    try {
      await (await getWin()).toggleMaximize()
    } catch (err) {
      log.error("title-bar toggle maximize failed", err)
    }
  }, [maximized])

  const close = useCallback(async () => {
    log.info("title-bar close")
    try {
      await (await getWin()).close()
    } catch (err) {
      log.error("title-bar close failed", err)
    }
  }, [])

  const toggleFullscreen = useCallback(async () => {
    log.info("title-bar menu toggle-fullscreen")
    try {
      const win = await getWin()
      const fs = await win.isFullscreen()
      await win.setFullscreen(!fs)
    } catch (err) {
      log.error("title-bar toggle-fullscreen failed", err)
    }
  }, [])

  const toggleAlwaysOnTop = useCallback(async () => {
    log.info("title-bar always-on-top toggle", { from: alwaysOnTop })
    try {
      const win = await getWin()
      if (win.setAlwaysOnTop) {
        await win.setAlwaysOnTop(!alwaysOnTop)
        setAlwaysOnTop(!alwaysOnTop)
      }
    } catch (err) {
      log.warn("title-bar always-on-top failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [alwaysOnTop])

  return {
    platform,
    maximized,
    alwaysOnTop,
    minimize,
    toggleMaximize,
    close,
    toggleFullscreen,
    toggleAlwaysOnTop,
  }
}
