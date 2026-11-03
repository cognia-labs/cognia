// The /pet console's navigation: five places (Home, Chat, Shop, Collection,
// Activity) plus the plugins tab while a plugin fills it, drawn by the page
// header's shared view tabs in its second row, like every other page.
//
// It replaced a ten-tab grouped rail (a strip on a phone, an icon rail on a
// tablet, a labelled rail on a desktop). Five places fit one row at every
// width, so the shape no longer changes with the viewport and the content
// pane gets the full width back.
//
// The console's `<Tabs>` root owns the value and the panels, so the header
// draws only the list (`inOuterRoot`): each trigger still controls its panel
// (`aria-controls`) and the arrow keys move along the row.
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
import type { FeatureHeaderTabs } from "@/components/feature-shell/feature-page-header"
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

/** The places as the header's view tabs, inside the console's own Tabs root. */
export function usePetConsoleTabs({
  sections,
  desktopOnlySections,
  value,
}: {
  /** Sections this console offers (the plugins tab only while a plugin fills it). */
  sections: readonly PetConsoleSection[]
  /** Sections a paired phone can only look at: badged, still selectable. */
  desktopOnlySections?: ReadonlySet<PetConsoleSection>
  /** The console root's current section. */
  value: PetConsoleSection
}): FeatureHeaderTabs {
  const t = useTranslations("pet")
  const badge = t("console.desktopOnly.badge")
  return {
    ariaLabel: t("console.navigation"),
    value,
    inOuterRoot: true,
    testId: "pet-console-nav",
    items: sections.map((id) => ({
      value: id,
      label: t(`console.tabs.${id}`),
      icon: PET_CONSOLE_SECTION_ICONS[id] as FeatureHeaderTabs["items"][number]["icon"],
      ...(desktopOnlySections?.has(id) ? { badge } : {}),
    })),
  }
}
