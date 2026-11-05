import type { CreateScheduledTaskInput, TaskExecution } from "@/types/scheduler"
import type { AgentTask } from "@/types/agent/agent-task"
import {
  bindAgentTaskSchedule,
  getAgentTask,
  moveAgentTask,
  reconcileAgentTaskAttempts,
} from "@/lib/db/agent-tasks"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"

export interface AgentTaskRuntimeDeps {
  now: () => number
  getTask: (taskId: string) => Promise<AgentTask | undefined>
  bindSchedule: (taskId: string, scheduledTaskId: string, now: number) => Promise<unknown>
  moveTask: (taskId: string, status: AgentTask["status"], now: number) => Promise<unknown>
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

export async function pauseAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  if (task.scheduledTaskId) await deps.pauseTask(task.scheduledTaskId)
  await deps.moveTask(taskId, "paused", deps.now())
}

export async function resumeAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  await deps.moveTask(taskId, "pending", deps.now())
  if (task.scheduledTaskId) await deps.resumeTask(task.scheduledTaskId)
}

export async function cancelAgentTask(
  taskId: string,
  providedDeps?: AgentTaskRuntimeDeps
): Promise<void> {
  const deps = providedDeps ?? defaultDeps()
  const task = await deps.getTask(taskId)
  if (!task) throw new Error("Agent task not found")
  if (task.scheduledTaskId) await deps.deleteTask(task.scheduledTaskId)
  await deps.moveTask(taskId, "cancelled", deps.now())
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
    resumeTask: (taskId) => scheduler.resumeTask(taskId),
    deleteTask: (taskId) => scheduler.deleteTask(taskId),
    getExecution: (executionId) => schedulerDb.getExecution(executionId),
    reconcile: reconcileAgentTaskAttempts,
  }
}
