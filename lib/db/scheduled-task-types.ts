import type { DBScheduledTask as ContractScheduledTaskRow } from "@cognia/plugin-contract/lib/db/scheduled-task-types"

/**
 * A stored task row: the contract's shape plus scheduler state that only this
 * host reads.
 *
 * `pendingStarts` (JSON, non-indexed) holds the starts the scheduler has
 * accepted for the task but not begun: slots claimed with their cursor and
 * retries it has scheduled (`lib/scheduler/pending-starts.ts`). It lives on the
 * task row, not in `scheduledTaskRuns`, because the task row is what every
 * host keeps across a restart (a headless brain does not snapshot the runs
 * table) and because a claim must commit in the same transaction as the
 * cursor it advances. `ScheduledTask` does not carry it, so a plugin and a
 * task export (`exportTasks`) never see it; a backup copies raw rows, and its
 * restore drops the column (`lib/data/apply-package.ts`).
 */
export interface DBScheduledTask extends ContractScheduledTaskRow {
  pendingStarts?: string
}

/** One execution attempt of a scheduled task, as persisted. */
export interface DBTaskExecution {
  id: string
  taskId: string
  taskName: string
  taskType: string
  status: string
  input?: string // JSON serialized
  output?: string // JSON serialized
  error?: string
  retryAttempt: number
  duration?: number
  scheduledFor?: string // ISO date string
  triggerSource?: string
  terminalReason?: string
  retryScheduledAt?: string // ISO date string
  startedAt: string // ISO date string
  completedAt?: string // ISO date string
  logs: string // JSON serialized TaskExecutionLog[]
  phases?: string // JSON serialized TaskExecutionPhase[] (non-indexed)
  /**
   * `"queued"` on the placeholder row of a start an overlap policy or the
   * host cap is holding back. The row is replaced when the start runs or is
   * dropped, and a restart settles a left-over one as `interrupted-on-restart`.
   * Absent on every row whose start has happened.
   */
  dispatch?: "queued"
}
