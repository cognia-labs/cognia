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
 * entry (a host that stopped between the run's end and its entry, a retry
 * launched from the run's card, which hangs under the attempt it replaced).
 * Either way the text and error are the attempt's own run report, so both
 * writers report the same end, and the entry is idempotent by attempt, so it
 * is delivered once.
 */

import type { UIMessage } from "ai"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import type { ChildRunOutcome } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import { isTerminalRunStatus } from "@/types/execution/run"
import type { RoomHandoffAttempt } from "./decide"
import { findRoomHandoffProposal } from "./proposal"
import type { SquadRunReport } from "../squad/squad-run-report"

const DELEGATION_PREFIX = "room-handoff:"

export interface RoomHandoffSettleDeps {
  /** Record the end and let the delivery path take it (`onBackgroundJobSettled`). */
  report: (record: BackgroundTaskJournalRecord) => Promise<void>
  /** Whether the outbox already holds an attempt's end. */
  hasEntry: (entryId: string) => Promise<boolean>
  /** Every room hand-off delegation, newest first. */
  listHandoffDelegations: () => Promise<ExecutionRun[]>
  /** The runs launched under a run: a delegation's attempts, an attempt's retries. */
  listChildren: (runId: string) => Promise<ExecutionRun[]>
  readMessages: (roomId: string) => Promise<UIMessage[]>
  /** One Squad run's own report, by its Squad run id (the row's `sourceId`). */
  runReport: (squadRunId: string) => Promise<SquadRunReport>
  now: () => number
}

async function defaultDeps(): Promise<RoomHandoffSettleDeps> {
  const [
    { onBackgroundJobSettled },
    { getBackgroundTaskRecord },
    executionRuns,
    { readRoomHandoffTranscript },
    { readSquadRunReport },
  ] = await Promise.all([
    import("@/lib/background-tasks/result-delivery"),
    import("@/lib/db/background-tasks"),
    import("@/lib/db/execution-runs"),
    import("./transcript"),
    import("../squad/squad-run-report"),
  ])
  return {
    report: onBackgroundJobSettled,
    hasEntry: async (entryId) => Boolean(await getBackgroundTaskRecord(entryId)),
    listHandoffDelegations: () =>
      executionRuns.listExecutionRunsBySourcePrefix("delegation", DELEGATION_PREFIX),
    listChildren: (runId) => executionRuns.listChildExecutionRuns(runId),
    readMessages: readRoomHandoffTranscript,
    runReport: readSquadRunReport,
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
 * Every Squad attempt of a hand-off: the delegation's own `team` children and,
 * under each, the retries that replaced it (a retry is launched as the child
 * of the attempt it replaces), however deep the chain.
 */
async function listHandoffAttempts(
  deps: RoomHandoffSettleDeps,
  delegationRunId: string
): Promise<ExecutionRun[]> {
  const attempts: ExecutionRun[] = []
  const seen = new Set<string>([delegationRunId])
  let frontier = [delegationRunId]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const parentId of frontier) {
      for (const child of await deps.listChildren(parentId)) {
        if (child.kind !== "team" || seen.has(child.id)) continue
        seen.add(child.id)
        attempts.push(child)
        next.push(child.id)
      }
    }
    frontier = next
  }
  return attempts
}

/**
 * Report every ended attempt of a recent hand-off that has no entry yet.
 * Reads the proposal back from the room for whose it was, and each attempt's
 * text and error from that attempt's own run, so a retry never carries the
 * report of the run it replaced, nor of the Squad's next run.
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
    const ended = (await listHandoffAttempts(deps, delegation.id)).filter((attempt) =>
      isTerminalRunStatus(attempt.status)
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
      const report = await deps.runReport(attempt.sourceId).catch(() => ({}) as SquadRunReport)
      const status = outcomeOf(attempt.status)
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
          status,
          ...(status === "completed" && report.text ? { text: report.text } : {}),
          ...(status !== "completed" && report.error ? { error: report.error } : {}),
        },
        attempt.endedAt ?? attempt.updatedAt
      )
      reported += 1
    }
  }
  return reported
}
