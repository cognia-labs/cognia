"use client"

/**
 * Settings → UI Automation secondary nav. Binds the shared `SettingsPanelNav`
 * to this section's namespace and id space, as `connectivity-nav.tsx` does.
 */

import { useTranslations } from "next-intl"

import {
  SettingsPanelNav,
  type SettingsNavBadge,
} from "@/components/settings/common/settings-panel-nav"

import type { AutomationNavGroup, AutomationNavGroupId, AutomationPanelId } from "./nav-config"

export interface AutomationNavProps {
  groups: readonly AutomationNavGroup[]
  activeId: AutomationPanelId
  onSelect: (id: AutomationPanelId) => void
  badges?: Partial<Record<AutomationPanelId, SettingsNavBadge>>
  idPrefix?: string
}

export function AutomationNav({
  groups,
  activeId,
  onSelect,
  badges,
  idPrefix = "automation",
}: AutomationNavProps) {
  const t = useTranslations("automation.nav")
  return (
    <SettingsPanelNav<AutomationPanelId, AutomationNavGroupId>
      groups={groups}
      activeId={activeId}
      onSelect={onSelect}
      badges={badges}
      idPrefix={idPrefix}
      labels={{
        title: t("title"),
        group: (groupId) => t(`groups.${groupId}`),
        item: (id) => ({
          label: t(`items.${id}.label`),
          description: t(`items.${id}.description`),
        }),
      }}
    />
  )
}
