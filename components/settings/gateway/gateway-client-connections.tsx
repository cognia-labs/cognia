"use client"

/** Native client configuration has its own async lifecycle and recovery state. */
import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCwIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { isTauri } from "@/lib/tauri"
import {
  gatewayClientConnect,
  gatewayClientRollback,
  gatewayClientStatus,
} from "@/lib/tauri/gateway"
import type {
  GatewayClientConnectionReport,
  GatewayClientConnectionStatus,
  GatewayClientId,
} from "@/types/gateway"

const CLIENT_LABELS = {
  "claude-code": "clientClaudeCode",
  codex: "clientCodex",
  gemini: "clientGemini",
  opencode: "clientOpencode",
} as const
const STATE_LABELS = {
  unmanaged: "clientUnmanaged",
  configured: "clientConfigured",
  drifted: "clientDrifted",
  "restore-needed": "clientRestoreNeeded",
  "other-account": "clientOtherAccount",
  unavailable: "clientUnavailable",
} as const

interface Props {
  primaryAlias?: string
  helperAlias?: string
  running: boolean
  accountGeneration?: number
}

export function GatewayClientConnections({
  primaryAlias,
  helperAlias,
  running,
  accountGeneration,
}: Props) {
  const t = useTranslations("settings.gateway")
  const desktop = isTauri()
  const epoch = useRef(0)
  const [report, setReport] = useState<GatewayClientConnectionReport | null>(null)
  const [loading, setLoading] = useState(desktop)
  const [pending, setPending] = useState<GatewayClientId | null>(null)
  const [error, setError] = useState<"clientConfigChanged" | "clientConnectionFailed" | null>(null)

  const readStatus = useCallback(async (revision: number) => {
    try {
      const next = await gatewayClientStatus()
      if (revision === epoch.current) {
        setReport(next)
        setError(null)
      }
    } catch {
      if (revision === epoch.current) setError("clientConnectionFailed")
    } finally {
      if (revision === epoch.current) {
        setLoading(false)
        setPending(null)
      }
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    await readStatus(++epoch.current)
  }, [readStatus])

  useEffect(() => {
    if (!desktop) return
    void readStatus(++epoch.current)
    return () => {
      epoch.current += 1
    }
  }, [desktop, running, accountGeneration, readStatus])

  const currentReport =
    report && (accountGeneration === undefined || report.accountGeneration === accountGeneration)
      ? report
      : null

  const apply = async (client: GatewayClientConnectionStatus, restore: boolean) => {
    if (!currentReport || (!restore && !primaryAlias)) return
    const revision = ++epoch.current
    setPending(client.client)
    setError(null)
    const context = {
      client: client.client,
      expectedRevision: client.revision,
      ownerAccountId: currentReport.ownerAccountId,
      accountGeneration: currentReport.accountGeneration,
    }
    try {
      const next = restore
        ? await gatewayClientRollback(context)
        : await gatewayClientConnect({
            ...context,
            modelAlias: primaryAlias!,
            ...(client.supportsHelper && helperAlias ? { helperAlias } : {}),
          })
      if (revision === epoch.current) setReport(next)
    } catch (failure) {
      if (revision === epoch.current) {
        const message = failure instanceof Error ? failure.message : String(failure)
        setError(
          message.includes("config_changed") || message.includes("account_changed")
            ? "clientConfigChanged"
            : "clientConnectionFailed"
        )
      }
    } finally {
      if (revision === epoch.current) setPending(null)
    }
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{t("clientConnectionsHeading")}</h4>
        {desktop ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || pending !== null}
            aria-label={t("clientRefresh")}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="size-3.5" />
            {t("clientRefresh")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(desktop ? "clientConnectionsHelp" : "clientDesktopRequired")}
      </p>
      {desktop ? (
        <p className="text-xs text-muted-foreground">{t("clientPrecedenceHelp")}</p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      ) : null}
      {(loading || (report !== null && currentReport === null)) && !currentReport ? (
        <p className="text-xs text-muted-foreground">{t("clientLoading")}</p>
      ) : null}
      {desktop && currentReport ? (
        <ItemGroup className="gap-2">
          {currentReport.clients.map((client) => {
            const name = t(CLIENT_LABELS[client.client])
            const managed = ["configured", "drifted", "restore-needed"].includes(client.state)
            return (
              <Item key={client.client} variant="outline" size="sm" className="items-start">
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex-wrap">
                    {name}
                    <Badge variant="secondary">{t(STATE_LABELS[client.state])}</Badge>
                    {client.connectionVerified ? (
                      <Badge variant="outline">{t("clientVerified")}</Badge>
                    ) : null}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none space-y-1 text-xs">
                    {!client.installed ? (
                      <span className="block">{t("clientNotInstalled")}</span>
                    ) : null}
                    {(client.sourcePaths ?? [client.path]).map((path) => (
                      <code key={path} className="block break-all">
                        {path}
                      </code>
                    ))}
                    {client.endpoint ? (
                      <span className="block break-all">{client.endpoint}</span>
                    ) : null}
                    {client.modelAlias ? (
                      <span className="block">
                        {t("clientSavedModel", { model: client.modelAlias })}
                      </span>
                    ) : null}
                    {client.errorCode ? (
                      <span className="block text-destructive">
                        {t(
                          client.errorCode === "gateway_client_key_unavailable"
                            ? "clientKeyUnavailable"
                            : client.errorCode.includes("version") ||
                                client.errorCode.includes("schema")
                              ? "clientVersionUnknown"
                              : "clientConnectionFailed"
                        )}
                      </span>
                    ) : null}
                    {!managed && primaryAlias ? (
                      <span className="block">
                        {t("clientApplyModel", {
                          model: primaryAlias,
                          helper: client.supportsHelper
                            ? (helperAlias ?? primaryAlias)
                            : primaryAlias,
                        })}
                      </span>
                    ) : null}
                    {client.backupPaths.length ? (
                      <span className="block">
                        {t("clientBackupCount", { count: client.backupPaths.length })}
                      </span>
                    ) : null}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="flex-wrap">
                  {managed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("clientRestore", { client: name })}
                      disabled={pending !== null || loading}
                      onClick={() => void apply(client, true)}
                    >
                      {t("clientRestoreButton")}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("clientApply", { client: name })}
                      disabled={
                        pending !== null ||
                        loading ||
                        !running ||
                        !primaryAlias ||
                        !client.installed ||
                        client.state !== "unmanaged" ||
                        !client.revision ||
                        error !== null
                      }
                      onClick={() => void apply(client, false)}
                    >
                      {t("clientApplyButton")}
                    </Button>
                  )}
                </ItemActions>
              </Item>
            )
          })}
        </ItemGroup>
      ) : null}
    </div>
  )
}
