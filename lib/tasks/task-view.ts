/**
 * One view model for every task list the chat UI draws.
 *
 * Three producers write task lists with their own vocabularies:
 *
 *   - the agent's own bookkeeping (`TodoWrite` snapshots, or the incremental
 *     `TaskCreate` / `TaskUpdate` / `TaskList` tools) — `lib/chat/session-tasks.ts`;
 *   - ADR-0045 plan steps (`AgentPlan.steps`) — {@link planStepsToTaskItems};
 *   - ACP agents' plan entries — {@link acpEntriesToTaskItems}.
 *
 * Storage stays separate (they mean different things: a turn's scratch list vs
 * an approved execution contract). What is shared is how they read: each
 * producer adapts into {@link TaskViewItem}, and `components/tasks/` renders
 * that one shape. Pure, no React, no I/O.
 */

import type { AgentPlan, PlanStepStatus } from "@/types/agent/plan"
import type { AcpPlanEntry } from "@/types/agent/external-agent"

/**
 * Display status. A superset of every producer's vocabulary, plus `stopped`:
 * an item still marked in progress after the run that owned it has ended
 * (interrupted, failed, or the app reloaded). `stopped` is derived for display
 * only and never written back to any store.
 */
export type TaskViewStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "blocked"
  | "stopped"

export const TASK_VIEW_STATUSES: readonly TaskViewStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "blocked",
  "stopped",
]

export interface TaskViewItem {
  /** Stable when the producer has ids; positional otherwise. */
  id: string
  title: string
  /** Present-continuous label shown while the item is in progress. */
  activeForm?: string
  status: TaskViewStatus
  /** Secondary line, e.g. why a plan step failed. */
  detail?: string
}

/** Statuses that count as done for progress (nothing left to do on them). */
const SETTLED: ReadonlySet<TaskViewStatus> = new Set(["completed", "skipped", "cancelled"])

export function isSettledTaskStatus(status: TaskViewStatus): boolean {
  return SETTLED.has(status)
}

export interface TaskProgress {
  done: number
  total: number
  /** 0..1; 0 for an empty list. */
  fraction: number
  /** The item in progress (or stopped), else the next pending one; null when none is open. */
  current: TaskViewItem | null
  /** Every item settled and none failed. */
  allDone: boolean
}

export function summarizeTasks(items: readonly TaskViewItem[]): TaskProgress {
  const done = items.filter((item) => isSettledTaskStatus(item.status)).length
  const total = items.length
  const current =
    items.find((item) => item.status === "in_progress" || item.status === "stopped") ??
    items.find((item) => item.status === "pending" || item.status === "blocked") ??
    null
  return {
    done,
    total,
    fraction: total > 0 ? done / total : 0,
    current,
    allDone: total > 0 && done === total,
  }
}

/** The label a row shows: the active form while the item runs. */
export function taskItemLabel(item: TaskViewItem): string {
  return item.status === "in_progress" && item.activeForm ? item.activeForm : item.title
}

/**
 * Mark items still `in_progress` as `stopped` when the run that owns them is
 * not running. Returns the input array unchanged when nothing changes.
 */
export function withStoppedItems(
  items: readonly TaskViewItem[],
  running: boolean
): readonly TaskViewItem[] {
  if (running || !items.some((item) => item.status === "in_progress")) return items
  return items.map((item) =>
    item.status === "in_progress" ? { ...item, status: "stopped" as const } : item
  )
}

const PLAN_STEP_STATUS: Record<PlanStepStatus, TaskViewStatus> = {
  pending: "pending",
  // `ready` only means "dependencies met"; to a reader it is still not started.
  ready: "pending",
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
  blocked: "blocked",
}

export function planStepStatusToTask(status: PlanStepStatus): TaskViewStatus {
  return PLAN_STEP_STATUS[status] ?? "pending"
}

/** A plan's steps in execution order, as task items. */
export function planStepsToTaskItems(plan: Pick<AgentPlan, "steps">): TaskViewItem[] {
  return [...plan.steps]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      id: step.id,
      title: step.title,
      status: planStepStatusToTask(step.status),
      ...(step.status === "failed" && step.error ? { detail: step.error } : {}),
    }))
}

export function acpStatusToTask(status: AcpPlanEntry["status"]): TaskViewStatus {
  return status === "completed" || status === "in_progress" || status === "skipped"
    ? status
    : "pending"
}

/** ACP plan entries, as task items (ACP has no ids, so they are positional). */
export function acpEntriesToTaskItems(entries: readonly AcpPlanEntry[]): TaskViewItem[] {
  return entries.map((entry, index) => ({
    id: `acp-${index}`,
    title: entry.content,
    status: acpStatusToTask(entry.status),
  }))
}
