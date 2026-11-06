// The pet console's rail: the left list of Settings → Pet's master/detail
// frame, the same `SettingsPanelNav` AI Connections, Terminal and Memory draw.
//
// Two groups. "Your pet" holds the five places (Home, Chat, Shop, Collection,
// Activity) plus Extensions (id `plugins`) while a module or a plugin fills
// `pet.console.tab`. "Setup" holds Appearance & settings, which is a rail
// item like the rest, not a sub-page behind a header button.
//
// The frame (`SettingsMasterDetail`) shrinks the rail to icons on a narrow
// pane and turns it into a sheet on a phone, so this file only says what the
// rows are.
//
// On a paired phone (remote care, ADR-0219) a place that only runs on the
// desktop stays in the list with a small "Desktop" badge, so the reader learns
// it exists and where, instead of the list quietly shrinking.

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
  SlidersHorizontalIcon,
} from "lucide-react"
import {
  SettingsPanelNav,
  type SettingsNavBadge,
  type SettingsNavGroup,
} from "@/components/settings/common/settings-panel-nav"
import type { PetConsoleSection } from "@/lib/pet/console-tabs"

/** A row of the rail: one of the console's sections, or Appearance & settings. */
export type PetConsolePlace = PetConsoleSection | "appearance"

export type PetConsoleNavGroupId = "pet" | "setup"

export const PET_CONSOLE_PLACE_ICONS: Record<
  PetConsolePlace,
  ComponentType<{ className?: string }>
> = {
  home: HomeIcon,
  chat: MessageCircleIcon,
  shop: ShoppingBagIcon,
  collection: LibraryIcon,
  activity: ActivityIcon,
  plugins: PlugIcon,
  appearance: SlidersHorizontalIcon,
}

/** The rail's groups for the sections this console offers, in display order. */
export function petConsoleNavGroups(
  sections: readonly PetConsoleSection[]
): SettingsNavGroup<PetConsolePlace, PetConsoleNavGroupId>[] {
  return [
    {
      id: "pet",
      items: sections.map((id) => ({ id, icon: PET_CONSOLE_PLACE_ICONS[id] })),
    },
    { id: "setup", items: [{ id: "appearance", icon: PET_CONSOLE_PLACE_ICONS.appearance }] },
  ]
}

export interface PetConsoleNavProps {
  /** Sections this console offers (Extensions only while something fills it). */
  sections: readonly PetConsoleSection[]
  activeId: PetConsolePlace
  onSelect: (id: PetConsolePlace) => void
  /** Places a paired phone can only look at: badged, still selectable. */
  desktopOnly?: ReadonlySet<PetConsolePlace>
  /** Test id and shared-layout prefix; the rail and the sheet each pass their own. */
  idPrefix?: string
}

export function PetConsoleNav({
  sections,
  activeId,
  onSelect,
  desktopOnly,
  idPrefix = "pet-console",
}: PetConsoleNavProps) {
  const t = useTranslations("pet.console")
  const badge: SettingsNavBadge = {
    text: t("desktopOnly.badge"),
    variant: "outline",
    ariaLabel: t("desktopOnly.badgeAria"),
  }
  const badges: Partial<Record<PetConsolePlace, SettingsNavBadge>> = {}
  for (const id of desktopOnly ?? []) badges[id] = badge

  return (
    <SettingsPanelNav<PetConsolePlace, PetConsoleNavGroupId>
      groups={petConsoleNavGroups(sections)}
      activeId={activeId}
      onSelect={onSelect}
      badges={badges}
      idPrefix={idPrefix}
      labels={{
        title: t("navigation"),
        group: (groupId) => t(`rail.groups.${groupId}`),
        item: (id) => ({
          label: t(`tabs.${id}`),
          description: t(`rail.descriptions.${id}`),
        }),
      }}
    />
  )
}
