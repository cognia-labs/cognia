"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ShieldAlert, ShieldCheck, Terminal } from "lucide-react"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { supportsAgentTerminal } from "@/lib/ai/agent/external/agent-transport"
import { findRuntimeForConfig } from "@/lib/ai/agent/external/config/install-catalog"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

interface OhMyPiStatusCardProps {
  agentId: string
  connected: boolean
}

/**
 * Oh My Pi (`oh-my-pi`) host readiness, account, model & security-boundary diagnostic (#15, #16, #17).
 *
 * Surfaces the five facts users need before running a first turn on `omp acp`:
 *  1. Installation command & negotiated version vs certified version (`18.22.2`).
 *  2. Target-host ACP terminal capability — paired/remote/web transports lack ACP terminal
 *     and refuse `omp acp` fail-closed (#16).
 *  3. Negotiated ACP auth methods / local provider or Cognia Gateway routing (#15, #21).
 *  4. Active session model availability and first-turn/last-run status (#15).
 *  5. Per-tool approval ceiling boundary: native pre-approved tools can bypass ACP
 *     permission callbacks, so `requireApprovalFor` is refused fail-closed (#17).
 */
export function OhMyPiStatusCard({ agentId, connected }: OhMyPiStatusCardProps) {
  const t = useTranslations("externalAgent.settings.ompStatus")
  const agent = useExternalAgentStore((s) => s.agents[agentId])
  const validity = useExternalAgentStore((s) => s.agentValidity[agentId])
  const lastRun = useExternalAgentStore((s) => s.lastRunSnapshots[agentId])

  const runtimeEntry = useMemo(() => (agent ? findRuntimeForConfig(agent) : undefined), [agent])
  const certifiedVersion = runtimeEntry?.certifiedVersions?.[0] ?? "18.22.2"
  const detectedVersion = validity?.negotiation?.agentInfo?.version
  const terminalSupported = supportsAgentTerminal()
  const requiresForcedApproval = Boolean(agent?.requireApprovalFor?.length)

  const liveDiagnostics = useMemo(() => {
    if (!connected) {
      return {
        authMethods: validity?.negotiation?.authMethods ?? [],
        currentModelId: undefined as string | undefined,
        availableModelCount: 0,
      }
    }
    const manager = getExternalAgentManager()
    const authRes = manager.getAuthMethods(agentId)
    const authMethods =
      authRes.status === "ok" ? authRes.data : (validity?.negotiation?.authMethods ?? [])
    const liveSessionId = manager.resolveLiveSessionId(agentId)
    const modelsRes = liveSessionId ? manager.getSessionModels(agentId, liveSessionId) : undefined
    const modelsData = modelsRes?.status === "ok" ? modelsRes.data : undefined
    return {
      authMethods,
      currentModelId: modelsData?.currentModelId,
      availableModelCount: modelsData?.availableModels?.length ?? 0,
    }
  }, [agentId, connected, validity?.negotiation?.authMethods])

  const command = agent?.process?.command || runtimeEntry?.systemCommand || "omp"
  const versionCertified = Boolean(
    detectedVersion && runtimeEntry?.certifiedVersions?.includes(detectedVersion)
  )

  return (
    <SettingsBlock title={t("title")} icon={<Terminal />} headingLevel={4} testid="omp-status-card">
      <div className="divide-y divide-border/60 text-xs">
        {/* 1. Installation & version */}
        <div className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0">
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-foreground">{t("installLabel")}</p>
            <p className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {command}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {detectedVersion ? (
              <Badge variant={versionCertified ? "default" : "secondary"}>
                {t("detectedVersion", { version: detectedVersion })}
              </Badge>
            ) : (
              <Badge variant="outline">{t("versionUnknown")}</Badge>
            )}
            <Badge variant="outline">{t("certifiedBadge", { version: certifiedVersion })}</Badge>
          </div>
        </div>

        {/* 2. Target-host ACP terminal readiness (#16) */}
        <div className="space-y-1 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{t("hostLabel")}</span>
            <Badge
              variant={terminalSupported ? "default" : "destructive"}
              className="gap-1"
              data-testid="omp-terminal-badge"
            >
              {terminalSupported ? (
                <ShieldCheck className="size-3" aria-hidden />
              ) : (
                <ShieldAlert className="size-3" aria-hidden />
              )}
              {terminalSupported ? t("hostDesktopReady") : t("hostTerminalMissing")}
            </Badge>
          </div>
          <p className="leading-relaxed text-muted-foreground">
            {terminalSupported ? t("hostDesktopHint") : t("hostPairedBlockedHint")}
          </p>
        </div>

        {/* 3. Account & ACP auth methods (#15) */}
        <div className="space-y-1 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{t("authLabel")}</span>
            <Badge variant={validity?.negotiation?.authRequired ? "destructive" : "outline"}>
              {!connected
                ? t("authDisconnected")
                : validity?.negotiation?.authRequired
                  ? t("authRequired")
                  : t("authReady")}
            </Badge>
          </div>
          {liveDiagnostics.authMethods.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {liveDiagnostics.authMethods.map((method) => (
                <Badge key={method.id} variant="secondary" className="text-[11px]">
                  {method.name || method.id}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="leading-relaxed text-muted-foreground">
              {connected ? t("authNativeHint") : t("connectToInspect")}
            </p>
          )}
        </div>

        {/* 4. Models & first-turn readiness (#15) */}
        <div className="space-y-1 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{t("readinessLabel")}</span>
            <Badge
              variant={
                lastRun?.terminalOutcome === "ok"
                  ? "default"
                  : lastRun?.terminalOutcome === "error"
                    ? "destructive"
                    : "outline"
              }
              data-testid="omp-first-turn-badge"
            >
              {lastRun?.terminalOutcome === "ok"
                ? t("firstTurnVerified")
                : lastRun?.terminalOutcome === "error"
                  ? t("firstTurnFailed")
                  : t("firstTurnPending")}
            </Badge>
          </div>
          <p className="leading-relaxed text-muted-foreground">
            {liveDiagnostics.currentModelId
              ? t("activeModelSummary", {
                  model: liveDiagnostics.currentModelId,
                  count: liveDiagnostics.availableModelCount,
                })
              : t("modelReadinessHint")}
          </p>
        </div>

        {/* 5. Mandatory per-tool approval boundary (#17) */}
        <div className="space-y-1 py-2 last:pb-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground">{t("approvalBoundaryLabel")}</span>
            <Badge
              variant={requiresForcedApproval ? "destructive" : "outline"}
              data-testid="omp-approval-boundary-badge"
            >
              {requiresForcedApproval ? t("approvalBoundaryBlocked") : t("approvalBoundaryNote")}
            </Badge>
          </div>
          <p className="leading-relaxed text-muted-foreground">{t("approvalBoundaryHint")}</p>
        </div>
      </div>
    </SettingsBlock>
  )
}
