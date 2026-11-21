/**
 * Starts a task has been promised but has not begun.
 *
 * Two kinds, both written to the task row's host-only `pendingStarts` column
 * (`DBScheduledTask.pendingStarts`) so they outlive the process that made the
 * promise:
 *
 * - A **slot claim** is written by `claimTaskSlot` in the same transaction that
 *   advances the cursor and spends the run budget. Before it existed, a process
 *   that stopped between that commit and the execution row lost the slot: the
 *   cursor had moved past it, so neither a restart nor the missed-run sweep
 *   would ever run it.
 * - A **retry** is written when a failed attempt schedules its next one. The
 *   timer that runs it is in memory; the entry is what lets a restarted
 *   scheduler arm it again instead of forgetting it.
 *
 * An entry is consumed in the transaction that writes the row its start
 * produced (`SchedulerDatabase.createExecution`), whether that start ran or
 * was settled without running. A start that has begun is therefore never
 * replayed by a restart: its row says how far it got.
 */
import type { ScheduledTask, TaskExecutionTerminalReason } from "@/types/scheduler"
import { isOwnedElsewhere } from "@/lib/placement/ownership"
import { isSlotOutsideCatchupWindow } from "./runtime-policy"

/** A slot claimed with its cursor whose start has not begun. */
export interface PendingSlotClaim {
  kind: "slot"
  /** The slot's occurrence id, which the start's row will carry. */
  executionId: string
  scheduledFor: Date
  triggerSource: "schedule" | "catch-up"
  /** A catch-up replay leaves the cursor to the sweep that claimed it. */
  deferNextRunUpdate?: boolean
  claimedAt: Date
}

/** A retry a failed attempt scheduled and that has not begun. */
export interface PendingRetry {
  kind: "retry"
  /** Chosen when the retry is scheduled, so the run it becomes is known. */
  executionId: string
  failedExecutionId: string
  /** Execution id of attempt 0 in this logical occurrence / retry chain. */
  originExecutionId?: string
  /** Original scheduled slot of attempt 0 when schedule-bound. */
  scheduledFor?: Date
  /** The retry's own attempt number (the failed one's plus one). */
  attempt: number
  availableAt: Date
  scheduledSlotClaimed?: boolean
  deferNextRunUpdate?: boolean
}

export type PendingStart = PendingSlotClaim | PendingRetry

/**
 * Entries kept per task. Every entry is consumed by the start it names, so a
 * task never comes near this; the bound only keeps a defect from growing a
 * row without limit. The oldest entries go first.
 */
export const MAX_PENDING_STARTS = 200

interface StoredSlotClaim {
  kind: "slot"
  executionId: string
  scheduledFor: string
  triggerSource: "schedule" | "catch-up"
  deferNextRunUpdate?: boolean
  claimedAt: string
}

interface StoredRetry {
  kind: "retry"
  executionId: string
  failedExecutionId: string
  originExecutionId?: string
  scheduledFor?: string
  attempt: number
  availableAt: string
  scheduledSlotClaimed?: boolean
  deferNextRunUpdate?: boolean
}

function isDate(value: Date): boolean {
  return !Number.isNaN(value.getTime())
}

function parseEntry(raw: unknown): PendingStart | null {
  if (!raw || typeof raw !== "object") return null
  const entry = raw as {
    kind?: unknown
    executionId?: unknown
    scheduledFor?: unknown
    triggerSource?: unknown
    deferNextRunUpdate?: unknown
    claimedAt?: unknown
    failedExecutionId?: unknown
    originExecutionId?: unknown
    attempt?: unknown
    availableAt?: unknown
    scheduledSlotClaimed?: unknown
  }
  if (typeof entry.executionId !== "string" || entry.executionId.length === 0) return null
  if (entry.kind === "slot") {
    if (entry.triggerSource !== "schedule" && entry.triggerSource !== "catch-up") return null
    const scheduledFor = new Date(String(entry.scheduledFor))
    const claimedAt = new Date(String(entry.claimedAt))
    if (!isDate(scheduledFor) || !isDate(claimedAt)) return null
    return {
      kind: "slot",
      executionId: entry.executionId,
      scheduledFor,
      triggerSource: entry.triggerSource,
      ...(entry.deferNextRunUpdate ? { deferNextRunUpdate: true } : {}),
      claimedAt,
    }
  }
  if (entry.kind === "retry") {
    const availableAt = new Date(String(entry.availableAt))
    const scheduledFor =
      typeof entry.scheduledFor === "string" ? new Date(entry.scheduledFor) : undefined
    if (
      typeof entry.failedExecutionId !== "string" ||
      typeof entry.attempt !== "number" ||
      !Number.isInteger(entry.attempt) ||
      entry.attempt < 1 ||
      !isDate(availableAt) ||
      (scheduledFor !== undefined && !isDate(scheduledFor))
    ) {
      return null
    }
    return {
      kind: "retry",
      executionId: entry.executionId,
      failedExecutionId: entry.failedExecutionId,
      ...(typeof entry.originExecutionId === "string" && entry.originExecutionId.length > 0
        ? { originExecutionId: entry.originExecutionId }
        : {}),
      ...(scheduledFor ? { scheduledFor } : {}),
      attempt: entry.attempt,
      availableAt,
      ...(entry.scheduledSlotClaimed ? { scheduledSlotClaimed: true } : {}),
      ...(entry.deferNextRunUpdate ? { deferNextRunUpdate: true } : {}),
    }
  }
  return null
}

