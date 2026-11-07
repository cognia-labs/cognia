"use client"

/**
 * Delegations panel — workspace-side surface for active + recently settled
 * team delegations (background / external / team handoffs).
 *
 * Mirrors {@link ConsensusPanel}: rows come from `selectTeamDelegations` for
 * the team this panel was opened for; approve / cancel dispatch through the
 * delegation orchestrator so plugins listening on `onTeamDelegationComplete`
 * see the events. A launched delegation shows its child run's status
 * (`projectDelegation`, ADR-0252 §2), read live from the run's row, so a child
 * that is paused or needs recovery says so. Without this surface the delegation runtime (which teammates
 * can drive via the `team_delegate` tool) had no operator-facing view — a
 * delegation stuck in `awaiting_approval` (e.g. inside quiet hours) could never
 * be released.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"

import { SendIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { TeamDelegationStatus } from "@/types/agent/agent-team"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getExecutionRun } from "@/lib/db/execution-runs"
import type { ExecutionRun } from "@/types/execution/run"
import {
  delegationExecutionRunId,
  projectDelegation,
  type TeamDelegationView,
} from "@/lib/squads/delegation-view"
import type { AgentTeamState } from "@/stores/squads/agent-team-store/types"
import { useAgentTeamStore } from "@/stores/squads/agent-team-store/store"
import { selectTeamDelegations } from "@/stores/squads/agent-team-store/selectors"
import { approveDelegation, cancelDelegation } from "@/lib/squads/delegation-orchestrator"

function statusVariant(
  status: TeamDelegationStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
    case "pending":
      return "default"
    case "awaiting_approval":
      return "outline"
    case "completed":
      return "secondary"
    case "failed":
    case "timeout":
      return "destructive"
    case "cancelled":
      return "outline"
    default:
      return "outline"
  }
}

/** No launched delegation, no rows to read. */
const NO_RUNS: ReadonlyMap<string, ExecutionRun | undefined> = new Map()

export interface DelegationsPanelProps {
  /**
   * Which team's delegations to show. See `ConsensusPanelProps.teamId`.
   *
   * Omitted means "whichever team the store last selected", which only
   * `createTeam` writes and persist does not carry — so it is right inside a
   * surface the user just created a squad from and empty after a reload. Every
   * real caller names its team.
   */
  teamId?: string
}

export function DelegationsPanel({ teamId }: DelegationsPanelProps = {}) {
  const t = useTranslations("agentTeamsWorkspace.delegations")
  // The selector materialises a fresh array, so `useShallow` bails out when the
  // contents are reference-equal and the panel does not churn. One selector,
  // one fallback rule — the same `teamId ?? activeTeamId` resolution the
  // consensus panel's roster follows, so a named team and an unnamed one
  // cannot drift apart.
  const delegations = useAgentTeamStore(
    useShallow((state: AgentTeamState) =>
      selectTeamDelegations(state, teamId ?? state.activeTeamId ?? undefined)
    )
  )

  const runIds = useMemo(
    () => [
      ...new Set(
        delegations.map(delegationExecutionRunId).filter((id): id is string => Boolean(id))
      ),
    ],
    [delegations]
  )
  const runIdsKey = runIds.join("\u0000")
  const runs = useClientLiveQuery(
    async () => {
      if (runIds.length === 0) return NO_RUNS
      const rows = await Promise.all(runIds.map((id) => getExecutionRun(id).catch(() => undefined)))
      return new Map(runIds.map((id, index) => [id, rows[index]]))
    },
    // `runIds` is rebuilt with every store change; its contents are the key.
    [runIdsKey],
    NO_RUNS
  )

  const ordered = useMemo(
    () =>
      delegations
        .map((record) => {
          const runId = delegationExecutionRunId(record)
          return projectDelegation(record, runId ? runs?.get(runId) : undefined)
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [delegations, runs]
  )

  const isPending = (status: TeamDelegationStatus): boolean =>
    status === "active" || status === "awaiting_approval" || status === "pending"

  return (
    <Card className="space-y-3 p-4" data-testid="delegations-panel">
      <p className="flex items-center gap-2 text-sm font-medium">
        <SendIcon className="size-4 text-muted-foreground" aria-hidden />
        {t("title")}
      </p>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ScrollArea className="max-h-[420px] pr-1">
          <div className="space-y-3">
            {ordered.map((row: TeamDelegationView) => (
              <div key={row.id} className="space-y-2 rounded-md border p-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{row.reason}</p>
                  <div className="flex shrink-0 items-center gap-1">
                    {row.runStatus ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t(`runStatus.${row.runStatus}` as never)}
                      </Badge>
                    ) : null}
                    <Badge variant={statusVariant(row.status)} className="text-[10px]">
                      {t(`status.${row.status}` as never)}
                    </Badge>
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("target", { type: row.targetType, id: row.targetId ?? "—" })}
                </p>
                {row.error ? <p className="text-[10px] text-destructive">{row.error}</p> : null}
                {isPending(row.status) ? (
                  <div className="flex justify-end gap-2">
                    {row.status === "awaiting_approval" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => approveDelegation(row.id)}
                      >
                        {t("approve")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => cancelDelegation(row.id)}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  )
}
