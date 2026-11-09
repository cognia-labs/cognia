/**
 * Pure derivations for the single-agent task board (the agents console's
 * `?mode=tasks`, ADR-0220): columns, the visual order within a column, and
 * the drop reducer. The board component renders these on the shared
 * `components/board/kanban-board.tsx`; the reducer is the shared one in
 * `lib/board/dnd.ts`, bound to this board's guard (`AGENT_TASK_MOVE_RULES`).
 */

import type { AgentTask, AgentTaskStatus } from "@/types/agent/agent-task"
import {
  resolveBoardDrop,
  resolveBoardDropPreview,
  type BoardDropAction,
  type BoardDropPreview,
  type BoardDropRules,
} from "@/lib/board/dnd"
import { renumberColumn } from "@/lib/board/reorder"
import {
  AGENT_TASK_MOVE_RULES,
  guardAgentTaskMove,
  type AgentTaskMoveDenial,
} from "./state-machine"

/** Canonical column order — the guard's own status order. */
export const AGENT_TASK_BOARD_COLUMN_ORDER: readonly AgentTaskStatus[] =
  AGENT_TASK_MOVE_RULES.statuses

/**
 * Stable visual order within a column: by `order`, then by last update, then
 * by id. Tasks nobody reordered all carry `order` 0, so they keep the
 * last-updated order the board showed before reordering existed.
 */
export function sortAgentTaskColumn<T extends Pick<AgentTask, "id" | "order" | "updatedAt">>(
  tasks: readonly T[]
): T[] {
  return [...tasks].sort(
    (a, b) => a.order - b.order || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id)
  )
}

export interface AgentTaskBoardColumn {
  status: AgentTaskStatus
  tasks: AgentTask[]
}

/** All eight columns in canonical order, each sorted for stable display. */
export function buildAgentTaskColumns(tasks: readonly AgentTask[]): AgentTaskBoardColumn[] {
  return AGENT_TASK_BOARD_COLUMN_ORDER.map((status) => ({
    status,
    tasks: sortAgentTaskColumn(tasks.filter((task) => task.status === status)),
  }))
}

export type AgentTaskDropAction = BoardDropAction<AgentTaskStatus, AgentTaskMoveDenial>

/** A column is one Agent's tasks; a reorder never crosses into another Agent's. */
function agentTaskDropRules(
  tasksById: ReadonlyMap<string, AgentTask>
): BoardDropRules<AgentTaskStatus, AgentTask, AgentTaskMoveDenial> {
  return {
    itemsById: tasksById,
    idOf: (task) => task.id,
    statusOf: (task) => task.status,
    columnOf: (task, status) =>
      sortAgentTaskColumn(
        [...tasksById.values()].filter(
          (other) => other.agentId === task.agentId && other.status === status
        )
      ),
    canMove: (_task, from, to) => guardAgentTaskMove(from, to),
  }
}

/** What a drag-end means: a guarded move, a reorder, a denial, or null. */
export function resolveAgentTaskDrop(
  activeId: string | null,
  overId: string | null,
  tasksById: ReadonlyMap<string, AgentTask>
): AgentTaskDropAction | null {
  return resolveBoardDrop(activeId, overId, agentTaskDropRules(tasksById))
}

/** Where the dragged task would land now, or null on a column that refuses it. */
export function resolveAgentTaskDropPreview(
  activeId: string | null,
  overId: string | null,
  tasksById: ReadonlyMap<string, AgentTask>
): BoardDropPreview<AgentTaskStatus> | null {
  return resolveBoardDropPreview(activeId, overId, agentTaskDropRules(tasksById))
}

/**
 * The `order` writes for moving `taskId` to `targetIndex` in its column:
 * the column as the board shows it, renumbered 0..n-1, changed rows only.
 */
export function reorderAgentTaskColumn(
  tasksById: ReadonlyMap<string, AgentTask>,
  taskId: string,
  targetIndex: number
): Array<{ id: string; order: number }> {
  const task = tasksById.get(taskId)
  if (!task) return []
  const column = agentTaskDropRules(tasksById).columnOf(task, task.status)
  return renumberColumn(column, taskId, targetIndex)
}
