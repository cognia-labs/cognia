/**
 * Guarded moves for single-agent durable tasks (the agents console's task
 * board, ADR-0220, and a paired phone's `agent_task_move`).
 *
 * Ownership model behind the rules:
 *   - `blocked` is dependency-derived (`deriveDependencyStatus`), closed to
 *     people in both directions.
 *   - Only the runtime enters `in_progress` and `review`: a run starts through
 *     the Scheduler, never by dragging a card.
 *   - A person may stop work at any time: `in_progress → paused | cancelled`,
 *     `paused → pending | cancelled`. These carry Scheduler side effects, so
 *     every person-initiated move goes through `applyAgentTaskMove`
 *     (`lib/agent-tasks/runtime.ts`), never straight to `moveAgentTask`.
 *   - `review → completed | failed` is the human verdict; `failed → pending`
 *     retries and `failed → cancelled` gives up; `completed` and `cancelled`
 *     are terminal.
 *
 * The rules are data (`AGENT_TASK_MOVE_RULES`) evaluated by the shared engine
 * in `lib/board/move-guard.ts`. They differ from the Squad board's and the
 * Issue tracker's on purpose: a Squad locks its active columns while the team
 * runs, an issue tracker lets its user go anywhere.
 */

import type { AgentTaskStatus } from "@/types/agent/agent-task"
import { allowedTargets, canMove, defineMoveRules, type MoveVerdict } from "@/lib/board/move-guard"

export type AgentTaskMoveDenial = "dependency-owned" | "runtime-owned" | "illegal-transition"
export type AgentTaskMoveVerdict = MoveVerdict<AgentTaskMoveDenial>

export const AGENT_TASK_MOVE_RULES = defineMoveRules<AgentTaskStatus, AgentTaskMoveDenial>({
  statuses: [
    "pending",
    "blocked",
    "in_progress",
    "review",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ],
  derived: { statuses: ["blocked"], reason: "dependency-owned" },
  runtimeEntered: { statuses: ["in_progress", "review"], reason: "runtime-owned" },
  humanMoves: {
    pending: ["cancelled"],
    blocked: [],
    in_progress: ["paused", "cancelled"],
    review: ["completed", "failed"],
    paused: ["pending", "cancelled"],
    completed: [],
    failed: ["pending", "cancelled"],
    cancelled: [],
  },
  illegal: "illegal-transition",
})

export function guardAgentTaskMove(
  from: AgentTaskStatus,
  to: AgentTaskStatus
): AgentTaskMoveVerdict {
  return canMove(AGENT_TASK_MOVE_RULES, from, to, undefined)
}

/** Every status a task in `status` may be moved to by a person, in board order. */
export function allowedAgentTaskMoves(status: AgentTaskStatus): AgentTaskStatus[] {
  return allowedTargets(AGENT_TASK_MOVE_RULES, status, undefined)
}

export function deriveDependencyStatus(
  current: AgentTaskStatus,
  dependencyStatuses: readonly AgentTaskStatus[]
): AgentTaskStatus {
  if (current !== "pending" && current !== "blocked") return current
  return dependencyStatuses.every((status) => status === "completed") ? "pending" : "blocked"
}
