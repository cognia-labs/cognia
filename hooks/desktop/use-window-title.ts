"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { useBarTitle } from "@/hooks/desktop/use-bar-title"
import { isTauri } from "@/lib/tauri"
import { isMainAppWindow } from "@/lib/pet/window-role"
import { loggers } from "@cognia/logging"

const log = loggers.ui

/**
 * Build the OS/document window title: `"<subject> · <appName>"` — the
 * conversation or the page in front — or just the app name when there is
 * nothing to name. Doc-first to match the
 * existing share-view convention (`app/share/view/page.tsx`).
 */
export function computeWindowTitle(doc: string | null | undefined, appName: string): string {
  const trimmed = doc?.trim()
  return trimmed ? `${trimmed} · ${appName}` : appName
}

/**
 * The browser tab's title: the window title with the attention count in front
 * (`"(3) Refactor list · Cognia"`), the convention mail and chat tabs use to
 * say "something is waiting" from a background tab. `format` is the localized
 * template (`desktop.titleBar.titleWithCount`); a zero count leaves the title
 * alone.
 */
export function computeDocumentTitle(
  title: string,
  count: number,
  format: (values: { count: number; title: string }) => string
): string {
  return count > 0 ? format({ count, title }) : title
}

/**
 * Sync the OS window title (taskbar / app switcher / Alt-Tab) and the browser
 * `document.title` to what is in front: the active conversation on the chat
 * home, the page's name elsewhere — the same subject the title bar names
 * (`useBarTitle`). The conversation side is the **persisted** session title,
 * never streaming status, so it does not flicker per token, and it only writes
 * when the computed string actually changes. The auxiliary windows (pet,
 * island, selection toolbar) keep naming the conversation: their routes are
 * not pages the user navigated to. In Tauri it also calls
 * `getCurrentWindow().setTitle`; in the browser / Capacitor shells the
 * `document.title` write is the meaningful one.
 *
 * `attentionCount` (`useAppAttentionCount`, already `0` when the user turned
 * the app badge off) is prefixed to the *browser* title only. The desktop
 * build carries it on the dock tile instead (`useAppBadge`), and a window
 * title that changes with every unread message would churn the app switcher.
 */
export function useWindowTitle(attentionCount = 0): void {
  const t = useTranslations("desktop.titleBar")
  const appName = t("appName")
  const { label } = useBarTitle({ followRoute: isMainAppWindow() })
  const title = computeWindowTitle(label, appName)
  const documentTitle = isTauri()
    ? title
    : computeDocumentTitle(title, attentionCount, (values) => t("titleWithCount", values))
  const lastRef = useRef<string | null>(null)

  useEffect(() => {
    // Effects run client-side only, so `document` is always present here.
    if (lastRef.current === documentTitle) return
    lastRef.current = documentTitle
    document.title = documentTitle

    // Only the main window owns the OS title bar. Least-privilege pet windows
    // aren't granted `core:window:allow-set-title` (see
    // `src-tauri/capabilities/pet.json`), so the native write only warns there;
    // the `document.title` write above is harmless and stays.
    if (!isTauri() || !isMainAppWindow()) return
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        await getCurrentWindow().setTitle(title)
      } catch (err) {
        log.warn("window-title set failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }, [title, documentTitle])
}
