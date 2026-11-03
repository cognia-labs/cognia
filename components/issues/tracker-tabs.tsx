"use client"

/**
 * The tracker's three destinations as one segmented strip (spec 2026-09-06,
 * D7): Issues, Projects, Cycles. The same component renders in the desktop
 * header of every tracker route and at the top of every compact body, so
 * moving between the board, its containers and its cycles never reads as
 * leaving one feature for another.
 *
 * Links, not tabs: each destination is its own URL (`/issues`, `/projects`,
 * `/projects?tab=cycles`), which keeps deep links, back navigation and the
 * static export honest. `aria-current` marks where you already are.
 *
 * Two renderings of the one destination list: `TrackerTabs`, the segmented
 * strip the compact bodies draw, and `useTrackerHeaderTabs`, the same three
 * links as `FeaturePageHeader` route tabs for the desktop consoles.
 */

import { CircleDotIcon, FolderKanbanIcon, RotateCwIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"

import type { FeatureHeaderTabs } from "@/components/feature-shell/feature-page-header"
import { cn } from "@/lib/utils"

export type TrackerDestination = "issues" | "projects" | "cycles"

export const TRACKER_DESTINATIONS = [
  { id: "issues", href: "/issues", icon: CircleDotIcon, labelKey: "title" },
  { id: "projects", href: "/projects", icon: FolderKanbanIcon, labelKey: "projects.title" },
  { id: "cycles", href: "/projects?tab=cycles", icon: RotateCwIcon, labelKey: "cycles.title" },
] as const satisfies readonly {
  id: TrackerDestination
  href: string
  icon: typeof CircleDotIcon
  labelKey: string
}[]

export interface TrackerTabsProps {
  active: TrackerDestination
  /** Full-width equal segments for a phone or a narrow window. */
  compact?: boolean
  className?: string
}

export function TrackerTabs({ active, compact, className }: TrackerTabsProps) {
  const t = useTranslations("issues")

  return (
    <nav
      aria-label={t("rail.trackerNav")}
      data-testid="tracker-nav"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5",
        compact && "flex w-full",
        className
      )}
    >
      {TRACKER_DESTINATIONS.map((destination) => {
        const Icon = destination.icon
        const current = destination.id === active
        return (
          <Link
            key={destination.id}
            href={destination.href}
            aria-current={current ? "page" : undefined}
            data-testid={`tracker-nav-${destination.id}`}
            className={cn(
              "focus-visible:ring-ring/50 inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px]",
              compact && "flex-1",
              current
                ? "bg-background text-foreground shadow-(--elevation-1)"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{t(destination.labelKey)}</span>
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * The tracker's destinations as the page header's route tabs: one link per
 * destination, the current route as the value, no `onValueChange` (the links
 * do the switching). Same ids, hrefs, labels and test ids as `TrackerTabs`.
 */
export function useTrackerHeaderTabs(active: TrackerDestination): FeatureHeaderTabs {
  const t = useTranslations("issues")
  return {
    ariaLabel: t("rail.trackerNav"),
    value: active,
    testId: "tracker-nav",
    items: TRACKER_DESTINATIONS.map((destination) => ({
      value: destination.id,
      label: t(destination.labelKey),
      icon: destination.icon,
      href: destination.href,
      testId: `tracker-nav-${destination.id}`,
    })),
  }
}
