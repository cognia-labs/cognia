"use client"

/**
 * UI Automation → Diagnostics: the machine-side facts behind a call that will
 * not work — which OS permissions are granted, what the backend can do, whether
 * it started, and the screen-off driver's health.
 *
 * Read-only apart from the remedies each row names (open the OS pane, probe
 * again). Configuration stays in the Configure panels; the screen-off setup and
 * probe buttons live with the rest of the screen-off block under Behavior.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowRightIcon, CpuIcon, KeyRoundIcon, MonitorOffIcon, RefreshCwIcon } from "lucide-react"

import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  applicableOsPermissions,
  type AutomationHostStatus,
  type AutomationOsPermissionKey,
} from "@/hooks/automation/use-automation-host-status"
import { useVirtualDisplayHealth } from "@/hooks/automation/use-virtual-display-health"
import { screenOffSupported } from "@/lib/automation/screen-off-support"
import type { ProbeState } from "@/lib/skills/recording/types"
import { repairSelectionToolbarPermission } from "@/lib/tauri/selection-toolbar"

import type { AutomationPanelId } from "../nav-config"
import { PlatformCapabilitiesCard } from "../platform-capabilities-card"

const PROBE_BADGE: Record<ProbeState, "secondary" | "destructive" | "outline"> = {
  ok: "secondary",
  missing: "destructive",
  unknown: "outline",
  notApplicable: "outline",
}

/** Only these two have a System Settings pane the host knows how to open. */
const SYSTEM_SETTINGS_PANE: Partial<
  Record<AutomationOsPermissionKey, "accessibility" | "screenRecording">
> = {
  accessibility: "accessibility",
  screenRecording: "screenRecording",
}

export interface DiagnosticsPanelProps {
  host: AutomationHostStatus
  onNavigate: (panel: AutomationPanelId) => void
}

export function DiagnosticsPanel({ host, onNavigate }: DiagnosticsPanelProps) {
  const t = useTranslations("automation.diagnostics")
  const platform = host.caps?.platform

  return (
    <SettingsStack>
      <OsPermissionsBlock host={host} />
      {host.caps === undefined ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <PlatformCapabilitiesCard caps={host.caps} />
      )}
      <SettingsBlock
        icon={<CpuIcon />}
        title={t("backend.title")}
        description={t("backend.description")}
        headingLevel={4}
        badge={
          <Badge variant={host.initFailure ? "destructive" : "secondary"}>
            {host.initFailure ? t("backend.failed") : t("backend.ok")}
          </Badge>
        }
        testid="automation-backend-status"
      >
        {host.initFailure ? (
          <Alert variant="destructive">
            <AlertTitle>
              {t("backend.failedTitle", { platform: host.initFailure.platform })}
            </AlertTitle>
            <AlertDescription className="font-mono text-xs break-all">
              {host.initFailure.error}
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-xs text-muted-foreground">{t("backend.okDetail")}</p>
        )}
      </SettingsBlock>
      {screenOffSupported(platform) ? (
        <ScreenOffHealthBlock onOpen={() => onNavigate("behavior")} />
      ) : null}
    </SettingsStack>
  )
}

function OsPermissionsBlock({ host }: { host: AutomationHostStatus }) {
  const t = useTranslations("automation.diagnostics.permissions")
  const tPermission = useTranslations("automation.osPermissions")
  const tState = useTranslations("automation.diagnostics.permissions.state")
  const [rechecking, setRechecking] = useState(false)
  const applicable = applicableOsPermissions(host.permissions)

  const recheck = async () => {
    setRechecking(true)
    try {
      await host.refreshPermissions()
    } finally {
      setRechecking(false)
    }
  }

  return (
    <SettingsBlock
      icon={<KeyRoundIcon />}
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      action={
        <Button variant="ghost" size="sm" onClick={() => void recheck()} disabled={rechecking}>
          <RefreshCwIcon aria-hidden className="size-4" />
          {t("recheck")}
        </Button>
      }
      testid="automation-os-permissions"
    >
      {host.permissions === undefined ? (
        <Skeleton className="h-12 w-full" />
      ) : host.permissions === null ? (
        <p className="text-xs text-destructive">{t("probeFailed")}</p>
      ) : applicable.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noneRequired")}</p>
      ) : (
        applicable.map((key) => {
          const state = host.permissions![key]
          const pane = SYSTEM_SETTINGS_PANE[key]
          return (
            <SettingsField
              key={key}
              label={tPermission(key)}
              description={t(`hint.${key}`)}
              testid={`automation-os-permission-${key}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={PROBE_BADGE[state]}>{tState(state)}</Badge>
                {state === "missing" && pane ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void repairSelectionToolbarPermission(pane)}
                  >
                    {t("openSystemSettings")}
                  </Button>
                ) : null}
              </div>
            </SettingsField>
          )
        })
      )}
    </SettingsBlock>
  )
}

function ScreenOffHealthBlock({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations("automation.diagnostics.screenOff")
  const tStatus = useTranslations("automation.screenOff.status")
  const { health, error } = useVirtualDisplayHealth()
  const variant: "ok" | "setup" | "down" =
    error || (health.lastError && (health.installed || health.backend !== "windows-parsec-vdd"))
      ? "down"
      : health.available
        ? "ok"
        : "setup"

  return (
    <SettingsBlock
      icon={<MonitorOffIcon />}
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      badge={
        <Badge
          variant={variant === "ok" ? "secondary" : variant === "down" ? "destructive" : "outline"}
        >
          {tStatus(variant)}
        </Badge>
      }
      action={
        <Button variant="ghost" size="sm" onClick={onOpen}>
          {t("open")}
          <ArrowRightIcon aria-hidden className="size-4" />
        </Button>
      }
      testid="automation-screen-off-health"
    >
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs @md/settings-stack:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t("backend")}</dt>
        <dd className="font-mono">{health.backend || "—"}</dd>
        {health.lastError || error ? (
          <>
            <dt className="text-muted-foreground">{t("lastError")}</dt>
            <dd className="font-mono break-all text-destructive">{error ?? health.lastError}</dd>
          </>
        ) : null}
      </dl>
    </SettingsBlock>
  )
}
