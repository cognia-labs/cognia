"use client"

/**
 * Guided setup & health wizard for Personal Assistant data sources (`F7`):
 *  - Lark Calendar & Tasks (`lark-cli` built-in capability probe)
 *  - Gmail, Google Calendar, and Outlook / Microsoft 365 (stdio MCP presets
 *    backed by OS keyring secret storage and ADR-0239 outbound governance)
 */

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  probeAllPersonalDataSources,
  probePersonalDataSource,
  type PersonalDataSourceHealth,
  type PersonalDataSourceStatus,
} from "@/lib/integrations/personal-sources/health-probe"
import {
  PERSONAL_DATA_SOURCE_PRESETS,
  findPersonalSourceMcpServer,
  parseCommandArgsLine,
  setPersonalSourceEnabled,
  upsertPersonalSourceMcpServer,
  type PersonalDataSourceId,
  type PersonalDataSourcePreset,
} from "@/lib/integrations/personal-sources/presets"

export interface PersonalSourcesTabProps {
  hostAvailable?: boolean
}

function statusBadgeVariant(
  status: PersonalDataSourceStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "ready":
      return "secondary"
    case "reauth_required":
      return "destructive"
    case "disabled":
    case "unconfigured":
    case "desktop_required":
      return "outline"
  }
}

interface McpDraftState {
  command: string
  argsLine: string
  secretValue: string
  enabled: boolean
}

