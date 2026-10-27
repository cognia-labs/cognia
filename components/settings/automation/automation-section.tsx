"use client"

/**
 * Settings → UI Automation.
 *
 * A status strip over a master/detail pane, the same shell as Connectivity:
 *
 *   header + status strip   engine state, OS permissions, engine switch, kill switch
 *   rail                    Overview │ Configure: Permissions, Access rules,
 *                           Behavior │ Monitor: Audit │ Tools: Inspector, Diagnostics
 *   detail                  one panel, its id in `?autoTab=`
 *
 * It replaced a six-tab strip that put the kill switch at the bottom of the
 * first tab, split one permission model across two tabs, and listed the
 * sandbox registry beside the settings. The registry now lives under Devices
 * (the overview links there); see `nav-config.ts` for where old tab ids land.
 *
 * The data plane:
 *   - Settings load once into `AutomationSettingsProvider`; every write is a
 *     serialized read-modify-write so the strip and the panels never overwrite
 *     each other's fields.
 *   - Capabilities, OS permissions and a failed backend init come from
 *     `useAutomationHostStatus`, read once here and handed down.
 *   - The kill switch goes through `desktop.killSwitch()` which engages the
 *     Rust-side gate in <1s.
 *   - Audit rows live in Dexie (table `automationAuditLog`).
 *
 * Panel selection is written to the CURRENT route, not to `/settings`, so a
 * mount on another route is not navigated away on the first click.
 */

import { useCallback } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { MousePointerClickIcon } from "lucide-react"

import { PanelTransition } from "@/components/settings/common/panel-transition"
import {
  SETTINGS_DETAIL_PANE_CLASS,
  SettingsMasterDetail,
} from "@/components/settings/common/settings-master-detail"
import type { SettingsNavBadge } from "@/components/settings/common/settings-panel-nav"
import {
  missingOsPermissions,
  useAutomationHostStatus,
  type AutomationHostStatus,
} from "@/hooks/automation/use-automation-host-status"
import { isTauri } from "@/lib/tauri"

import { AutomationAuditTable } from "./automation-audit-table"
import { AccessRulesTab } from "./access-rules-tab"
import { AutomationNav } from "./automation-nav"
import { AutomationSettingsProvider } from "./automation-settings-context"
import { AutomationStatusStrip } from "./automation-status-strip"
import { AutomationUnavailableNotice } from "./automation-unavailable-notice"
import { InspectorTab } from "./inspector-tab"
import {
  AUTOMATION_NAV_GROUPS,
  AUTOMATION_PANEL_PARAM,
  resolveAutomationPanel,
  type AutomationPanelId,
} from "./nav-config"
import { BehaviorPanel } from "./panels/behavior-panel"
import { DiagnosticsPanel } from "./panels/diagnostics-panel"
import { OverviewPanel } from "./panels/overview-panel"
import { PermissionsPanel } from "./panels/permissions-panel"

export function AutomationSection() {
  const t = useTranslations("automation")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const activePanel = resolveAutomationPanel(searchParams.get(AUTOMATION_PANEL_PARAM))
  const host = useAutomationHostStatus()

  const onSelect = useCallback(
    (id: AutomationPanelId) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(AUTOMATION_PANEL_PARAM, id)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const header = (
    <div className="flex min-w-0 items-start gap-2.5">
      <MousePointerClickIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-0.5">
        <h2 className="text-base font-semibold tracking-tight">{t("header.title")}</h2>
        <p className="text-xs text-pretty text-muted-foreground">{t("header.description")}</p>
      </div>
    </div>
  )

  // Screen, keyboard and mouse control is a capability of the machine being
  // driven: off the desktop shell there is no engine to configure at all.
  if (!isTauri()) {
    return (
      <div className="space-y-4" data-testid="automation-section">
        {header}
        <AutomationUnavailableNotice />
      </div>
    )
  }

  return (
    <AutomationSettingsProvider>
      <div className="flex h-full min-h-0 flex-col gap-4" data-testid="automation-section">
        <div className="space-y-3 border-b border-border/60 pb-4">
          {header}
          <AutomationStatusStrip host={host} onNavigate={onSelect} />
        </div>

        <AutomationPane activePanel={activePanel} host={host} onSelect={onSelect} />
      </div>
    </AutomationSettingsProvider>
  )
}

function AutomationPane({
  activePanel,
  host,
  onSelect,
}: {
  activePanel: AutomationPanelId
  host: AutomationHostStatus
  onSelect: (id: AutomationPanelId) => void
}) {
  const t = useTranslations("automation.nav")
  const missing = missingOsPermissions(host.permissions).length
  const badges: Partial<Record<AutomationPanelId, SettingsNavBadge>> = {}
  if (missing > 0 || host.initFailure) {
    badges.overview = {
      text: "!",
      variant: "destructive",
      ariaLabel: t("attentionBadge"),
    }
  }

  const renderNav = (idPrefix: string) => (
    <AutomationNav
      groups={AUTOMATION_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      badges={badges}
      idPrefix={idPrefix}
    />
  )

  const panel = (() => {
    switch (activePanel) {
      case "overview":
        return <OverviewPanel host={host} onNavigate={onSelect} />
      case "permissions":
        return <PermissionsPanel onNavigate={onSelect} />
      case "accessRules":
        return <AccessRulesTab />
      case "behavior":
        return <BehaviorPanel caps={host.caps} />
      case "audit":
        return <AutomationAuditTable />
      case "inspector":
        return <InspectorTab onOpenPermissions={() => onSelect("permissions")} />
      case "diagnostics":
        return <DiagnosticsPanel host={host} onNavigate={onSelect} />
    }
  })()

  return (
    <SettingsMasterDetail
      nav={(slot) => (slot === "rail" ? renderNav("automation") : renderNav("automation-sheet"))}
      navTitle={t("title")}
      mobileTriggerLabel={t("mobileTrigger")}
      activeKey={activePanel}
      activeLabel={t(`items.${activePanel}.label`)}
      navWidth={240}
      triggerTestId="automation-mobile-nav-trigger"
    >
      <div className={SETTINGS_DETAIL_PANE_CLASS}>
        <section
          aria-labelledby={`automation-panel-${activePanel}`}
          className="min-h-0 flex-1 overflow-y-auto p-4"
          data-testid="automation-panel-body"
          data-panel={activePanel}
        >
          <h3 id={`automation-panel-${activePanel}`} className="mb-3 text-sm font-semibold">
            {t(`items.${activePanel}.label`)}
          </h3>
          <PanelTransition activeKey={activePanel}>{panel}</PanelTransition>
        </section>
      </div>
    </SettingsMasterDetail>
  )
}

export default AutomationSection
