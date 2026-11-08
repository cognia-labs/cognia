/**
 * A hand-off's Squad run ended: report it to the member who proposed it
 * (ADR-0252 §4).
 *
 * The end is written as a settled `squad-handoff` outbox entry, keyed by the
 * attempt, and the ADR-0249 delivery path takes it from there: it waits for
 * the room's turn boundary and the wake limits, then the room's lane sends
 * the framed result to the proposer as an automated room turn.
 *
 * Two writers, one entry: the attempt this host launched reports when its
 * outcome settles, and reconciliation finds every attempt that ended with no
 * entry (a host restart while the Squad ran, a retry launched from the run's
 * card). The entry is idempotent by attempt, so both reporting one end
 * delivers it once.
 */

import type { UIMessage } from "ai"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import { isTerminalRunStatus } from "@/types/execution/run"
import type { RoomHandoffAttempt } from "./decide"
import { findRoomHandoffProposal } from "./proposal"

const DELEGATION_PREFIX = "room-handoff:"

export interface RoomHandoffSettleDeps {
  /** Record the end and let the delivery path take it (`onBackgroundJobSettled`). */
  report: (record: BackgroundTaskJournalRecord) => Promise<void>
  /** Whether the outbox already holds an attempt's end. */
  hasEntry: (entryId: string) => Promise<boolean>
  /** Every room hand-off delegation, newest first. */
  listHandoffDelegations: () => Promise<ExecutionRun[]>
  listAttempts: (delegationRunId: string) => Promise<ExecutionRun[]>
  readMessages: (roomId: string) => Promise<UIMessage[]>
  /** The Squad's last result and error, with when its last run completed. */
  squadResult: (
    squadId: string
  ) => { finalResult?: string; error?: string; completedAt?: number } | undefined
  now: () => number
}

async function defaultDeps(): Promise<RoomHandoffSettleDeps> {
  const [
    { onBackgroundJobSettled },
    { getBackgroundTaskRecord },
    executionRuns,
    { getHostRoomRunner },
    { useAgentTeamStore },
  ] = await Promise.all([
    import("@/lib/background-tasks/result-delivery"),
    import("@/lib/db/background-tasks"),
    import("@/lib/db/execution-runs"),
    import("@/lib/chat/room/runner-host"),
    import("@/stores/squads/agent-team-store/store"),
  ])
  return {
    report: onBackgroundJobSettled,
    hasEntry: async (entryId) => Boolean(await getBackgroundTaskRecord(entryId)),
    listHandoffDelegations: () =>
      executionRuns.listExecutionRunsBySourcePrefix("delegation", DELEGATION_PREFIX),
    listAttempts: (delegationRunId) => executionRuns.listChildExecutionRuns(delegationRunId),
    readMessages: (roomId) => getHostRoomRunner().readMessages(roomId),
    squadResult: (squadId) => {
      const squad = useAgentTeamStore.getState().teams[squadId]
      if (!squad) return undefined
      const completedAt = squad.completedAt ? new Date(squad.completedAt).getTime() : undefined
      return {
        ...(squad.finalResult ? { finalResult: squad.finalResult } : {}),
        ...(squad.error ? { error: squad.error } : {}),
        ...(completedAt !== undefined && Number.isFinite(completedAt) ? { completedAt } : {}),
      }
    },
    now: Date.now,
  }
}

let depsOverride: RoomHandoffSettleDeps | null = null

/** Test-only: replace what settling reads and writes. */
export function __setRoomHandoffSettleDepsForTesting(deps: RoomHandoffSettleDeps | null): void {
  depsOverride = deps
}

async function resolveDeps(): Promise<RoomHandoffSettleDeps> {
  return depsOverride ?? (await defaultDeps())
}

/** Report one attempt's end. */
export async function settleRoomHandoffAttempt(
  attempt: RoomHandoffAttempt,
  outcome: ChildRunOutcome,
  settledAt?: number
): Promise<void> {
  const deps = await resolveDeps()
  const { squadHandoffOutboxRecord } = await import("@/lib/background-tasks/squad-handoff-outbox")
  await deps.report(
    squadHandoffOutboxRecord({
      roomId: attempt.roomId,
      brief: attempt.brief,
      startedAt: attempt.startedAt,
      settledAt: settledAt ?? deps.now(),
      ...(outcome.text ? { resultText: outcome.text } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      facts: {
        proposerId: attempt.proposerId,
        toolUseId: attempt.toolUseId,
        squadId: attempt.squadId,
        squadName: attempt.squadName,
        delegationRunId: attempt.delegationRunId,
        squadRunId: attempt.squadRunId,
        outcome: outcome.status,
      },
    })
  )
}

/** Report the attempt this host launched when its outcome settles. */
export function watchRoomHandoffAttempt(
  attempt: RoomHandoffAttempt,
  outcome: Promise<ChildRunOutcome>
): void {
  void outcome
    .then((settled) => settleRoomHandoffAttempt(attempt, settled))
    .catch((error: unknown) => console.warn("room hand-off settlement failed", error))
}

function outcomeOf(status: ExecutionRun["status"]): ChildRunOutcome["status"] {
  return status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed"
}

/**
 * Report every ended attempt of a recent hand-off that has no entry yet.
 * Reads the proposal back from the room for whose it was. The Squad's stored
 * result is the attempt's only when the Squad's last run is this attempt
 * (its completion and the attempt's end agree); otherwise the end is reported
 * without text and the Squad run holds it.
 */
export async function reconcileRoomHandoffs(): Promise<number> {
  const deps = await resolveDeps()
  const [{ squadHandoffOutboxId, SQUAD_HANDOFF_RECONCILE_WINDOW_MS }] = await Promise.all([
    import("@/lib/background-tasks/squad-handoff-outbox"),
  ])
  const since = deps.now() - SQUAD_HANDOFF_RECONCILE_WINDOW_MS
  let reported = 0
  for (const delegation of await deps.listHandoffDelegations()) {
    if (delegation.updatedAt < since || !delegation.sessionId) continue
    const roomId = delegation.sessionId
    const toolUseId = delegation.sourceId.slice(DELEGATION_PREFIX.length)
    const ended = (await deps.listAttempts(delegation.id)).filter(
      (attempt) => attempt.kind === "team" && isTerminalRunStatus(attempt.status)
    )
    if (ended.length === 0) continue
    const unreported: ExecutionRun[] = []
    for (const attempt of ended) {
      if (!(await deps.hasEntry(squadHandoffOutboxId(attempt.id)))) unreported.push(attempt)
    }
    if (unreported.length === 0) continue
    const proposal = findRoomHandoffProposal(await deps.readMessages(roomId), toolUseId)
    const decision = proposal?.decision
    if (!proposal || decision?.status !== "started") continue
    for (const attempt of unreported) {
      const result = deps.squadResult(decision.squadId)
      const endedAt = attempt.endedAt ?? attempt.updatedAt
      const own =
        result?.completedAt !== undefined && Math.abs(result.completedAt - endedAt) < 60_000
      await settleRoomHandoffAttempt(
        {
          roomId,
          toolUseId,
          proposerId: proposal.proposerId,
          squadId: decision.squadId,
          squadName: decision.squadName,
          brief: proposal.args.brief,
          delegationRunId: delegation.id,
          squadRunId: attempt.id,
          startedAt: attempt.startedAt,
        },
        {
          status: outcomeOf(attempt.status),
          ...(own && result?.finalResult ? { text: result.finalResult } : {}),
          ...(own && result?.error ? { error: result.error } : {}),
        },
        endedAt
      )
      reported += 1
    }
  }
  return reported
}
