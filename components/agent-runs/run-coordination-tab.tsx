"use client"

/**
 * Consensus and delegations for a Squad run, inside the run cockpit.
 *
 * Both panels were tabs of `/agent-teams/workspace`, a route ADR-0140 retired
 * and took out of navigation. They describe one run's coordination, so the run
 * detail is where they belong.
 *
 * # Keyed on `sourceId`, never `runId`
 *
 * `lib/execution/monitor-model.ts` documents the trap: while a team run is live
 * the row can arrive as `source: "broker"` with NO `runId` and no
 * `allowedActions`. A section keyed on `row.runId` is therefore blank exactly
 * while the run is worth looking at. `sourceId` is the native id the producing
 * engine knows, which for a team run is the `agentTeamRuns` row, and that row
 * is what names the team.
 *
 * # Says "not here" rather than showing an empty list
 *
 * Mobile syncs `executionRuns` and nothing else, so on a phone the team-run
 * record is simply absent. An empty consensus list there would claim the run
 * reached no decisions, which is a different statement from "this device does
 * not carry them".
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { ConsensusPanel } from "@/components/squads/consensus-panel"
import { DelegationsPanel } from "@/components/squads/delegations-panel"
import { useClientLiveQuery } from "@/hooks/data"
import { getAgentTeamRun, listAgentTeamSteeringReceipts } from "@/lib/db/agent-team-runtime"
import type { UnifiedExecutionRow } from "@/lib/execution/monitor-model"

/** Whether a row is a Squad run at all. Nothing else has coordination. */
export function isSquadRun(row: UnifiedExecutionRow): boolean {
  return row.kind === "team"
}

export interface RunCoordinationTabProps {
  row: UnifiedExecutionRow
}

export function RunCoordinationTab({ row }: RunCoordinationTabProps) {
  const t = useTranslations("agentRuns")

  const teamRun = useClientLiveQuery(
    () => (row.sourceId ? getAgentTeamRun(row.sourceId) : Promise.resolve(undefined)),
    [row.sourceId],
    undefined
  )
  const steeringReceipts = useClientLiveQuery(
    () => (teamRun?.id ? listAgentTeamSteeringReceipts(teamRun.id) : Promise.resolve([])),
    [teamRun?.id],
    []
  )

  // `undefined` while the query is in flight AND when the record is genuinely
  // absent. Both read the same to a user, and both mean "nothing to show yet"
  // rather than "there was nothing", which is why the copy says unavailable.
  if (!teamRun) {
    return (
      <p
        className="py-4 text-center text-xs text-muted-foreground"
        data-testid="run-coordination-unavailable"
      >
        {t("coordination.unavailable")}
      </p>
    )
  }

  const receiptsList = Array.isArray(steeringReceipts) ? steeringReceipts : []
  const deliveredCount = receiptsList.filter((r) => r.status === "delivered").length
  const queuedCount = receiptsList.filter((r) => r.status === "queued").length
  const undeliveredCount = receiptsList.length - deliveredCount - queuedCount

  return (
    <div className="flex flex-col gap-3" data-testid="run-coordination">
      {receiptsList.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs"
          data-testid="run-coordination-receipts"
        >
          <span className="font-medium">{t("coordination.receiptsLabel")}</span>
          <Badge variant="secondary" className="text-[10px]">
            {t("coordination.receiptsDelivered", { count: deliveredCount })}
          </Badge>
          {queuedCount > 0 ? (
            <Badge variant="outline" className="text-[10px]">
              {t("coordination.receiptsQueued", { count: queuedCount })}
            </Badge>
          ) : null}
          {undeliveredCount > 0 ? (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {t("coordination.receiptsExpired", { count: undeliveredCount })}
            </Badge>
          ) : null}
        </div>
      ) : null}
      <ConsensusPanel teamId={teamRun.teamId} />
      <DelegationsPanel teamId={teamRun.teamId} />
    </div>
  )
}
