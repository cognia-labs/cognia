import type { CreateScheduledTaskInput, TaskExecution } from "@/types/scheduler"
import type { AgentTask } from "@/types/agent/agent-task"
import {
  type AgentTaskMoveOptions,
  bindAgentTaskSchedule,
  getAgentTask,
  moveAgentTask,
  reconcileAgentTaskAttempts,
} from "@/lib/db/agent-tasks"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { guardAgentTaskMove, type AgentTaskMoveDenial } from "./state-machine"

/** A person-initiated move the guard refused, carrying the guard's reason. */
export class AgentTaskMoveDeniedError extends Error {
  readonly reason: AgentTaskMoveDenial

  constructor(reason: AgentTaskMoveDenial) {
    super(`Agent task move denied: ${reason}`)
    this.name = "AgentTaskMoveDeniedError"
    this.reason = reason
  }
}

export interface AgentTaskRuntimeDeps {
  now: () => number
  getTask: (taskId: string) => Promise<AgentTask | undefined>
  bindSchedule: (taskId: string, scheduledTaskId: string, now: number) => Promise<unknown>
  moveTask: (
    taskId: string,
    status: AgentTask["status"],
    now: number,
    options?: AgentTaskMoveOptions
  ) => Promise<unknown>
  createTask: (input: CreateScheduledTaskInput) => Promise<{ id: string }>
  runTaskNow: (taskId: string) => Promise<unknown>
  /**
   * Start the scheduled task and resolve once the Scheduler accepted it —
   * running, or buffered behind a running execution — with no wait for the
   * work. Rejects when the start ended without running (skipped) or the
   * Scheduler refused.
   */
  startTaskNow: (taskId: string) => Promise<AgentTaskStart>
  pauseTask: (taskId: string) => Promise<boolean>
  pauseTaskIfIdle: (taskId: string) => Promise<boolean>
  resumeTask: (taskId: string) => Promise<boolean>
  deleteTask: (taskId: string) => Promise<boolean>
  getExecution: (executionId: string) => Promise<TaskExecution | null>
  reconcile: typeof reconcileAgentTaskAttempts
}

/** What the Scheduler said when it accepted an agent task's start. */
export interface AgentTaskStart {
  executionId: string
  /** `running` when it started now, `queued` when buffered behind another run. */
  status: "running" | "queued"
}

export async function ensureAgentTaskSchedule(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<string> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  if (task.scheduledTaskId) return task.scheduledTaskId
  const runAt = new Date(task.scheduledFor ?? deps.now() + 10 * 365 * 24 * 60 * 60 * 1_000)
  const scheduled = await deps.createTask({
    name: task.title,
    description: task.description,
    type: "agent",
    trigger: { type: "once", runAt },
    payload: {
      prompt: task.description || task.title,
      characterId: task.agentId,
      agentTaskId: task.id,
      sessionTitle: task.title,
    },
    config: {
      overlapPolicy: "skip",
      allowConcurrent: false,
      maxRuns: task.scheduledFor ? 1 : undefined,
    },
    createdBy: { kind: "agent" },
    tags: ["agent-task", task.agentId, ...task.tags],
  })
  await deps.bindSchedule(task.id, scheduled.id, deps.now())
  return scheduled.id
}

export async function runAgentTaskNow(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<unknown> {
  const deps = providedDeps ?? defaultDeps()
  const scheduledTaskId = await ensureAgentTaskSchedule(taskId, deps)
  const execution = await deps.runTaskNow(scheduledTaskId)
  if (!execution) throw new Error("Agent task Scheduler execution did not start")
  return execution
}

/**
 * Start an agent task and return as soon as the Scheduler accepted it.
 *
 * `runAgentTaskNow` resolves with the SETTLED execution, which can take as
 * long as the task's timeout. A caller that only needs to know the task is
 * on its way (the issue run bridge, which owns the issue's column from the
 * moment the engine accepts) uses this instead and watches the task row for
 * the outcome.
 */
export async function startAgentTaskNow(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<AgentTaskStart> {
  const deps = providedDeps ?? defaultDeps()
  const scheduledTaskId = await ensureAgentTaskSchedule(taskId, deps)
  return deps.startTaskNow(scheduledTaskId)
}

/**
 * Bridge the Scheduler's settle-time `runTaskNow` to an accept-time answer
 * through its `onAccepted` hook. Exported for its own test.
 */
export function acceptedStart(
  runTaskNow: (
    taskId: string,
    opts: { onAccepted: (execution: TaskExecution) => void }
  ) => Promise<TaskExecution | null>,
  taskId: string
): Promise<AgentTaskStart> {
  return new Promise<AgentTaskStart>((resolve, reject) => {
    let answered = false
    const answer = (start: AgentTaskStart) => {
      if (answered) return
      answered = true
      resolve(start)
    }
    runTaskNow(taskId, {
      onAccepted: (execution) => answer({ executionId: execution.id, status: "running" }),
    })
      .then((execution) => {
        if (answered) return
        // No `onAccepted`: the start ended without running, or it was buffered.
        if (execution && execution.status === "pending") {
          answer({ executionId: execution.id, status: "queued" })
          return
        }
        if (execution && execution.status !== "skipped") {
          answer({ executionId: execution.id, status: "running" })
          return
        }
        answered = true
        reject(new Error("Agent task Scheduler execution did not start"))
      })
      .catch((error: unknown) => {
        if (answered) return
        answered = true
        reject(error)
      })
  })
}

/**
 * Load the task and refuse before any side effect when a person may not move
 * it to `to` from where it is NOW, so a stale button or a phone acting on an
 * old snapshot never pauses or deletes a Scheduler task and then fails the
 * status write.
 */
async function loadMovableTask(
  taskId: string,
  to: AgentTask["status"],
  deps: AgentTaskRuntimeDeps
): Promise<AgentTask> {
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  const verdict = guardAgentTaskMove(task.status, to)
  if (!verdict.allowed) throw new AgentTaskMoveDeniedError(verdict.reason)
  return task
}

export async function pauseAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  return applyAgentTaskMove(taskId, "paused", providedDeps)
}

export async function resumeAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  return applyAgentTaskMove(taskId, "pending", providedDeps)
}

