"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Cpu } from "lucide-react"
import { SettingsBlock, SettingsField } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { desktop, type SessionEngineId, type SessionEngineStatus } from "@/lib/automation/client"
import { isTauri } from "@/lib/tauri"

export function SessionEngineCard() {
  const t = useTranslations("automation.sessionEngine")
  const [status, setStatus] = useState<SessionEngineStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [desktopShell, setDesktopShell] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setStatus(await desktop.sessionEngineGet())
      setError(null)
    } catch {
      setError(t("loadError"))
    }
  }, [t])

  useEffect(() => {
    if (!isTauri()) return
    const timer = window.setTimeout(() => {
      setDesktopShell(true)
      void refresh()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])
  if (!desktopShell) return null

  const save = async (engine: SessionEngineId, recoveryToken?: string) => {
    if (!status || busy) return
    setBusy(true)
    setError(null)
    try {
      setStatus(
        await desktop.sessionEngineSet(
          status.revision,
          engine,
          status.configGeneration,
          recoveryToken
        )
      )
    } catch {
      await refresh()
      setError(t("saveError"))
    } finally {
      setBusy(false)
    }
  }
  const probe = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await desktop.sessionEngineProbe())
    } catch {
      setError(t("probeError"))
    } finally {
      setBusy(false)
    }
  }
  const healthText = (health: string) => {
    switch (health) {
      case "ready":
        return t("health.ready")
      case "missing":
        return t("health.missing")
      case "unsupportedPlatform":
        return t("health.unsupportedPlatform")
      case "permissionRequired":
        return t("health.permissionRequired")
      case "configError":
        return t("health.configError")
      case "recovering":
        return t("health.recovering")
      case "quarantined":
        return t("health.quarantined")
      default:
        return t("health.incompatible")
    }
  }

  return (
    <SettingsBlock
      icon={<Cpu />}
      title={t("title")}
      description={t("description")}
      headingLevel={4}
      settingId="automation-session-engine"
    >
      <SettingsField
        htmlFor="automation-session-engine-select"
        label={t("selection")}
        description={t("restartHelp")}
      >
        <Select
          value={status?.desiredEngine ?? "native"}
          disabled={!status || busy || status.configurationError}
          onValueChange={(value) => {
            if (value === "native" || value === "agentDesktop") void save(value)
          }}
        >
          <SelectTrigger id="automation-session-engine-select" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="native">{t("native")}</SelectItem>
            <SelectItem value="agentDesktop" disabled={!status?.agentDesktopAvailable}>
              {t("agentDesktop")}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingsField>
      {status ? (
        <p className="text-xs text-muted-foreground">
          {t("effective", {
            engine: t(status.effectiveEngine === "native" ? "native" : "agentDesktop"),
          })}
        </p>
      ) : null}
      {status?.needsRestart && !status.configurationError ? (
        <p className="text-sm" role="status">
          {t(
            status.reasonCode === "executorLeaseHeld" ||
              status.desiredEngine === status.effectiveEngine
              ? "recoveryRestart"
              : "needsRestart"
          )}
        </p>
      ) : null}
      {status ? (
        <p className="text-xs text-muted-foreground">
          {t("candidateStatus", { status: healthText(status.candidateHealth) })}
        </p>
      ) : null}
      {status && status.health !== "ready" ? (
        <p className="text-sm text-destructive" role="alert">
          {t("activeStatus", { status: healthText(status.health) })}
        </p>
      ) : null}
      {status?.recoveryToken ? (
        <SettingsField
          htmlFor="automation-session-engine-recover"
          label={t("recoveryTitle")}
          description={t("recoveryHelp")}
        >
          <Button
            id="automation-session-engine-recover"
            aria-label={t("recoverNative")}
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void save("native", status.recoveryToken ?? undefined)}
          >
            {t("recoverNative")}
          </Button>
        </SettingsField>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !status?.agentDesktopAvailable}
        onClick={() => void probe()}
      >
        {t("probe")}
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsBlock>
  )
}
