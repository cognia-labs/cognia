"use client"

/**
 * The row above the UI Automation rail: is the engine running, does the OS let
 * it, and the way to stop it.
 *
 * It sits outside the panels on purpose. The kill switch used to live at the
 * bottom of the Overview tab, below four other cards, so stopping a runaway
 * session meant finding the right tab and scrolling. Here it is one click from
 * every panel, and deliberately without a confirmation step: an emergency stop
 * that asks "are you sure?" is a slower emergency stop.
 */

import { useTranslations } from "next-intl"
import { CircleIcon, OctagonXIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  missingOsPermissions,
  type AutomationHostStatus,
} from "@/hooks/automation/use-automation-host-status"
import { cn } from "@/lib/utils"

import { useAutomationSettings } from "./automation-settings-context"
import type { AutomationPanelId } from "./nav-config"

export type EngineState = "running" | "off" | "stopped"

/** `stopped` is the kill switch: off, and off because someone pulled the cord. */
export function engineStateOf(enabled: boolean, killSwitchEngaged: boolean): EngineState {
  if (killSwitchEngaged) return "stopped"
  return enabled ? "running" : "off"
}

const ENGINE_TONE: Record<EngineState, string> = {
  running: "fill-emerald-500 text-emerald-500",
  off: "fill-muted-foreground/40 text-muted-foreground/40",
  stopped: "fill-destructive text-destructive",
}

export interface AutomationStatusStripProps {
  host: Pick<AutomationHostStatus, "permissions">
  onNavigate: (panel: AutomationPanelId) => void
}

export function AutomationStatusStrip({ host, onNavigate }: AutomationStatusStripProps) {
  const t = useTranslations("automation.status")
  const { settings, loading, saving, killSwitchEngaged, setEnabled, engageKillSwitch } =
    useAutomationSettings()

  if (loading || !settings) {
    return <Skeleton className="h-12 w-full" data-testid="automation-status-loading" />
  }

  const engine = engineStateOf(settings.enabled, killSwitchEngaged)
  const missing = missingOsPermissions(host.permissions)

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2"
      data-testid="automation-status-strip"
      data-engine={engine}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <CircleIcon aria-hidden className={cn("size-2.5 shrink-0", ENGINE_TONE[engine])} />
          <div className="min-w-0">
            <p className="text-sm font-medium" data-testid="automation-engine-state">
              {t(`engine.${engine}`)}
            </p>
            <p className="text-xs text-pretty text-muted-foreground">{t(`engineHint.${engine}`)}</p>
          </div>
        </div>

        {host.permissions === undefined ? null : missing.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto gap-1.5 px-1.5 py-1 text-amber-700 dark:text-amber-400"
            onClick={() => onNavigate("overview")}
            data-testid="automation-permissions-missing"
          >
            <ShieldAlertIcon aria-hidden className="size-4" />
            {t("permissionsMissing", { count: missing.length })}
          </Button>
        ) : host.permissions ? (
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="automation-permissions-ready"
          >
            <ShieldCheckIcon
              aria-hidden
              className="size-4 text-emerald-600 dark:text-emerald-400"
            />
            {t("permissionsReady")}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="automation-enabled" className="text-sm">
            {t("engineToggle")}
          </Label>
          <Switch
            id="automation-enabled"
            // Off while the kill switch holds, even if the persisted flag says
            // on: switching it on is the deliberate resume that releases it.
            checked={engine === "running"}
            onCheckedChange={(next) => void setEnabled(next)}
            disabled={saving}
          />
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void engageKillSwitch()}
          disabled={engine !== "running"}
          title={t("killSwitchHint")}
          data-testid="automation-kill-switch"
        >
          <OctagonXIcon aria-hidden className="size-4" />
          {t("killSwitch")}
        </Button>
      </div>
    </div>
  )
}