export function PersonalSourcesTab({ hostAvailable = true }: PersonalSourcesTabProps) {
  const t = useTranslations("settings.connections.personalSources")
  const [healthMap, setHealthMap] = useState<
    Partial<Record<PersonalDataSourceId, PersonalDataSourceHealth>>
  >({})
  const [probingId, setProbingId] = useState<PersonalDataSourceId | "all" | null>(null)
  const [savingId, setSavingId] = useState<PersonalDataSourceId | null>(null)
  const [drafts, setDrafts] = useState<
    Record<Exclude<PersonalDataSourceId, "lark">, McpDraftState>
  >(() => ({
    gmail: {
      command: "npx",
      argsLine: "-y @gongrzhe/server-gmail-autoauth-mcp",
      secretValue: "",
      enabled: true,
    },
    "google-calendar": {
      command: "npx",
      argsLine: "-y @cocal/google-calendar-mcp",
      secretValue: "",
      enabled: true,
    },
    outlook: {
      command: "npx",
      argsLine: "-y @softeria/ms-365-mcp-server",
      secretValue: "",
      enabled: true,
    },
  }))

  const refreshAll = useCallback(async () => {
    setProbingId("all")
    try {
      const results = await probeAllPersonalDataSources({ hostAvailable })
      setHealthMap(results)

      const mcpIds: Array<Exclude<PersonalDataSourceId, "lark">> = [
        "gmail",
        "google-calendar",
        "outlook",
      ]
      const existingServers = await Promise.all(
        mcpIds.map((id) => findPersonalSourceMcpServer(id).catch(() => undefined))
      )
      setDrafts((prev) => {
        const next = { ...prev }
        mcpIds.forEach((id, idx) => {
          const row = existingServers[idx]
          if (!row) return
          const cfg = row.config as { command?: string; args?: unknown[] }
          const argsStr = Array.isArray(cfg.args)
            ? cfg.args.filter((a): a is string => typeof a === "string").join(" ")
            : prev[id].argsLine
          next[id] = {
            command:
              typeof cfg.command === "string" && cfg.command ? cfg.command : prev[id].command,
            argsLine: argsStr,
            secretValue: "",
            enabled: row.enabled,
          }
        })
        return next
      })
    } finally {
      setProbingId(null)
    }
  }, [hostAvailable])

  useEffect(() => {
    let cancelled = false
    const mcpIds: Array<Exclude<PersonalDataSourceId, "lark">> = [
      "gmail",
      "google-calendar",
      "outlook",
    ]
    void Promise.all([
      probeAllPersonalDataSources({ hostAvailable }),
      Promise.all(mcpIds.map((id) => findPersonalSourceMcpServer(id).catch(() => undefined))),
    ]).then(([results, existingServers]) => {
      if (cancelled) return
      setHealthMap(results)
      setDrafts((prev) => {
        const next = { ...prev }
        mcpIds.forEach((id, idx) => {
          const row = existingServers[idx]
          if (!row) return
          const cfg = row.config as { command?: string; args?: unknown[] }
          const argsStr = Array.isArray(cfg.args)
            ? cfg.args.filter((a): a is string => typeof a === "string").join(" ")
            : prev[id].argsLine
          next[id] = {
            command:
              typeof cfg.command === "string" && cfg.command ? cfg.command : prev[id].command,
            argsLine: argsStr,
            secretValue: "",
            enabled: row.enabled,
          }
        })
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [hostAvailable])

  const handleProbeOne = async (id: PersonalDataSourceId) => {
    setProbingId(id)
    try {
      const res = await probePersonalDataSource(id, { hostAvailable })
      setHealthMap((prev) => ({ ...prev, [id]: res }))
    } finally {
      setProbingId(null)
    }
  }

  const handleSaveMcpSource = async (preset: PersonalDataSourcePreset) => {
    if (preset.id === "lark") return
    const id = preset.id
    const draft = drafts[id]
    setSavingId(id)
    try {
      await upsertPersonalSourceMcpServer({
        sourceId: id,
        displayName: t(`sources.${id}.title`),
        command: draft.command,
        args: parseCommandArgsLine(draft.argsLine),
        secretValue: draft.secretValue,
        enabled: draft.enabled,
      })
      setDrafts((prev) => ({
        ...prev,
        [id]: { ...prev[id], secretValue: "" },
      }))
      const probed = await probePersonalDataSource(id, { hostAvailable })
      setHealthMap((prev) => ({ ...prev, [id]: probed }))
      toast.success(t("toasts.saved", { name: t(`sources.${id}.title`) }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toasts.saveFailed"))
    } finally {
      setSavingId(null)
    }
  }

  const handleToggleEnabled = async (
    id: Exclude<PersonalDataSourceId, "lark">,
    enabled: boolean
  ) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], enabled } }))
    const updated = await setPersonalSourceEnabled(id, enabled).catch(() => false)
    if (updated) {
      const probed = await probePersonalDataSource(id, { hostAvailable })
      setHealthMap((prev) => ({ ...prev, [id]: probed }))
    }
  }

  return (
    <div className="space-y-4" data-testid="personal-sources-tab">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p className="text-xs text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!hostAvailable || probingId !== null}
          onClick={() => void refreshAll()}
          data-testid="personal-sources-probe-all"
        >
          {probingId === "all" ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCwIcon className="mr-1.5 size-3.5" aria-hidden />
          )}
          {t("probeAll")}
        </Button>
      </div>

      {!hostAvailable ? (
        <Alert data-testid="personal-sources-host-required">
          <ShieldAlertIcon className="size-4" aria-hidden />
          <AlertDescription className="text-xs">{t("hostRequiredNotice")}</AlertDescription>
        </Alert>
      ) : null}

      <Alert>
        <CheckCircle2Icon className="size-4" aria-hidden />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>{t("outboundGovernanceHint")}</span>
          <Link
            href="?section=connections&connectionsTab=outbound"
            className="font-medium underline underline-offset-2"
            data-testid="personal-sources-outbound-link"
          >
            {t("openOutboundPolicy")}
          </Link>
        </AlertDescription>
      </Alert>

      <div className="grid gap-3 md:grid-cols-2">
        {PERSONAL_DATA_SOURCE_PRESETS.map((preset) => {
          const id = preset.id
          const health = healthMap[id]
          const status: PersonalDataSourceStatus =
            health?.status ?? (hostAvailable ? "unconfigured" : "desktop_required")
          const isMcp = preset.kind === "mcp-stdio" && id !== "lark"
          const mcpDraft = id !== "lark" ? drafts[id] : undefined

          return (
            <div
              key={id}
              className="flex flex-col justify-between gap-3 rounded-lg border bg-card p-4"
              data-testid={`personal-source-card-${id}`}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-medium">{t(`sources.${id}.title`)}</h4>
                      <Badge
                        variant={statusBadgeVariant(status)}
                        className="text-[11px]"
                        data-testid={`personal-source-status-${id}`}
                        data-status={status}
                      >
                        {t(`status.${status}`)}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t(`sources.${id}.description`)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={!hostAvailable || probingId !== null}
                    onClick={() => void handleProbeOne(id)}
                    data-testid={`personal-source-probe-${id}`}
                  >
                    {probingId === id ? (
                      <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      t("verifyAction")
                    )}
                  </Button>
                </div>

                {health?.detectedVersion ? (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {t("detectedVersion", { version: health.detectedVersion })}
                  </p>
                ) : null}
                {health?.detail && status !== "ready" ? (
                  <p className="rounded bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {health.detail}
                  </p>
                ) : null}

                {id === "lark" ? (
                  <div className="space-y-2 rounded-md border bg-muted/20 p-2.5 text-xs">
                    <p className="text-muted-foreground">{t("larkSetupHint")}</p>
                    <code className="block rounded bg-background px-2 py-1 font-mono text-[11px]">
                      {`${preset.defaultCommand} ${preset.defaultArgs.join(" ")}`}
                    </code>
                  </div>
                ) : isMcp && mcpDraft ? (
                  <div className="space-y-2.5 rounded-md border bg-muted/20 p-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`source-enabled-${id}`} className="text-xs font-medium">
                        {t("allowQueriesLabel")}
                      </Label>
                      <Switch
                        id={`source-enabled-${id}`}
                        checked={mcpDraft.enabled}
                        disabled={!hostAvailable}
                        onCheckedChange={(checked) => void handleToggleEnabled(id, checked)}
                        data-testid={`personal-source-enable-${id}`}
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor={`source-cmd-${id}`} className="text-[11px]">
                          {t("commandLabel")}
                        </Label>
                        <Input
                          id={`source-cmd-${id}`}
                          className="h-7 font-mono text-xs"
                          disabled={!hostAvailable}
                          value={mcpDraft.command}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [id]: { ...prev[id], command: e.target.value },
                            }))
                          }
                        />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <Label htmlFor={`source-args-${id}`} className="text-[11px]">
                          {t("argsLabel")}
                        </Label>
                        <Input
                          id={`source-args-${id}`}
                          className="h-7 font-mono text-xs"
                          disabled={!hostAvailable}
                          value={mcpDraft.argsLine}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [id]: { ...prev[id], argsLine: e.target.value },
                            }))
                          }
                        />
                      </div>
                    </div>
                    {preset.secretEnvKey ? (
                      <div className="space-y-1">
                        <Label
                          htmlFor={`source-secret-${id}`}
                          className="flex items-center gap-1 text-[11px]"
                        >
                          <KeyRoundIcon className="size-3 text-muted-foreground" aria-hidden />
                          {t("secretLabel", { envKey: preset.secretEnvKey })}
                        </Label>
                        <Input
                          id={`source-secret-${id}`}
                          type="password"
                          className="h-7 font-mono text-xs"
                          disabled={!hostAvailable}
                          placeholder={t("secretPlaceholder")}
                          value={mcpDraft.secretValue}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [id]: { ...prev[id], secretValue: e.target.value },
                            }))
                          }
                          data-testid={`personal-source-secret-${id}`}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <a
                  href={preset.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {t("docsLink")}
                  <ExternalLinkIcon className="size-3" aria-hidden />
                </a>
                {isMcp ? (
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-3 text-xs"
                    disabled={!hostAvailable || savingId === id}
                    onClick={() => void handleSaveMcpSource(preset)}
                    data-testid={`personal-source-save-${id}`}
                  >
                    {savingId === id ? (
                      <Loader2Icon className="mr-1 size-3 animate-spin" aria-hidden />
                    ) : null}
                    {t("saveAndConnect")}
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
