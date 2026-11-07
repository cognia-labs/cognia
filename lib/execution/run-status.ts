/**
 * The run status vocabulary shared by the execution ledger and the runs it
 * projects (ADR-0252 P3).
 *
 * Three questions used to be answered in place, each with its own list: is
 * this execution run over, is it still live, and which journal event does a
 * settled Squad run write. The answers live in one place each:
 *
 * - an execution run is over: `isTerminalRunStatus` (`@/types/execution/run`,
 *   the contract that owns `ExecutionRunStatus`);
 * - a Squad run or child is over, parked, or reports which outcome:
 *   `isTerminalTeamStatus`, `isParkedTeamStatus`, `teamRunOutcome`
 *   (`@cognia/agent-orchestration/rules`, which owns `AgentTeamRunStatus`);
 * - this file: live execution runs, and the one mapping from a settled Squad
 *   run to the execution event it writes.
 */

import { isTerminalTeamStatus, type TerminalTeamStatus } from "@cognia/agent-orchestration/rules"
import type { AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import { isTerminalRunStatus, type ExecutionRunStatus } from "@/types/execution/run"

/**
 * A run that can still change: queued, running, waiting, paused or waiting
 * for recovery. Exactly the complement of the terminal statuses, so a run is
 * always one or the other.
 */
export function isLiveRunStatus(status: ExecutionRunStatus): boolean {
  return !isTerminalRunStatus(status)
}

/**
 * Where a Squad run comes to rest when its lifecycle settles: a terminal
 * status, a pause, or a wait for a person. `pausing` and `sleeping` are not
 * here: the coordinator moves through them, the lifecycle never ends on them.
 */
export type SettledTeamRunStatus = TerminalTeamStatus | "paused" | "needs_input"

export function isSettledTeamRunStatus(status: AgentTeamRunStatus): status is SettledTeamRunStatus {
  return isTerminalTeamStatus(status) || status === "paused" || status === "needs_input"
}

export type SettledTeamRunEvent =
  "run.completed" | "run.failed" | "run.cancelled" | "run.paused" | "run.waiting"

/**
 * The execution event a settled Squad run writes to its `execution:team:` row.
 * A forced stop is a cancellation to the ledger, as it is to the caller
 * (`teamRunOutcome`); a run waiting for a person is `waiting`, not paused,
 * because nobody paused it.
 */
export function executionEventForSettledTeamRun(status: SettledTeamRunStatus): SettledTeamRunEvent {
  switch (status) {
    case "completed":
      return "run.completed"
    case "failed":
      return "run.failed"
    case "cancelled":
    case "terminated":
      return "run.cancelled"
    case "paused":
      return "run.paused"
    case "needs_input":
      return "run.waiting"
  }
}
