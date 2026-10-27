/**
 * Panels of the Settings → UI Automation master/detail pane.
 *
 * Replaces a six-tab strip whose tabs mixed three kinds of thing: settings
 * (permissions, access rules, behaviour), a log (audit) and two tools (the
 * Inspector and the sandbox registry). The rail groups them by what the user
 * came to do — configure, look back, debug — and the sandbox registry left
 * for the Devices console, which already mounts it.
 *
 * Mirrors `../connectivity/nav-config.ts` so the sections share a shell.
 */

import {
  ActivityIcon,
  ListChecksIcon,
  ScrollTextIcon,
  SearchCheckIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  StethoscopeIcon,
} from "lucide-react"

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"
import type {
  SettingsNavGroup,
  SettingsNavItem,
} from "@/components/settings/common/settings-panel-nav"

export type AutomationPanelId =
  "overview" | "permissions" | "accessRules" | "behavior" | "audit" | "inspector" | "diagnostics"

export type AutomationNavGroupId = "statusGroup" | "configGroup" | "monitorGroup" | "toolsGroup"

export type AutomationNavItem = SettingsNavItem<AutomationPanelId>

export type AutomationNavGroup = SettingsNavGroup<AutomationPanelId, AutomationNavGroupId>

export const AUTOMATION_NAV_GROUPS: readonly AutomationNavGroup[] = [
  {
    id: "statusGroup",
    items: [{ id: "overview", icon: ActivityIcon }],
  },
  {
    id: "configGroup",
    items: [
      { id: "permissions", icon: ShieldCheckIcon },
      { id: "accessRules", icon: ListChecksIcon },
      { id: "behavior", icon: SlidersHorizontalIcon },
    ],
  },
  {
    id: "monitorGroup",
    items: [{ id: "audit", icon: ScrollTextIcon }],
  },
  {
    id: "toolsGroup",
    items: [
      { id: "inspector", icon: SearchCheckIcon },
      { id: "diagnostics", icon: StethoscopeIcon },
    ],
  },
]

export const AUTOMATION_NAV_ITEMS: readonly AutomationNavItem[] = AUTOMATION_NAV_GROUPS.flatMap(
  (group) => group.items
)

const PANEL_IDS = panelIdSet(AUTOMATION_NAV_ITEMS)

/**
 * Kept from the tab strip so a bookmarked `?autoTab=` still lands somewhere
 * sensible instead of resetting to the overview.
 */
export const AUTOMATION_PANEL_PARAM = "autoTab"

export const DEFAULT_AUTOMATION_PANEL: AutomationPanelId = "overview"

/**
 * Ids the tab strip used that no longer name a panel. `whitelist` predates the
 * merge of the whitelist and the sandbox automation policy into Access rules;
 * `sandboxes` is the registry that moved to Devices → Runtime, whose entry
 * point is a block on the overview.
 */
const LEGACY_PANEL_IDS: Readonly<Record<string, AutomationPanelId>> = {
  whitelist: "accessRules",
  sandboxes: "overview",
}

/** Narrow an untrusted deep-link value, falling back to the overview panel. */
export function resolveAutomationPanel(raw: string | null | undefined): AutomationPanelId {
  if (raw && Object.hasOwn(LEGACY_PANEL_IDS, raw)) return LEGACY_PANEL_IDS[raw]
  return resolvePanelId(raw, PANEL_IDS, DEFAULT_AUTOMATION_PANEL)
}
