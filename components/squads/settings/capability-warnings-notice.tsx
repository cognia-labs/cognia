"use client"

/**
 * Names the capability ids a Squad (or one of its teammates) still references
 * but that no longer resolve, usually because the plugin that contributed them
 * was disabled or uninstalled (ADR-0252 P2). Renders nothing while every id
 * resolves. It audits whenever the Squad's capability ids change, so removing a
 * stale id clears its row without "Audit now".
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useSquadCapabilityWarnings } from "@/hooks/squads/use-squad-capability-warnings"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"

export interface CapabilityWarningsNoticeProps {
  teamId: string
}

export function CapabilityWarningsNotice({ teamId }: CapabilityWarningsNoticeProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.capabilityWarnings")
  const warnings = useSquadCapabilityWarnings(teamId, { audit: true })
  const teammates = useAgentTeamStore((s) => s.teammates)
  if (warnings.length === 0) return null

  return (
    <Alert data-testid="capability-warnings-notice">
      <AlertTriangleIcon className="size-4 text-amber-500" />
      <AlertTitle>{t("title", { count: warnings.length })}</AlertTitle>
      <AlertDescription>
        <p>{t("description")}</p>
        <ul className="mt-1 space-y-0.5 text-xs" aria-label={t("listLabel")}>
          {warnings.map((w) => {
            const owner =
              w.scope.kind === "teammate"
                ? (teammates[w.scope.teammateId]?.name ?? w.scope.teammateId)
                : null
            return (
              <li
                key={`${w.scope.kind === "teammate" ? w.scope.teammateId : "team"}:${w.bucket}:${w.missingId}`}
              >
                <span className="text-muted-foreground">
                  {t("entryContext", {
                    owner: owner ? t("teammateScope", { name: owner }) : t("teamScope"),
                    bucket: t(`buckets.${w.bucket}`),
                  })}
                </span>{" "}
                <span className="font-mono">{w.missingId}</span>
              </li>
            )
          })}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