export async function cancelAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  return applyAgentTaskMove(taskId, "cancelled", providedDeps)
}

export class AgentTaskScheduleActionError extends Error {
  constructor(readonly action: "pause" | "resume" | "cancel") {
    super(`Agent task Scheduler refused to ${action}`)
    this.name = "AgentTaskScheduleActionError"
  }
}

/**
 * One move door for the board, verdict buttons and paired clients. Scheduler
 * refusal cannot change the card's status. Placement is committed with status.
 */
export async function applyAgentTaskMove(
  taskId: string,
  to: AgentTask["status"],
  providedDeps?: AgentTaskRuntimeDeps,
  targetIndex?: number
): Promise<void> {
  const deps = providedDeps ?? defaultDeps()
  const task = await loadMovableTask(taskId, to, deps)
  if (task.status === to) return
  const scheduleId = task.scheduledTaskId
  const resuming = to === "pending" && task.status === "paused" && scheduleId !== undefined
  if (scheduleId && to === "paused" && !(await deps.pauseTask(scheduleId))) {
    throw new AgentTaskScheduleActionError("pause")
  }
  if (scheduleId && to === "cancelled" && !(await deps.deleteTask(scheduleId))) {
    throw new AgentTaskScheduleActionError("cancel")
  }
  if (resuming) {
    const compensate = async (error: unknown): Promise<never> => {
      // Only disarm a failed handoff that is still paused. Never stop a new run.
      if ((await deps.getTask(taskId))?.status === "paused") {
        try {
          await deps.pauseTaskIfIdle(scheduleId)
        } catch (compensationError) {
          throw new AggregateError(
            [error, compensationError],
            "Agent task resume compensation failed"
          )
        }
      }
      throw error
    }
    let accepted: boolean
    try {
      accepted = await deps.resumeTask(scheduleId)
    } catch (error) {
      return compensate(error)
    }
    if (!accepted) throw new AgentTaskScheduleActionError("resume")
    try {
      await deps.moveTask(taskId, to, deps.now(), {
        expectedStatus: "paused",
        ...(targetIndex === undefined ? {} : { targetIndex }),
      })
    } catch (error) {
      return compensate(error)
    }
    return
  }
  if (targetIndex === undefined) await deps.moveTask(taskId, to, deps.now())
  else await deps.moveTask(taskId, to, deps.now(), { targetIndex })
}

export function reconcileAgentTaskRuntime(
  providedDeps?: AgentTaskRuntimeDeps
): Promise<{ interrupted: string[]; settled: string[] }> {
  const deps = providedDeps ?? defaultDeps()
  return deps.reconcile(async (executionId) => {
    const execution = await deps.getExecution(executionId)
    if (!execution) return null
    return {
      status: execution.status === "skipped" ? "cancelled" : execution.status,
      output: execution.output,
      error: execution.error,
    }
  }, deps.now())
}

function defaultDeps(): AgentTaskRuntimeDeps {
  const scheduler = getTaskScheduler()
  return {
    now: Date.now,
    getTask: getAgentTask,
    bindSchedule: bindAgentTaskSchedule,
    moveTask: moveAgentTask,
    createTask: (input) => scheduler.createTask(input),
    runTaskNow: (taskId) => scheduler.runTaskNow(taskId),
    startTaskNow: (taskId) => acceptedStart((id, opts) => scheduler.runTaskNow(id, opts), taskId),
    pauseTask: (taskId) => scheduler.pauseTask(taskId),
    pauseTaskIfIdle: (taskId) => scheduler.pauseTaskIfIdle(taskId),
    resumeTask: (taskId) => scheduler.resumeTask(taskId),
    deleteTask: (taskId) => scheduler.deleteTask(taskId),
    getExecution: (executionId) => schedulerDb.getExecution(executionId),
    reconcile: reconcileAgentTaskAttempts,
  }
}
