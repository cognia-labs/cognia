/**
 * A Squad delegation as the operator sees it: the Squad's policy record
 * projected over its child run (ADR-0252 §2).
 *
 * The `TeamDelegationRecord` keeps what only the Squad knows: the reason, the
 * target, the approval gate, the depth it was admitted at, and the text the
 * child handed back (text never enters the journal). Once launched, what the
 * delegation is doing is its child's `executionRuns` row, linked through
 * `metadata.executionRunId`. So the status shown is the row's, mapped onto the
 * delegation vocabulary, and a row that is paused, waiting or needs recovery
 * says so instead of reading as plain "active".
 *
 * Two record states win over the row: `cancelled` (the operator's stop is
 * final, even while the child is still winding down) and the pre-launch policy
 * states (`awaiting_approval`, a refusal), which have no row yet.
 */

import type { TeamDelegationRecord, TeamDelegationStatus } from "@/types/agent/agent-team"
import {
  isTerminalRunStatus,
  type ExecutionRun,
  type ExecutionRunStatus,
  type ExecutionTerminalStatus,
} from "@/types/execution/run"

/** A run status that is neither plainly running nor settled. */
export type PendingRunStatus = Exclude<ExecutionRunStatus, "running" | ExecutionTerminalStatus>

export interface TeamDelegationView extends TeamDelegationRecord {
  /**
   * The child run's own status while it has not settled and is anything but
   * plainly running (`queued`, `waiting`, `paused`, `recovery_required`).
   * Absent otherwise.
   */
  runStatus?: PendingRunStatus
}

/** The child run a launched delegation is linked to, if any. */
export function delegationExecutionRunId(record: TeamDelegationRecord): string | undefined {
  const id = record.metadata?.executionRunId
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function settledStatus(
  record: TeamDelegationRecord,
  run: ExecutionRun
): Extract<TeamDelegationStatus, "completed" | "failed" | "cancelled" | "timeout"> {
  if (run.status === "completed") return "completed"
  if (run.status === "cancelled") return "cancelled"
  // A deadline is the launcher's outcome flag, not a run status: the record
  // keeps it, the row only says the run failed.
  return record.status === "timeout" ? "timeout" : "failed"
}

function failureText(view: TeamDelegationRecord): string | undefined {
  if (view.error) return view.error
  if (view.status !== "failed" && view.status !== "timeout") return undefined
  // A refusal before launch keeps its reason in metadata; a child that failed
  // hands its error back as the record's result.
  const refused = view.metadata?.error
  if (typeof refused === "string" && refused.length > 0) return refused
  return view.result || undefined
}

function withFailure(view: TeamDelegationView): TeamDelegationView {
  const error = failureText(view)
  return error && error !== view.error ? { ...view, error } : view
}

/**
 * Project `record` over its child run. `run` is the row its
 * `metadata.executionRunId` names, or `undefined` when there is none (not
 * launched, refused, or the row is gone), which leaves the record's status as
 * it is. A failed delegation's reason is surfaced as `error` either way.
 */
export function projectDelegation(
  record: TeamDelegationRecord,
  run: ExecutionRun | undefined
): TeamDelegationView {
  if (!run || run.id !== delegationExecutionRunId(record) || record.status === "cancelled") {
    return withFailure(record)
  }
  if (!isTerminalRunStatus(run.status)) {
    return {
      ...record,
      status: "active",
      ...(run.status !== "running" ? { runStatus: run.status as PendingRunStatus } : {}),
    }
  }
  return withFailure({
    ...record,
    status: settledStatus(record, run),
    ...(record.completedAt || run.endedAt === undefined
      ? {}
      : { completedAt: new Date(run.endedAt) }),
  })
}
