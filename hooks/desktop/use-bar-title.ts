"use client"

/**
 * The translated subject of the title bar and the OS window title — the
 * conversation on the chat home, the page's rail label elsewhere, `null` when
 * there is nothing to name beyond the app (`lib/desktop/bar-title.ts`).
 *
 * `followRoute: false` keeps naming the active conversation whatever the
 * route: the auxiliary windows (pet, island, selection toolbar) load their own
 * routes, and those are not pages the user navigated to.
 */

import { useTranslations } from "next-intl"
import { usePathname } from "next/navigation"

import { useActiveSessionLabel } from "@/hooks/chat/use-active-session-label"
import { resolveBarTitle, type BarTitle } from "@/lib/desktop/bar-title"

export interface BarTitleLabel {
  title: BarTitle
  /** What to print after the app name, or `null` for the app name alone. */
  label: string | null
}

export function useBarTitle({ followRoute = true }: { followRoute?: boolean } = {}): BarTitleLabel {
  const tRail = useTranslations("desktop.guildRail")
  const pathname = usePathname() ?? "/"
  const { label: conversation } = useActiveSessionLabel()
  const title = resolveBarTitle(followRoute ? pathname : "/", conversation)
  switch (title.kind) {
    case "conversation":
      return { title, label: title.label }
    case "page":
      return { title, label: tRail(title.i18nKey) }
    case "app":
      return { title, label: null }
  }
}
