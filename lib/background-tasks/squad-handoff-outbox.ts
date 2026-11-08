/**
 * The outbox's `squad-handoff` entries (ADR-0252 §4): a Squad run a room
 * member handed work to, whose end is owed to that member.
 *
 * Like a shell job's end it is not a run of this outbox's own: the Squad run
 * is its own `team` row, an attempt of the hand-off's delegation. The squads
 * module writes the entry once, settled, when an attempt ends (or when
 * reconciliation finds one that ended unreported), keyed by the attempt, so a
 * retried delegation reports each attempt once. A stopped attempt is owed
 * nothing: a person stopped it, and the member is not woken to hear so.
 */

import type {
  BackgroundSquadHandoffFacts,
  BackgroundTaskJournalRecord,
} from "@/lib/background-tasks/registry-core"
import { isJobOutboxKind } from "@/lib/background-tasks/job-settlement"

/**
 * How far back reconciliation looks for an ended attempt with no entry. An
 * entry inside the window is never pruned, so reconciliation cannot write it
 * a second time.
 */
export const SQUAD_HANDOFF_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** The entry id of one attempt's end. */
export function squadHandoffOutboxId(squadRunId: string): string {
  return `squad-handoff:${squadRunId}`
}

/**
 * Kinds written once, already settled, storing their own status: the job
 * supervisor's ends and Squad hand-offs. Not runs of the outbox's own.
 */
export function isSettledOutboxKind(kind: BackgroundTaskJournalRecord["kind"]): boolean {
  return isJobOutboxKind(kind) || kind === "squad-handoff"
}

/** How long a kind's settled entries are kept from pruning, or `0` for no floor. */
export function outboxReconcileWindowMs(kind: BackgroundTaskJournalRecord["kind"]): number {
  return kind === "squad-handoff" ? SQUAD_HANDOFF_RECONCILE_WINDOW_MS : 0
}

export interface SquadHandoffSettlement {
  roomId: string
  brief: string
  facts: BackgroundSquadHandoffFacts
  startedAt: number
  settledAt: number
  /** The Squad's final result, when it has one. */
  resultText?: string
  /** Why the attempt failed. */
  error?: string
}

/** The settled entry for one attempt's end. */
export function squadHandoffOutboxRecord(
  settlement: SquadHandoffSettlement
): BackgroundTaskJournalRecord {
  const { facts } = settlement
  return {
    runId: squadHandoffOutboxId(facts.squadRunId),
    kind: "squad-handoff",
    subagentId: facts.squadId,
    label: facts.squadName,
    prompt: settlement.brief,
    sessionId: settlement.roomId,
    host: "renderer",
    status: facts.outcome === "completed" ? "done" : "error",
    startedAt: settlement.startedAt,
    settledAt: settlement.settledAt,
    ...(settlement.resultText ? { resultText: settlement.resultText } : {}),
    ...(facts.outcome === "completed"
      ? {}
      : { error: settlement.error ?? `Squad run ${facts.outcome}` }),
    mode: "background",
    deliveryState: facts.outcome === "cancelled" ? "skipped" : "pending",
    squadHandoff: facts,
  }
}
