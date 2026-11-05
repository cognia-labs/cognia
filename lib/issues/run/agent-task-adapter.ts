/**
 * `agent` assignee → AgentTask (`lib/agent-tasks/runtime.ts`).
 *
 * The issue's `agent` assignee id is a `Character` id (see `IssueActor`), which
 * is exactly what `createAgentTask` needs. The adapter creates one AgentTask
 * per Run, tags it `issue:<id>` for the human eye, and hands it to the
 * scheduler-backed runtime. Completion is observed off the AgentTask row
 * (`review` / `completed` / `failed` / `cancelled`) — there is no agent-task
 * completion event bus, so `poll` is the truth and `install.ts` re-polls when
 * the `agentTasks` table changes.
 *
 * Every dependency is injectable so the adapter is unit-testable without the
 * scheduler.
 */

import type { AgentTask, AgentTaskAttempt } from "@/types/agent/agent-task"
import type { IssueRun, IssueRunArtifact } from "@/types/issues"
import { resolveCharacterById } from "@/lib/db/characters"
import { createAgentTask, getAgentTask, listAgentTaskAttempts } from "@/lib/db/agent-tasks"
import type {
  IssueRunAdapter,
  IssueRunDispatch,
  IssueRunPollResult,
  IssueRunStartContext,
  IssueRunTarget,
  IssueRunVerdict,
} from "./types"
import { issuePriorityToAgentTaskPriority } from "@/lib/issues/sources/agent-status-map"
import { withRunBrief } from "./types"

export const AGENT_TASK_RUN_ADAPTER_ID = "agent-task"

/** Chat session deep link — same query shape as `lib/chat/message-permalink.ts`. */
export function sessionHref(sessionId: string): string {
  return `/?session=${encodeURIComponent(sessionId)}`
}

export interface AgentTaskRunAdapterDeps {
  resolveCharacter: (id: string) => Promise<{ id: string; name: string } | undefined>
  createTask: typeof createAgentTask
  /** Resolves once the Scheduler accepted the start (`startAgentTaskNow`), not when it settles. */
  startTaskNow: (taskId: string) => Promise<{ status: "running" | "queued" }>
  cancelTask: (taskId: string) => Promise<void>
  getTask: (taskId: string) => Promise<AgentTask | undefined>
  listAttempts: (taskId: string) => Promise<AgentTaskAttempt[]>
  now: () => number
}

/**
 * `lib/agent-tasks/runtime.ts` pulls the scheduler (and its own Dexie
 * database) in at import time, so it is loaded lazily — the tracker must not
 * pay for the scheduler graph until someone actually presses Run.
 */
async function loadRuntime() {
  return import("@/lib/agent-tasks/runtime")
}

function defaultDeps(): AgentTaskRunAdapterDeps {
  return {
    resolveCharacter: resolveCharacterById,
    createTask: createAgentTask,
    startTaskNow: async (taskId) => (await loadRuntime()).startAgentTaskNow(taskId),
    cancelTask: async (taskId) => (await loadRuntime()).cancelAgentTask(taskId),
    getTask: getAgentTask,
    listAttempts: listAgentTaskAttempts,
    now: Date.now,
  }
}

/** The prompt an AgentTask carries: identifier + title, then the description. */
export function buildAgentTaskDescription(target: IssueRunTarget): string {
  const { issue, project } = target
  const lines = [`Issue ${issue.identifier}: ${issue.title}`]
  if (project?.description) lines.push("", `Project context: ${project.description}`)
  if (issue.description) lines.push("", issue.description)
  return lines.join("\n")
}

/** Artifacts an AgentTask attempt exposes: its chat session, if any. */
export function agentTaskArtifacts(attempts: readonly AgentTaskAttempt[]): IssueRunArtifact[] {
  const artifacts: IssueRunArtifact[] = []
  for (const attempt of attempts) {
    if (!attempt.sessionId) continue
    artifacts.push({
      label: `Session (attempt ${attempt.attemptNo})`,
      href: sessionHref(attempt.sessionId),
    })
  }
  return artifacts
}

