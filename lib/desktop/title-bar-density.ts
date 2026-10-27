/**
 * How much of the title bar fits: one width table, one tier, one rule.
 *
 * The bar used to fold by four unrelated rules — a 760px media query for the
 * Windows/Linux menubar, a measured 1024px for the chat view's navigation,
 * Tailwind `lg:` / `xl:` viewport classes on individual segments, and the
 * conversation rail's projection — and a segment that did not fit simply
 * vanished. Now every decision reads the tier below, and a segment that does
 * not fit its tier moves into its zone's "…" menu instead of disappearing.
 *
 * The bar spans the whole window, so the viewport width *is* the bar width;
 * `hooks/desktop/use-title-bar-tier.ts` reads it through media queries built
 * from {@link TITLE_BAR_TIER_QUERIES}.
 */

import type { BarItemMinWidth } from "@/types/shell/bars"

/** Narrowest first. */
export type TitleBarTier = "compact" | "medium" | "regular" | "wide"

const TIER_RANK: Record<TitleBarTier, number> = { compact: 0, medium: 1, regular: 2, wide: 3 }

/**
 * The widest window each tier below `wide` covers, in CSS px (inclusive). 760
 * is where the menubar has always folded; 1024 / 1280 are the Tailwind `lg` /
 * `xl` floors the segments' `minWidth` names.
 */
export const TITLE_BAR_TIER_MAX_PX = {
  compact: 760,
  medium: 1023.98,
  regular: 1279.98,
} as const

/** Media queries for the tiers below `wide`, narrowest first. */
export const TITLE_BAR_TIER_QUERIES: readonly (readonly [TitleBarTier, string])[] = (
  ["compact", "medium", "regular"] as const
).map((tier) => [tier, `(max-width: ${TITLE_BAR_TIER_MAX_PX[tier]}px)`] as const)

/** The tier for a window `widthPx` wide. */
export function tierForWidth(widthPx: number): TitleBarTier {
  if (widthPx <= TITLE_BAR_TIER_MAX_PX.compact) return "compact"
  if (widthPx <= TITLE_BAR_TIER_MAX_PX.medium) return "medium"
  if (widthPx <= TITLE_BAR_TIER_MAX_PX.regular) return "regular"
  return "wide"
}

/** The tier a segment's `minWidth` floor needs. */
const FLOOR_TIER: Record<BarItemMinWidth, TitleBarTier> = { lg: "regular", xl: "wide" }

/** Whether a segment with this floor fits in the bar at `tier`. */
export function fitsTier(minWidth: BarItemMinWidth | undefined, tier: TitleBarTier): boolean {
  return !minWidth || TIER_RANK[tier] >= TIER_RANK[FLOOR_TIER[minWidth]]
}

/**
 * The Windows/Linux menubar folds into the hamburger on a compact window, and
 * whenever the conversation rail's header occupies the leading stretch of the
 * bar (the menus would otherwise sit over that column).
 */
export function menubarFolds(tier: TitleBarTier, railHeaderProjected: boolean): boolean {
  return tier === "compact" || railHeaderProjected
}

/**
 * Beside a projected chat header, the bar's navigation (history, workspace)
 * folds into its "…" menu below the `lg` floor, leaving search alone.
 */
export function navigationFolds(tier: TitleBarTier): boolean {
  return TIER_RANK[tier] < TIER_RANK.regular
}
