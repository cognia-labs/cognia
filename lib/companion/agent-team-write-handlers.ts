/**
 * TS dispatch arms for the Agent-Team board control RPCs (team-board CQRS).
 *
 * The mobile board is a read-only mirror of Dexie `agentTeamBoard` (v104);
 * these handlers are its write path back into the desktop's
 * agent-team-store — the single write source. Every move revalidates
 * through the SAME `canMoveTask` guard as the desktop kanban (the store's
 * `moveTask` applies it), so a phone can never push a transition the
 * desktop UI would refuse. Denials are normal `{ ok: false, reason }`
 * results, not thrown errors — the caller renders them as toasts.
 *
 * Wired into `dispatchCommand` in `lib/companion/desktop-write-source.ts`.
 * The Rust side gates these commands behind the remote-control
 * capability (`CONTROL_COMMANDS` in `companion_api/rpc.rs`).
 *
 * `team_run_start` is the odd one out and arrived last. For a long time a
 * phone could pause, resume and stop a Squad but never start one, which is a
 * remote control with a brake and no accelerator. It goes through
 * `startSquadRun`, the one launch seam (ADR-0140, hardened by ADR-0169), so a
 * phone-started run gets the same readiness check, run id convention and
 * execution row as one started from the desktop.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { loggers } from "@cognia/logging"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import type { TeamTaskStatus } from "@/types/agent/agent-team"

const log = loggers.agent.child("team-rpc")

export interface TeamCommandResult {
  ok: boolean
  reason?: string
  taskId?: string
  commentId?: string
  /** Present when starting produced one, so a phone can follow the run. */
  runId?: string
}

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "blocked",
  "claimed",
  "in_progress",
  "review",
  "completed",
  "failed",
  "cancelled",
])

const PRIORITIES: ReadonlySet<string> = new Set(["critical", "high", "normal", "low", "background"])

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function taskInTeam(teamId: string, taskId: string) {
  const task = useAgentTeamStore.getState().tasks[taskId]
  return task && task.teamId === teamId ? task : null
}

export async function handleTeamTaskMove(
  payload: Record<string, unknown>
): Promise<TeamCommandResult> {
  const teamId = readString(payload, "teamId")
  const taskId = readString(payload, "taskId")
  const to = readString(payload, "to")
  if (!teamId || !taskId || !to) return { ok: false, reason: "invalid-payload" }
  if (!TASK_STATUSES.has(to)) return { ok: false, reason: "invalid-status" }
  if (!taskInTeam(teamId, taskId)) return { ok: false, reason: "task-not-found" }
  // moveTask re-runs canMoveTask against the LIVE team status — the phone's
  // snapshot may be stale, so the guard here is authoritative.
  const result = useAgentTeamStore.getState().moveTask(taskId, to as TeamTaskStatus)
  return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "denied" }
}

export async function handleTeamTaskCreate(
  payload: Record<string, unknown>
): Promise<TeamCommandResult> {
  const teamId = readString(payload, "teamId")
  const title = readString(payload, "title")
  if (!teamId || !title) return { ok: false, reason: "invalid-payload" }
  const state = useAgentTeamStore.getState()
  if (!state.teams[teamId]) return { ok: false, reason: "team-not-found" }
  const priority = readString(payload, "priority")
  if (priority !== null && !PRIORITIES.has(priority)) {
    return { ok: false, reason: "invalid-priority" }
  }
  const assignedTo = readString(payload, "assignedTo")
  if (assignedTo && state.teammates[assignedTo]?.teamId !== teamId) {
    return { ok: false, reason: "assignee-not-on-team" }
  }
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((t): t is string => typeof t === "string")
    : []
  const task = state.createTask({
    teamId,
    title,
    description: readString(payload, "description") ?? title,
    ...(priority ? { priority: priority as SubAgentPriority } : {}),
    ...(assignedTo ? { assignedTo } : {}),
    tags,
  })
  log.info("team_task_create via companion", { teamId, taskId: task.id })
  return { ok: true, taskId: task.id }
}

export async function handleTeamTaskComment(
  payload: Record<string, unknown>
): Promise<TeamCommandResult> {
  const teamId = readString(payload, "teamId")
  const taskId = readString(payload, "taskId")
  const text = readString(payload, "text")
  if (!teamId || !taskId || !text) return { ok: false, reason: "invalid-payload" }
  if (!taskInTeam(teamId, taskId)) return { ok: false, reason: "task-not-found" }
  const comment = useAgentTeamStore.getState().addTaskComment({
    taskId,
    authorId: "user",
    text,
  })
  return comment ? { ok: true, commentId: comment.id } : { ok: false, reason: "empty-comment" }
}

// `handleTeamRunPause` / `handleTeamRunResume` / `handleTeamRunStop` were
// retired with ADR-0169. Run control is `execution_run_control`
// (`lib/companion/execution-run-control-handler.ts`), and the old
// team-addressed commands answer `upgrade-required`.

/**
 * Start a Squad from a paired device.
 *
 * Goes through `startSquadRun`, the one launch seam, which owns readiness,
 * the one-live-run rule and the transactional journal. A second start while a
 * run is open is refused as `already_running` with that run's id, so the phone
 * can follow it instead of forking a duplicate. Fire-and-forget: the seam
 * launches the lifecycle without awaiting it, so the RPC acks acceptance and
 * progress flows back through the board sync mirror.
 *
 * No `session`: a phone command is not a conversation on this host, so the run
 * is uncarded. `callerDeviceId` is stamped by Rust from the verified device JWT
 * before this arm ever sees the payload, never supplied by the client.
 */
export async function handleTeamRunStart(
  payload: Record<string, unknown>
): Promise<TeamCommandResult> {
  const teamId = readString(payload, "teamId")
  if (!teamId) return { ok: false, reason: "invalid-payload" }
  if (!useAgentTeamStore.getState().teams[teamId]) return { ok: false, reason: "team-not-found" }

  const goal = readString(payload, "goal")
  const deviceId = readString(payload, "callerDeviceId")
  const { startSquadRun } = await import("@/lib/ai/agent/team/squad/start-squad-run")
  const result = await startSquadRun({
    squadId: teamId,
    goal: goal ?? "",
    origin: "companion",
    triggeredFrom: { source: "api", ...(deviceId ? { deviceId } : {}) },
  }).catch((err) => {
    log.warn("team_run_start dispatch failed", { teamId, err: String(err) })
    return { started: false, reason: "dispatch_error" as const, runId: undefined }
  })
  if (!result.started) {
    return {
      ok: false,
      reason: result.reason ?? "dispatch_error",
      ...(result.runId ? { runId: result.runId } : {}),
    }
  }
  return { ok: true, ...(result.runId ? { runId: result.runId } : {}) }
}
