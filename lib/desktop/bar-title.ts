/**
 * What the title bar and the OS window title name: the page in front.
 *
 * Both used to name the active conversation on every route, so on Settings
 * the bar read "Cognia — <last chat>" while the screen showed something else
 * entirely. The conversation is only the subject on the chat home (`/`); any
 * other page is named by its rail label, and a page the rail does not list is
 * named by the app alone.
 *
 * Pure: the hook (`hooks/desktop/use-bar-title.ts`) supplies the pathname and
 * the active conversation's label and translates the result.
 */

import { BUILTIN_NAV_NAMESPACE, navCatalog } from "@/lib/shell/nav-catalog"
import { navItemForPath } from "@/lib/shell/sidebar-nav"

export type BarTitle =
  /**
   * The chat home: its subject is the active conversation, named or not — an
   * untitled one still owns the run indicators. `label` is `null` until it
   * has a title (or while none is open).
   */
  | { kind: "conversation"; label: string | null }
  /** A page the rail lists; `labelKey` is a full i18n key. */
  | { kind: "page"; labelKey: string }
  /** Nothing to name beyond the app. */
  | { kind: "app" }

/** Settings is reached from the rail's footer, not its catalog, but it is a page all the same. */
const SETTINGS_ROUTE = "/settings"

export function resolveBarTitle(pathname: string, conversationLabel: string | null): BarTitle {
  if (pathname === "/" || pathname === "") {
    return { kind: "conversation", label: conversationLabel?.trim() || null }
  }
  if (pathname === SETTINGS_ROUTE || pathname.startsWith(`${SETTINGS_ROUTE}/`)) {
    return { kind: "page", labelKey: `${BUILTIN_NAV_NAMESPACE}.settings` }
  }
  const page = navItemForPath(pathname, navCatalog())
  return page ? { kind: "page", labelKey: page.labelKey } : { kind: "app" }
}
