// The /pet console's navigation: five places (Home, Chat, Shop, Collection,
// Activity) plus the plugins tab while a plugin fills it, as one Radix tablist
// in the page header's second row, the way `/conversations` lays out its tabs.
//
// It replaced a ten-tab grouped rail (a strip on a phone, an icon rail on a
// tablet, a labelled rail on a desktop). Five places fit one row at every
// width, so the shape no longer changes with the viewport and the content
// pane gets the full width back.
//
// It renders inside the console's `<Tabs>` root, which owns the value, so each
// trigger controls its panel (`aria-controls`) and the arrow keys move along
// the row.
//
// On a paired phone (remote care, ADR-0219) a tab that only runs on the
// desktop stays in the list with a small "Desktop" badge, so the reader learns
// it exists and where, instead of the nav quietly shrinking.

"use client"

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  HomeIcon,
  LibraryIcon,
  MessageCircleIcon,
  PlugIcon,
  ShoppingBagIcon,
} from "lucide-react"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { PetConsoleSection } from "@/lib/pet/console-tabs"

export const PET_CONSOLE_SECTION_ICONS: Record<
  PetConsoleSection,
  ComponentType<{ className?: string }>
> = {
  home: HomeIcon,
  chat: MessageCircleIcon,
  shop: ShoppingBagIcon,
  collection: LibraryIcon,
  activity: ActivityIcon,
  plugins: PlugIcon,
}

export interface PetConsoleNavProps {
  /** Sections this console offers (the plugins tab only while a plugin fills it). */
  sections: readonly PetConsoleSection[]
  /** Sections that only run on the desktop in this mode; badged, still selectable. */
  desktopOnlySections?: ReadonlySet<PetConsoleSection>
  className?: string
}

export function PetConsoleNav({ sections, desktopOnlySections, className }: PetConsoleNavProps) {
  const t = useTranslations("pet")
  const badge = t("console.desktopOnly.badge")

  return (
    <TabsList
      data-testid="pet-console-nav"
      aria-label={t("console.navigation")}
      className={cn("h-8", className)}
    >
      {sections.map((id) => {
        const Icon = PET_CONSOLE_SECTION_ICONS[id]
        const desktopOnly = desktopOnlySections?.has(id) === true
        return (
          <TabsTrigger
            key={id}
            value={id}
            data-tab={id}
            data-desktop-only={desktopOnly || undefined}
            className="gap-1.5 px-2.5 @md/feature-header:px-3"
          >
            <Icon className="size-3.5" aria-hidden />
            <span>{t(`console.tabs.${id}`)}</span>
            {desktopOnly ? (
              <span
                data-testid="pet-console-desktop-badge"
                className="rounded-sm bg-muted px-1 py-px text-[10px] leading-none font-medium text-muted-foreground"
              >
                {badge}
              </span>
            ) : null}
          </TabsTrigger>
        )
      })}
    </TabsList>
  )
}
