/**
 * Guarded task-move semantics for the team task board (kanban).
 *
 * `canMoveTask` is the SINGLE source of truth for which status transitions a
 * human (or an actor on the human's behalf) may perform on a team task. It is
 * shared by:
 *   - the desktop board's drag-and-drop (illegal drop targets grey out at
 *     drag start via `allowedMoveTargets`),
 *   - the mobile board's action-sheet moves (Companion RPC `team_task_move`),
 *   - the plugin `ctx.team.moveTask` API.
 *
 * Ownership model behind the rules:
 *   - `blocked` is dependency-derived — cards enter/leave it automatically,
 *     never by hand.
 *   - `claimed` / `in_progress` belong to the runtime while a run is active
 *     (`executing` / `planning`); when the team is at rest they may be pushed
 *     back to `pending` (e.g. after a pause left them stranded).
 *   - `pending → cancelled` (drop a task), `review → completed | failed`
 *     (human review verdict), and `failed → pending` (manual retry,
 *     ADR-0022's deferred retry surface) are the human-owned transitions.
 *   - Same-column moves (reordering) are always allowed.
 *
 * The rules are data (`TEAM_TASK_MOVE_RULES`) evaluated by the shared engine
 * in `lib/board/move-guard.ts`, which the agent-task board uses for
 * its own, deliberately different, rule set.
 */

import type { AgentTeamTask, TeamStatus, TeamTaskStatus } from "@/types/agent/agent-team"
import { allowedTargets, canMove, defineMoveRules, type MoveVerdict } from "@/lib/board/move-guard"
import { renumberColumn } from "@/lib/board/reorder"
import type { TaskMoveDenial } from "@cognia/plugin-contract/lib/ai/agent/team/gates/task-move-guard"
export type {
  TaskMoveDenial,
  TaskMoveError,
} from "@cognia/plugin-contract/lib/ai/agent/team/gates/task-move-guard"

export type TaskMoveVerdict = MoveVerdict<TaskMoveDenial>

/** Team statuses during which the runtime owns claimed/in_progress tasks. */
const RUNTIME_ACTIVE_TEAM_STATUSES: ReadonlySet<TeamStatus> = new Set(["planning", "executing"])

/**
 * The Squad board's rules, read by `lib/board/move-guard.ts` in its fixed
 * order: `blocked` is closed both ways, `claimed`/`in_progress` are closed
 * while the team runs and may only be left for `pending` at rest, and the
 * table lists the human verdicts. They differ from the Issue tracker's
 * permissive rules and from the agent-task board's on purpose (ADR-0066).
 */
export const TEAM_TASK_MOVE_RULES = defineMoveRules<TeamTaskStatus, TaskMoveDenial, TeamStatus>({
  statuses: [
    "pending",
    "blocked",
    "claimed",
    "in_progress",
    "review",
    "completed",
    "failed",
    "cancelled",
  ],
  derived: { statuses: ["blocked"], reason: "blocked-column" },
  runtime: {
    statuses: ["claimed", "in_progress"],
    reason: "runtime-owned",
    active: (teamStatus) => RUNTIME_ACTIVE_TEAM_STATUSES.has(teamStatus),
    // Unstranding after a pause or abort.
    atRest: { exits: ["pending"], reason: "illegal-transition" },
  },
  humanMoves: {
    // Drop a task.
    pending: ["cancelled"],
    blocked: [],
    claimed: [],
    in_progress: [],
    // The human review verdict.
    review: ["completed", "failed"],
    completed: [],
    // Manual retry (ADR-0022's deferred retry surface).
    failed: ["pending"],
    cancelled: [],
  },
  illegal: "illegal-transition",
})

/**
 * Decide whether a task may be moved `from` → `to` given the team's current
 * status. `from` is passed explicitly (rather than read off `task.status`) so
 * callers validating a stale snapshot (RPC round-trips) surface the mismatch
 * at their own layer. `task` is part of the signature every caller shares;
 * no rule reads it today.
 */
export function canMoveTask(
  _task: Pick<AgentTeamTask, "id" | "dependencies">,
  from: TeamTaskStatus,
  to: TeamTaskStatus,
  teamStatus: TeamStatus
): TaskMoveVerdict {
  return canMove(TEAM_TASK_MOVE_RULES, from, to, teamStatus)
}

/**
 * All statuses the task may currently be moved to (excluding its own column,
 * which is always a legal reorder target). Drives dnd-kit droppable disabling
 * and the mobile action sheet.
 */
export function allowedMoveTargets(
  task: Pick<AgentTeamTask, "id" | "dependencies" | "status">,
  teamStatus: TeamStatus
): TeamTaskStatus[] {
  return allowedTargets(TEAM_TASK_MOVE_RULES, task.status, teamStatus)
}

/**
 * Pure same-column reorder: move `taskId` to `targetIndex` within `column`
 * (the column's tasks in current visual order) and renumber `order` 0..n-1.
 * Returns only the entries whose `order` actually changed, ready for a store
 * write. The shared `renumberColumn` of `lib/board/reorder.ts`.
 */
export function reorderColumn(
  column: ReadonlyArray<Pick<AgentTeamTask, "id" | "order">>,
  taskId: string,
  targetIndex: number
): Array<{ id: string; order: number }> {
  return renumberColumn(column, taskId, targetIndex)
}

/** Stable visual order for a column: by `order`, then creation time, then id. */
export function sortColumn<T extends Pick<AgentTeamTask, "id" | "order" | "createdAt">>(
  tasks: readonly T[]
): T[] {
  return [...tasks].sort(
    (a, b) =>
      a.order - b.order ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.id.localeCompare(b.id)
  )
}