export function createAgentTaskRunAdapter(
  overrides: Partial<AgentTaskRunAdapterDeps> = {}
): IssueRunAdapter {
  const deps: AgentTaskRunAdapterDeps = { ...defaultDeps(), ...overrides }

  async function canRun(target: IssueRunTarget): Promise<IssueRunVerdict> {
    const assignee = target.issue.assignee
    if (!assignee || assignee.kind !== "agent" || !assignee.id) {
      return { ok: false, reason: "assignee-kind-mismatch" }
    }
    const character = await deps.resolveCharacter(assignee.id)
    if (!character) return { ok: false, reason: "assignee-not-found", detail: assignee.id }
    return { ok: true }
  }

  return {
    id: AGENT_TASK_RUN_ADAPTER_ID,
    kind: "agent-task",
    canRun,
    async start(target: IssueRunTarget, context: IssueRunStartContext): Promise<IssueRunDispatch> {
      const verdict = await canRun(target)
      if (!verdict.ok) throw new Error(`agent-task adapter refused: ${verdict.reason}`)
      const { issue } = target
      const agentId = issue.assignee!.id!
      const task = await deps.createTask({
        agentId,
        projectId: issue.projectId,
        title: `${issue.identifier}: ${issue.title}`,
        description: withRunBrief(buildAgentTaskDescription(target), context.brief),
        priority: issuePriorityToAgentTaskPriority(issue.priority),
        tags: ["issue", `issue:${issue.id}`, issue.identifier],
        now: deps.now(),
      })
      // The scheduler accepting the task is the engine accepting the run. A
      // refusal throws through to the bridge, which settles the claim as
      // failed; the task it created is cancelled so it cannot start later on
      // its own and run with no issue run watching it.
      let accepted: { status: "running" | "queued" }
      try {
        accepted = await deps.startTaskNow(task.id)
      } catch (error) {
        await deps.cancelTask(task.id).catch(() => undefined)
        throw error
      }
      return { targetId: task.id, status: accepted.status }
    },
    async poll(run: IssueRun): Promise<IssueRunPollResult> {
      const task = await deps.getTask(run.targetId)
      if (!task) return { status: "failed", error: "agent task no longer exists" }
      switch (task.status) {
        case "completed":
        case "review": {
          const attempts = await deps.listAttempts(task.id)
          const latest = attempts.at(-1)
          return {
            status: "succeeded",
            ...(latest?.result ? { summary: latest.result.slice(0, 500) } : {}),
            artifacts: agentTaskArtifacts(attempts),
          }
        }
        case "failed": {
          const attempts = await deps.listAttempts(task.id)
          const latest = attempts.at(-1)
          return {
            status: "failed",
            error: latest?.errorMessage ?? latest?.errorCode ?? "agent task failed",
            artifacts: agentTaskArtifacts(attempts),
          }
        }
        case "cancelled":
          return { status: "cancelled" }
        case "in_progress":
          return run.status === "queued" ? { status: "running" } : null
        default:
          return null
      }
    },
    async cancel(run: IssueRun): Promise<void> {
      await deps.cancelTask(run.targetId)
    },
    // Every attempt runs in a chat session of its own. Only the ones still
    // executing can take a steer or be the caller of a check-in.
    async sessionIds(run: IssueRun): Promise<string[]> {
      const attempts = await deps.listAttempts(run.targetId)
      return attempts
        .filter((attempt) => attempt.sessionId && LIVE_ATTEMPT_STATUSES.has(attempt.status))
        .sort((a, b) => b.attemptNo - a.attemptNo)
        .map((attempt) => attempt.sessionId!)
    },
  }
}

/** Attempt states whose chat session is still executing. */
const LIVE_ATTEMPT_STATUSES: ReadonlySet<AgentTaskAttempt["status"]> = new Set([
  "queued",
  "running",
])