/** The entries a stored column holds. Unreadable entries are dropped. */
export function parsePendingStarts(raw: string | undefined): PendingStart[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(parseEntry).filter((entry): entry is PendingStart => entry !== null)
}

/** The column for these entries; `undefined` (no column) when there are none. */
export function serializePendingStarts(starts: readonly PendingStart[]): string | undefined {
  if (starts.length === 0) return undefined
  const stored: Array<StoredSlotClaim | StoredRetry> = starts
    .slice(-MAX_PENDING_STARTS)
    .map((start) =>
      start.kind === "slot"
        ? {
            kind: "slot",
            executionId: start.executionId,
            scheduledFor: start.scheduledFor.toISOString(),
            triggerSource: start.triggerSource,
            ...(start.deferNextRunUpdate ? { deferNextRunUpdate: true } : {}),
            claimedAt: start.claimedAt.toISOString(),
          }
        : {
            kind: "retry",
            executionId: start.executionId,
            failedExecutionId: start.failedExecutionId,
            ...(start.originExecutionId ? { originExecutionId: start.originExecutionId } : {}),
            ...(start.scheduledFor ? { scheduledFor: start.scheduledFor.toISOString() } : {}),
            attempt: start.attempt,
            availableAt: start.availableAt.toISOString(),
            ...(start.scheduledSlotClaimed ? { scheduledSlotClaimed: true } : {}),
            ...(start.deferNextRunUpdate ? { deferNextRunUpdate: true } : {}),
          }
    )
  return JSON.stringify(stored)
}

/** The column with `start` added, replacing an entry for the same execution. */
export function withPendingStart(raw: string | undefined, start: PendingStart): string | undefined {
  const kept = parsePendingStarts(raw).filter((entry) => entry.executionId !== start.executionId)
  return serializePendingStarts([...kept, start])
}

/** The column without the entries `drop` selects. */
export function withoutPendingStarts(
  raw: string | undefined,
  drop: (start: PendingStart) => boolean
): string | undefined {
  return serializePendingStarts(parsePendingStarts(raw).filter((entry) => !drop(entry)))
}

export type RecoveredSlotDecision =
  | { run: true }
  | {
      run: false
      terminalReason: Extract<
        TaskExecutionTerminalReason,
        "missed-run-skipped" | "catchup-window-expired"
      >
      message: string
    }

/**
 * What a claimed slot that never began becomes when the scheduler starts again.
 *
 * Exactly what it would have become had it simply been missed. A slot whose
 * next one has not come yet runs, as an overdue slot armed on boot does. A
 * slot the schedule has since moved past is a backlog, and the task's missed
 * run policy decides: skipped unless `runMissedOnStartup`, and skipped when
 * it is older than `catchupWindowMs`.
 */
export function decideRecoveredSlot(input: {
  task: ScheduledTask
  claim: PendingSlotClaim
  now: Date
  /** The slot after a given one, under the task's trigger. */
  nextAfter: (slot: Date) => Date | undefined
}): RecoveredSlotDecision {
  const { task, claim, now } = input
  const following = input.nextAfter(claim.scheduledFor)
  if (!following || following.getTime() > now.getTime()) return { run: true }
  if (!task.config.runMissedOnStartup) {
    return {
      run: false,
      terminalReason: "missed-run-skipped",
      message:
        "Skipped: this slot was claimed but had not started when the scheduler stopped, and the task does not run missed slots",
    }
  }
  if (isSlotOutsideCatchupWindow(claim.scheduledFor, now, task.config.catchupWindowMs)) {
    return {
      run: false,
      terminalReason: "catchup-window-expired",
      message: `Skipped: this slot was claimed but had not started when the scheduler stopped, and it is older than the catch-up window (${task.config.catchupWindowMs}ms)`,
    }
  }
  return { run: true }
}

/**
 * The terminal reason for a start that will not begin because its task stopped
 * taking runs first: paused, disabled, expired, moved to another host or
 * deleted. Named after why the task stopped, so the run history reads the
 * same as the task's own state.
 */
export function withdrawnStartReason(task: ScheduledTask | null): TaskExecutionTerminalReason {
  if (!task) return "user-cancelled"
  if (isOwnedElsewhere(task.owner)) return "owned-elsewhere"
  if (task.status === "expired") {
    return task.lastTerminalReason === "max-runs-reached" ||
      task.lastTerminalReason === "once-expired"
      ? task.lastTerminalReason
      : "ended"
  }
  if (task.lastTerminalReason === "auto-paused" && task.status === "paused") return "auto-paused"
  return "user-cancelled"
}
