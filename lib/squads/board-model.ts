/**
 * Pure derivations for the team task board (kanban) — columns, swimlanes,
 * filters, WIP hints, dependency-lock badges, and the dnd drop reducer. All
 * board decision logic lives here (testable without React/dnd-kit); the
 * components in `components/squads/board/` stay thin render shells.
 * The drop reducer and the facet filter are the shared ones in `lib/board/`,
 * bound to this board's guard and fields.
 */

import type {
  AgentTeammate,
  AgentTeamTask,
  TeamStatus,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import {
  resolveBoardDrop,
  resolveBoardDropPreview,
  type BoardDropPreview,
  type BoardDropRules,
} from "@/lib/board/dnd"
import {
  applyFacetFilter,
  collectFacetValues,
  isFacetFilterActive,
  type BoardFilterSpec,
} from "@/lib/board/filter"
import { canMoveTask, sortColumn, type TaskMoveDenial } from "./gates/task-move-guard"

/** Canonical column order — mirrors the task lifecycle left to right. */
export const BOARD_COLUMN_ORDER: readonly TeamTaskStatus[] = [
  "pending",
  "blocked",
  "claimed",
  "in_progress",
  "review",
  "completed",
  "failed",
  "cancelled",
]

export interface BoardFilter {
  /** Keep tasks carrying at least one of these tags (empty = all). */
  tags: readonly string[]
  /** Keep tasks with one of these priorities (empty = all). */
  priorities: readonly SubAgentPriority[]
  /** Keep tasks assigned to / claimed by one of these ids (empty = all). */
  assigneeIds: readonly string[]
}

export const EMPTY_BOARD_FILTER: BoardFilter = { tags: [], priorities: [], assigneeIds: [] }

/** A task's owner on the board: whoever claimed it, else whom it was assigned to. */
const ownerOf = (task: AgentTeamTask): string | undefined => task.claimedBy ?? task.assignedTo

const BOARD_FILTER_SPEC: BoardFilterSpec<AgentTeamTask, BoardFilter> = {
  facets: [
    { selected: (filter) => filter.tags, values: (task) => task.tags },
    { selected: (filter) => filter.priorities, values: (task) => task.priority },
    { selected: (filter) => filter.assigneeIds, values: ownerOf },
  ],
}

export function isFilterActive(filter: BoardFilter): boolean {
  return isFacetFilterActive(filter, BOARD_FILTER_SPEC)
}

export function applyBoardFilter(
  tasks: readonly AgentTeamTask[],
  filter: BoardFilter
): AgentTeamTask[] {
  return applyFacetFilter(tasks, filter, BOARD_FILTER_SPEC)
}

/** Distinct filter options present in the current task set. */
export function collectFilterOptions(tasks: readonly AgentTeamTask[]): {
  tags: string[]
  assigneeIds: string[]
} {
  return {
    tags: collectFacetValues(tasks, (task) => task.tags),
    assigneeIds: collectFacetValues(tasks, ownerOf),
  }
}

export interface BoardColumn {
  status: TeamTaskStatus
  tasks: AgentTeamTask[]
}

/** All 8 columns in canonical order, each sorted for stable display. */
export function buildBoardColumns(tasks: readonly AgentTeamTask[]): BoardColumn[] {
  return BOARD_COLUMN_ORDER.map((status) => ({
    status,
    tasks: sortColumn(tasks.filter((t) => t.status === status)),
  }))
}

export interface BoardSwimlane {
  /** Teammate id, or null for the unassigned lane. */
  teammateId: string | null
  /** Display name (undefined for the unassigned lane — caller localizes). */
  name?: string
  /** The lane's twin binding, surfaced for the twin badge. */
  twinId?: string
  columns: BoardColumn[]
  taskCount: number
}

/**
 * Group tasks into per-teammate lanes (owner = claimedBy ?? assignedTo).
 * Lanes follow the teammates' roster order; an unassigned lane is appended
 * when any task has no owner. Empty lanes are dropped.
 */
export function buildSwimlanes(
  tasks: readonly AgentTeamTask[],
  teammates: readonly AgentTeammate[]
): BoardSwimlane[] {
  const byOwner = new Map<string | null, AgentTeamTask[]>()
  for (const t of tasks) {
    const owner = t.claimedBy ?? t.assignedTo ?? null
    const bucket = byOwner.get(owner) ?? []
    bucket.push(t)
    byOwner.set(owner, bucket)
  }

  const lanes: BoardSwimlane[] = []
  for (const mate of teammates) {
    const laneTasks = byOwner.get(mate.id)
    if (!laneTasks || laneTasks.length === 0) continue
    lanes.push({
      teammateId: mate.id,
      name: mate.name,
      ...(mate.config?.twinId ? { twinId: mate.config.twinId } : {}),
      columns: buildBoardColumns(laneTasks),
      taskCount: laneTasks.length,
    })
    byOwner.delete(mate.id)
  }
  // Tasks owned by ids not on the roster anymore fold into the unassigned lane.
  const orphaned = [...byOwner.values()].flat()
  if (orphaned.length > 0) {
    lanes.push({
      teammateId: null,
      columns: buildBoardColumns(orphaned),
      taskCount: orphaned.length,
    })
  }
  return lanes
}

export interface WipHint {
  /** Tasks currently claimed or in progress. */
  active: number
  /** Concurrent worker capacity (maxConcurrentTeammates, floor 1). */
  capacity: number
  /** True when active work exceeds what the team can actually run at once. */
  over: boolean
}

export function wipHint(tasks: readonly AgentTeamTask[], maxConcurrent: number): WipHint {
  const capacity = Math.max(1, Math.floor(maxConcurrent) || 1)
  const active = tasks.filter((t) => t.status === "claimed" || t.status === "in_progress").length
  return { active, capacity, over: active > capacity }
}

export interface DependencyLockInfo {
  /** True when at least one dependency is not completed yet. */
  locked: boolean
  /** The unfinished upstream tasks (id + title when resolvable). */
  blocking: Array<{ id: string; title?: string }>
}

export function dependencyLockInfo(
  task: Pick<AgentTeamTask, "dependencies">,
  tasksById: ReadonlyMap<string, AgentTeamTask>
): DependencyLockInfo {
  const blocking: Array<{ id: string; title?: string }> = []
  for (const depId of task.dependencies) {
    const dep = tasksById.get(depId)
    // Unknown ids are treated as satisfied (matches the runtime's ready-set
    // semantics: absent = satisfied outside this plan).
    if (!dep) continue
    if (dep.status !== "completed" && dep.status !== "cancelled") {
      blocking.push({ id: depId, title: dep.title })
    }
  }
  return { locked: blocking.length > 0, blocking }
}

// ── dnd drop reducer ────────────────────────────────────────────────────────

export type BoardDropAction =
  | { type: "move"; taskId: string; to: TeamTaskStatus; targetIndex: number }
  | { type: "reorder"; taskId: string; targetIndex: number }
  | { type: "denied"; taskId: string; reason: TaskMoveDenial }

/**
 * The shared reducer's rules for a Squad board. A column is one team's tasks:
 * `tasksById` may hold several teams, and a reorder never crosses into another
 * team's sequence.
 */
function teamDropRules(
  tasksById: ReadonlyMap<string, AgentTeamTask>,
  teamStatus: TeamStatus
): BoardDropRules<TeamTaskStatus, AgentTeamTask, TaskMoveDenial> {
  return {
    itemsById: tasksById,
    idOf: (task) => task.id,
    statusOf: (task) => task.status,
    columnOf: (task, status) =>
      sortColumn(
        [...tasksById.values()].filter((t) => t.teamId === task.teamId && t.status === status)
      ),
    canMove: (task, from, to) => canMoveTask(task, from, to, teamStatus),
  }
}

/**
 * Resolve a dnd-kit drag-end into a board action, or null for a no-op.
 * Dropping on a card in the same column → reorder to that card's index;
 * dropping on another column (or a card inside it) → guarded move.
 */
export function resolveDrop(
  activeId: string | null,
  overId: string | null,
  tasksById: ReadonlyMap<string, AgentTeamTask>,
  teamStatus: TeamStatus
): BoardDropAction | null {
  const action = resolveBoardDrop(activeId, overId, teamDropRules(tasksById, teamStatus))
  if (!action) return null
  switch (action.type) {
    case "move":
      return { type: "move", taskId: action.itemId, to: action.to, targetIndex: action.targetIndex }
    case "reorder":
      return { type: "reorder", taskId: action.itemId, targetIndex: action.targetIndex }
    case "denied":
      return { type: "denied", taskId: action.itemId, reason: action.reason }
  }
}

/**
 * Where the dragged task would land right now, for the cross-column insertion
 * indicator. Null where the guard refuses it, the same rule that greys the
 * column out.
 */
export function resolveDropPreview(
  activeId: string | null,
  overId: string | null,
  tasksById: ReadonlyMap<string, AgentTeamTask>,
  teamStatus: TeamStatus
): BoardDropPreview<TeamTaskStatus> | null {
  return resolveBoardDropPreview(activeId, overId, teamDropRules(tasksById, teamStatus))
}

/** The issue a Squad task was dispatched from, as stamped by the issue run adapter. */
export interface TaskOriginIssue {
  issueId: string
  /** Printed identifier (`MERC-2`), when the adapter recorded one. */
  identifier?: string
}

/**
 * Distinct originating issues across a board's tasks, in first-seen order.
 *
 * `lib/issues/run/agent-team-adapter.ts` writes `metadata.issueId` and
 * `metadata.issueIdentifier` on the task it appends. Tasks the team made for
 * itself carry neither and contribute nothing.
 */
export function originIssuesOfTasks(tasks: readonly AgentTeamTask[]): TaskOriginIssue[] {
  const seen = new Map<string, TaskOriginIssue>()
  for (const task of tasks) {
    const issueId = task.metadata?.issueId
    if (typeof issueId !== "string" || !issueId || seen.has(issueId)) continue
    const identifier = task.metadata?.issueIdentifier
    seen.set(issueId, {
      issueId,
      ...(typeof identifier === "string" && identifier ? { identifier } : {}),
    })
  }
  return [...seen.values()]
}
