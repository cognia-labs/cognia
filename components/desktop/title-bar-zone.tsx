"use client"

/**
 * Renders one zone of the title bar from the user's resolved layout.
 *
 * Counterpart to `status-bar-zone.tsx`. The title bar's segments need a little
 * state that only `TitleBar` has (the app name strings, the command-palette
 * handler, the recent-session list), so the bar passes it down as `ctx` rather
 * than each segment re-deriving it.
 *
 * Not routed through here, because they are structural rather than
 * customizable: the Tauri drag regions, the Windows/Linux menubar, the
 * min/max/close cluster, and the `toolbar.*` plugin extension slots.
 */

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { EllipsisIcon, SparklesIcon } from "lucide-react"

import { AccountBarButton } from "@/components/account/account-bar-button"
import { TitleBarCommandCenterMenu } from "@/components/desktop/title-bar-command-center-menu"
import type { RecentSessionEntry } from "@/hooks/desktop/use-app-menu-controller"
import { TitleBarLayoutControls } from "@/components/desktop/title-bar-layout-controls"
import { TitleBarNavArrows } from "@/components/desktop/title-bar-nav-arrows"
import { TitleBarQuickActions } from "@/components/desktop/title-bar-quick-actions"
import { TitleBarSearchPill } from "@/components/desktop/title-bar-search-pill"
import { TitleBarWorkspace } from "@/components/desktop/title-bar-workspace"
import type { MenuActionId } from "@/lib/desktop/menu-actions"
import type { BarCatalogItem } from "@/lib/shell/bar-items"
import { fitsTier, type TitleBarTier } from "@/lib/desktop/title-bar-density"
import { cn } from "@/lib/utils"
import type { BarZone } from "@/types/shell/bars"

/** Everything a title-bar segment can need from the bar that hosts it. */
export interface TitleBarItemContext {
  appName: string
  separator: string
  searchPlaceholder: string
  recentSessions: RecentSessionEntry[]
  onCommandPalette: () => void
  onOpenRecentSession: (sessionId: string) => void
  onGo: (id: MenuActionId) => void
}

/**
 * Overflow ("…") menu label and test id per region. The centre's carries the
 * navigation segments, which is what it has always been called.
 */
const OVERFLOW = {
  start: { labelKey: "titleBar.moreControls", testId: "title-bar-start-overflow-menu" },
  center: { labelKey: "titleBar.navigationMenu", testId: "title-bar-navigation-menu" },
  end: { labelKey: "titleBar.moreControls", testId: "title-bar-end-overflow-menu" },
} as const

/**
 * One zone, laid out by the bar's width tier (`lib/desktop/title-bar-density.ts`):
 * a segment whose `minWidth` floor the tier does not reach moves into the
 * zone's "…" menu instead of vanishing. `compact` is the chat view's projected
 * mode — search stays on the bar and everything else in the zone folds.
 */
export function TitleBarZone({
  items,
  ctx,
  tier = "wide",
  region = "center",
  compact = false,
}: {
  items: BarCatalogItem[]
  ctx: TitleBarItemContext
  tier?: TitleBarTier
  region?: BarZone
  compact?: boolean
}) {
  const t = useTranslations("desktop")
  const stays = (item: BarCatalogItem) =>
    compact ? item.id === "search" : fitsTier(item.minWidth, tier)
  const visible = items.filter(stays)
  const folded = items.filter((item) => !stays(item))
  const overflow = OVERFLOW[region]
  return (
    <>
      {visible.map((item) => (
        <TitleBarSegment key={item.id} item={item} ctx={ctx} compact={compact} />
      ))}
      {folded.length > 0 && (
        <Popover modal>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label={t(overflow.labelKey)}
              title={t(overflow.labelKey)}
              data-testid={overflow.testId}
            >
              <EllipsisIcon className="size-4" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            collisionPadding={8}
            className="flex max-h-[var(--radix-popover-content-available-height)] w-64 max-w-[calc(100vw-1rem)] flex-col gap-1 overflow-y-auto p-2"
            aria-label={t(overflow.labelKey)}
          >
            {folded.map((item) =>
              item.id === "workspace" ? (
                <div key={item.id} className="min-w-0 empty:hidden">
                  <TitleBarSegment item={item} ctx={ctx} inMenu />
                </div>
              ) : (
                <div
                  key={item.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1"
                >
                  <p className="text-xs text-muted-foreground break-words">
                    {t(`barCustomize.items.${item.i18nKey}`)}
                  </p>
                  <div className="flex min-w-0 flex-wrap items-center gap-1">
                    <TitleBarSegment item={item} ctx={ctx} />
                  </div>
                </div>
              )
            )}
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}

function TitleBarSegment({
  item,
  ctx,
  compact = false,
  inMenu = false,
}: {
  item: BarCatalogItem
  ctx: TitleBarItemContext
  compact?: boolean
  inMenu?: boolean
}) {
  switch (item.id) {
    case "appIcon":
      return (
        <SparklesIcon
          aria-hidden
          data-testid="title-bar-app-icon"
          className="size-4 shrink-0 text-primary"
        />
      )
    case "navArrows":
      return <TitleBarNavArrows className="shrink-0" />
    case "workspace":
      return <TitleBarWorkspace className={inMenu ? "w-full min-w-0" : "shrink-0"} />
    case "search":
      // The pill and the command-centre caret are one control: the caret is
      // the pill's right half (VS Code's command centre), so they render as a
      // group and fold, hide and reorder together.
      return (
        <div
          data-testid="title-bar-command-center"
          className={cn("flex items-center", compact ? "shrink-0" : "min-w-0 max-w-[500px] flex-1")}
        >
          <TitleBarSearchPill
            compact={compact}
            appName={ctx.appName}
            separator={ctx.separator}
            placeholder={ctx.searchPlaceholder}
            onClick={ctx.onCommandPalette}
            className={compact ? undefined : "rounded-r-none"}
          />
          <TitleBarCommandCenterMenu
            compact={compact}
            recentSessions={ctx.recentSessions}
            onCommandPalette={ctx.onCommandPalette}
            onOpenRecentSession={ctx.onOpenRecentSession}
            onGo={ctx.onGo}
          />
        </div>
      )
    case "quickActions":
      return <TitleBarQuickActions />
    case "accountTop":
      return <AccountBarButton className="mx-0.5" />
    case "primarySidebarToggle":
      return <TitleBarLayoutControls controls={["sidebar"]} />
    case "panelToggle":
      return <TitleBarLayoutControls controls={["panel"]} />
    case "secondarySidebarToggle":
      return <TitleBarLayoutControls controls={["rightSidebar"]} />
    case "layoutControls":
      return <TitleBarLayoutControls className="px-1" controls={["customize"]} />
    default:
      // Unreachable for catalog ids — `title-bar-zone.test.tsx` pins that every
      // entry in `TITLE_BAR_ITEMS` has a case above.
      return null
  }
}
