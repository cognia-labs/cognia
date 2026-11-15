/**
 * Pure (icon-free) catalog of the phone's shortcuts (the quick module's
 * content, ADR-0225 §9).
 *
 * Mirrors `@/types/shell/sidebar`: kept free of React / lucide so
 * `AppSettings` and the persistence layer can import it without pulling the
 * icon set into their module graph. The icon mapping + resolver live in
 * `lib/shell/mobile-home-nav.ts`; the layout that holds the shortcut list is
 * `GlanceMobileSettings` (`@/types/glance/layout`).
 */

/** How a quick action behaves when tapped. */
export type MobileQuickActionKind = "newChat" | "search" | "route"

/** A customizable quick action on the mobile home welcome grid. */
export interface MobileQuickActionMeta {
  /** Stable key — persisted in `GlanceMobileSettings.shortcuts`, also the i18n key suffix. */
  id: string
  /** Tap behaviour. `route` navigates to `route`; the others fire a callback. */
  kind: MobileQuickActionKind
  /** Destination route for `kind: "route"`. */
  route?: string
  /** i18n key under `mobile.home.actions.*`. */
  i18nKey: string
}

/**
 * The full shortcut catalog, in canonical order. Shortcuts not in the stored
 * list surface in the editor's "available" pool, so a future catalog addition
 * is opt-in (never auto-shown in the grid).
 */
export const MOBILE_QUICK_ACTION_CATALOG: readonly MobileQuickActionMeta[] = [
  { id: "newChat", kind: "newChat", i18nKey: "newChat" },
  { id: "search", kind: "search", i18nKey: "search" },
  { id: "workflows", kind: "route", route: "/workflows", i18nKey: "workflows" },
  { id: "discover", kind: "route", route: "/discover", i18nKey: "discover" },
  { id: "inbox", kind: "route", route: "/inbox", i18nKey: "inbox" },
  { id: "twin", kind: "route", route: "/twin", i18nKey: "twin" },
  // `/templates` shipped a full phone body (`TemplatesMobileBody`) that nothing
  // on a phone linked to: not a quick action, not a `/me` row, not a tab-bar
  // prefix. Reachable only by typing the URL is the same as unreachable.
  { id: "templates", kind: "route", route: "/templates", i18nKey: "templates" },
  { id: "fleet", kind: "route", route: "/fleet", i18nKey: "fleet" },
  { id: "servers", kind: "route", route: "/servers", i18nKey: "servers" },
  { id: "devices", kind: "route", route: "/devices", i18nKey: "devices" },
  { id: "me", kind: "route", route: "/me", i18nKey: "me" },
] as const
