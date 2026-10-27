// Screen-off Computer Use (ADR-0020 follow-up) — Settings → Automation card.
//
// Reports the selected platform backend, Windows installer and capture probe.
// Rendered by the desktop Behavior panel; macOS exposes the Developer ID beta.

"use client"

import { useState } from "react"

import { MonitorOff, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsBlock } from "@/components/settings/common/settings-block"
import { useVirtualDisplayHealth } from "@/hooks/automation/use-virtual-display-health"
import { desktop, type VirtualDisplayProbeResult } from "@/lib/automation/client"
import { screenOffSupported } from "@/lib/automation/screen-off-support"

export function ScreenOffCard({ platform }: { platform?: string }) {
  const t = useTranslations("automation.screenOff")
  const { health, refresh, error } = useVirtualDisplayHealth()
  const [busy, setBusy] = useState<"setup" | "probe" | null>(null)
  const [probe, setProbe] = useState<VirtualDisplayProbeResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const supported = platform === undefined || screenOffSupported(platform)
  const isMacos = platform === "macos"
  const hasInstaller = platform === undefined || platform === "windows"
  const variant: "ok" | "setup" | "down" =
    error || (health.lastError && (health.installed || isMacos))
      ? "down"
      : health.available
        ? "ok"
        : "setup"

  async function onSetup() {
    setBusy("setup")
    setActionError(null)
    try {
      await desktop.virtualDisplaySetup()
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onProbe() {
    setBusy("probe")
    setActionError(null)
    setProbe(null)
    try {
      const result = await desktop.virtualDisplayProbe()
      setProbe(result)
      await refresh()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsBlock
      icon={<MonitorOff />}
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      settingId="automation-screen-off"
      contentClassName="text-sm"
      badge={
        <Badge
          variant={variant === "ok" ? "default" : variant === "down" ? "destructive" : "secondary"}
          data-testid="screen-off-status-badge"
        >
          {t(`status.${variant}`)}
        </Badge>
      }
    >
      <p className="text-xs text-muted-foreground">{t("howItWorks")}</p>

      {isMacos && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{t("beta")}</Badge>
          <p className="text-xs text-muted-foreground">{t("macosBetaNote")}</p>
        </div>
      )}

      {!supported ? (
        <Alert data-testid="screen-off-unsupported">
          <MonitorOff className="size-4" aria-hidden="true" />
          <AlertDescription>{t("unsupportedNote")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("driverVersion.label")}</dt>
            <dd className="font-mono">{health.driverVersion || "—"}</dd>
            {health.activeMonitor && (
              <>
                <dt className="text-muted-foreground">{t("activeMonitor.label")}</dt>
                <dd className="font-mono">{health.activeMonitor}</dd>
              </>
            )}
            {health.lastError && (
              <>
                <dt className="text-muted-foreground">{t("lastError.label")}</dt>
                <dd className="font-mono text-rose-500">{health.lastError}</dd>
              </>
            )}
            {(error || actionError) && (
              <>
                <dt className="text-muted-foreground">{t("ipcError.label")}</dt>
                <dd className="font-mono text-rose-500">{error ?? actionError}</dd>
              </>
            )}
          </dl>

          {probe && (
            <p
              data-testid="screen-off-probe-result"
              className={probe.nonBlack ? "text-emerald-600" : "text-rose-500"}
            >
              {probe.nonBlack
                ? t("probeOk", {
                    width: probe.width,
                    height: probe.height,
                    monitor: probe.monitor || "—",
                  })
                : t("probeBlack")}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {hasInstaller && !health.installed && (
              <Button
                size="sm"
                onClick={() => void onSetup()}
                disabled={busy !== null}
                data-testid="screen-off-setup-button"
              >
                {busy === "setup" ? t("setupRunning") : t("setupButton")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onProbe()}
              disabled={busy !== null || !health.available}
              data-testid="screen-off-probe-button"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {busy === "probe" ? t("probeRunning") : t("probeButton")}
            </Button>
            {hasInstaller && variant !== "ok" && (
              <p className="text-xs text-muted-foreground">{t("setupNote")}</p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
        </>
      )}
    </SettingsBlock>
  )
}
