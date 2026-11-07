/**
 * The one control state machine for a Squad run (ADR-0169, ADR-0252 §7.2).
 *
 * Every surface that pauses, resumes or stops a Squad run lands on
 * `controlSquadRun` here: the cockpit's control plane (`control-handlers.ts`),
 * the fleet inspector, the Settings panel, a paired phone's command, the CLI,
 * the connectors, the bot runtime and the issue tracker. A run may be named
 * by its id or by its team (the team's live run).
 *
 *   pause   cooperative. The coordinator stops admitting children and each
 *           one checkpoints at its next safe boundary. Resumable.
 *   resume  continues from the latest VERIFIED SAFE checkpoint only. A live
 *           lifecycle is simply unpaused. A lifecycle that exited (restart,
 *           earlier abort) is re-entered over the remaining work. The guards
 *           a resume must pass (legacy runs, the authority snapshot, the
 *           replay gate, readiness) are `squad-control.ts`; a run that fails
 *           one is parked on a `team_recovery` decision, never replayed.
 *   stop    terminal. Aborts the in-process lifecycle, cascades to every
 *           child and denies every pending interrupt. Not resumable.
 *   retry   creates a linked replacement run through `startSquadRun`. The
 *           settled history is never touched (see `run-control.ts`).
 *   steer   queues durable receipts through the coordinator, which owns the
 *           PII gate for the text (`steerDurableRun`).
 *
 * `controlDurableRun` is the machine's coordinator step: the persisted
 * transition and the cascade to children. Only the machine itself, a Squad
 * lifecycle settling its own abort, and a durable record that is not a Squad
 * run (a best-of-N group) call it directly.
 *
 * Everything requested and everything that resulted is persisted, so another
 * renderer projects the same outcome.
 */

import { childStopProof, isChildSettled } from "@cognia/agent-orchestration/replay"
import {
  appendAgentTeamTrajectory,
  getAgentTeamRun,
  settleAgentTeamRunIfCurrent,
  listAgentTeamChildRuns,
  updateAgentTeamRunIfCurrent,
  updateAgentTeamChildRunIfCurrent,
} from "@/lib/db/agent-team-runtime"
import { getExecutionRun, runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import { isTerminalRunStatus } from "@/types/execution/run"
import type { AgentTeamRunStatus } from "@/types/agent/agent-team-runtime"
import { getDurableTeamCoordinator, type DurableTeamCoordinator } from "./durable-runtime"
import { isTerminalTeamStatus } from "@cognia/agent-orchestration/rules"
import { guardSquadRunResume, type SquadResumeGuardDeps } from "../squad/squad-control"

export type DurableRunControlAction = "pause" | "resume" | "sleep" | "wake" | "stop" | "terminate"

export interface DurableRunControlOptions {
  coordinator?: DurableTeamCoordinator
  now?: () => number
}

/**
 * The coordinator step of the machine: the persisted transition and the
 * cascade to children. Provider handles stay process-local; every requested
 * and resulting state is persisted so another renderer can project the same
 * control outcome. Throws `stop_unconfirmed` when a child could not be
 * proven stopped or paused.
 */
export async function controlDurableRun(
  runId: string,
  action: DurableRunControlAction,
  options: DurableRunControlOptions = {}
): Promise<void> {
  const coordinator = options.coordinator ?? getDurableTeamCoordinator()
  const now = options.now ?? Date.now
  const run = await getAgentTeamRun(runId)
  if (!run) throw new Error(`Unknown durable AgentTeam run: ${runId}`)
  if (isTerminalTeamStatus(run.status)) return
  const at = now()
  if (action === "stop" || action === "terminate") {
    const children = await listAgentTeamChildRuns(runId)
    const epoch = Math.max(0, ...children.map((child) => child.dispatchEpoch ?? 0))
    const requested = {
      status: run.status,
      stop: { state: "requested", action, epoch, requestedAt: at },
      updatedAt: at,
    } as const
    // Child lookup must not let a late stop replace a completed publication.
    if (!(await updateAgentTeamRunIfCurrent(runId, run, requested))) return
    coordinator.setRunPaused(runId, true)
    const operations = await Promise.allSettled(
      children
        .filter((child) => !isChildSettled(child) && !childStopProof(child, now()))
        .map(async (child) => {
          try {
            await coordinator.terminateChild(child.id)
          } catch (error) {
            await updateAgentTeamChildRunIfCurrent(child.id, child, {
              stop: { state: "unconfirmed", epoch: child.dispatchEpoch ?? 0, requestedAt: at },
              status: "needs_input",
              waitingReason: "stop_unconfirmed",
              updatedAt: now(),
            })
            throw error
          }
        })
    )
    const latest = await listAgentTeamChildRuns(runId)
    let confirmed = latest.every((child) => isChildSettled(child) || !!childStopProof(child, now()))
    if (confirmed) {
      const settled = await settleAgentTeamRunIfCurrent(runId, requested, {
        status: action === "stop" ? "cancelled" : "terminated",
        completedAt: now(),
        stop: { state: "confirmed", epoch, requestedAt: at, action },
        updatedAt: now(),
      })
      if (settled === undefined) return
      confirmed = settled === "cancelled" || settled === "terminated"
    } else {
      if (
        !(await updateAgentTeamRunIfCurrent(runId, requested, {
          status: "needs_input",
          recoveryReason: "stop_unconfirmed",
          completedAt: undefined,
          stop: { state: "unconfirmed", action, epoch, requestedAt: at },
          updatedAt: now(),
        }))
      )
        return
    }
    await appendAgentTeamTrajectory({
      runId,
      kind: "run_controlled",
      correlationId: `run-control:${runId}:${at}`,
      payload: { action, childCount: children.length, confirmed },
      createdAt: now(),
    })
    if (!confirmed)
      throw new AggregateError(
        operations.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        "stop_unconfirmed"
      )
    return
  }
  const children = (await listAgentTeamChildRuns(runId)).filter((child) => !isChildSettled(child))
  const requestedStatus: AgentTeamRunStatus =
    action === "pause" ? "pausing" : action === "sleep" ? "sleeping" : run.status
  const requested = { status: requestedStatus, updatedAt: at, stop: run.stop }
  if (!(await updateAgentTeamRunIfCurrent(runId, run, requested))) return
  if (action === "pause" || action === "sleep") coordinator.setRunPaused(runId, true)
  const operation =
    action === "pause"
      ? coordinator.pauseChild
      : action === "resume"
        ? coordinator.resumeChild
        : action === "sleep"
          ? coordinator.sleepChild
          : coordinator.wakeChild
  await Promise.all(children.map((child) => operation(child.id)))
  const latest = await listAgentTeamChildRuns(runId)
  if (
    latest.some(
      (child) =>
        child.status === "needs_input" &&
        ["stop_unconfirmed", "pause_unconfirmed"].includes(child.waitingReason ?? "")
    )
  ) {
    if (
      !(await updateAgentTeamRunIfCurrent(runId, requested, {
        status: "needs_input",
        recoveryReason: "stop_unconfirmed",
        updatedAt: now(),
      }))
    )
      return
    throw new Error("stop_unconfirmed")
  }
  const finalStatus: AgentTeamRunStatus =
    action === "pause" ? "paused" : action === "sleep" ? "sleeping" : "running"
  if (
    !(await updateAgentTeamRunIfCurrent(runId, requested, {
      status: finalStatus,
      ...(["resume", "wake"].includes(action) ? { stop: undefined } : {}),
      updatedAt: now(),
    }))
  )
    return
  if (action === "resume" || action === "wake") coordinator.setRunPaused(runId, false)
  await appendAgentTeamTrajectory({
    runId,
    kind: "run_controlled",
    correlationId: `run-control:${runId}:${at}`,
    payload: { action, childCount: children.length },
    createdAt: now(),
  })
}

export type SquadControlAction = "pause" | "resume" | "stop"

/** A Squad run by its id, or a team by its live run. */
export type SquadControlTarget = { runId: string } | { teamId: string }

export type SquadControlRefusal =
  | "run_not_found"
  | "already_terminal"
  | "not_pausable"
  | "not_resumable"
  /** A checkpoint or a stop is not verified. A `team_recovery` decision is required. */
  | "recovery_required"

export interface SquadControlResult {
  ok: boolean
  reason?: SquadControlRefusal
  status?: AgentTeamRunStatus
}

const PAUSABLE: ReadonlySet<AgentTeamRunStatus> = new Set(["queued", "running", "recovering"])
const RESUMABLE: ReadonlySet<AgentTeamRunStatus> = new Set([
  "recovering",
  "paused",
  "pausing",
  "sleeping",
  "needs_input",
])

export interface SquadControlDeps {
  now?: () => number
  /** The coordinator the machine's step drives (the shared one by default). */
  coordinator?: DurableTeamCoordinator
  /** Re-enter the lifecycle over the remaining work (the resume path). */
  reenter?: (input: { teamId: string; runId: string }) => Promise<unknown>
  /** Whether a lifecycle for this run is alive in this process. */
  isLive?: (runId: string) => boolean
  /** Deny every pending interrupt of the run (stop). */
  denyPendingInterrupts?: (executionRunId: string, now: number) => Promise<void>
  /** Raise the `team_recovery` interrupt for a run that cannot be replayed. */
  openRecovery?: (runId: string) => Promise<unknown>
  /** The readiness guard a re-entry passes (`squad-control.ts`). */
  readiness?: SquadResumeGuardDeps["readiness"]
}

async function defaultOpenRecovery(runId: string): Promise<unknown> {
  const { ensureTeamRecoveryInterrupt } = await import("./team-recovery")
  return ensureTeamRecoveryInterrupt(runId)
}

async function defaultIsLive(runId: string): Promise<boolean> {
  const { getTeamRunContext } = await import("../team-run-context")
  return getTeamRunContext(runId) !== undefined
}

async function setMirroredTeamStatus(
  teamId: string,
  status: "paused" | "executing" | "cancelled" | "completed"
): Promise<void> {
  const { useAgentTeamStore } = await import("@/stores/squads/agent-team-store/store")
  useAgentTeamStore.getState().setTeamStatus(teamId, status)
}

async function journal(
  runId: string,
  type: "run.paused" | "run.resumed" | "run.cancelled" | "run.waiting",
  reason: string,
  now: number
): Promise<void> {
  const executionRunId = agentTeamExecutionRunId(runId)
  const executionRun = await getExecutionRun(executionRunId).catch(() => undefined)
  if (!executionRun) return
  if (isTerminalRunStatus(executionRun.status)) return
  await runEventJournal
    .append(
      executionRunId,
      semanticRunEvent(
        type,
        { reason },
        { ts: now, sourceEventId: `agent-team:${runId}:${type}:${now}` }
      )
    )
    .catch(() => undefined)
}

/**
 * Deny every pending interrupt of a stopped Squad run: a review nobody will
 * act on must not stay open. Also what a lifecycle settling its own abort
 * calls after the coordinator step.
 */
export async function denyPendingSquadInterrupts(
  executionRunId: string,
  now: number
): Promise<void> {
  const { getDb } = await import("@/lib/db/schema")
  const { expireRunInterruptFromSource } = await import("@/lib/execution/run-control")
  const pending = await getDb()
    .executionRunInterrupts.where("[runId+status]")
    .equals([executionRunId, "pending"])
    .toArray()
  for (const interrupt of pending) {
    await expireRunInterruptFromSource(executionRunId, interrupt.id, now).catch(() => undefined)
  }
}

async function parkRun(runId: string, reason: string, now: number): Promise<boolean> {
  const { parkActiveSquadRun } = await import("../squad/squad-run-records")
  return parkActiveSquadRun(runId, reason, now)
}

/** Re-enter an exited lifecycle over the work that remains. */
async function defaultReenter(input: { teamId: string; runId: string }): Promise<unknown> {
  const { prepareSquadResume, resumeTaskFilter, runSquadLifecycle, restoreSquadRunInput } =
    await import("../squad/squad-lifecycle-runner")
  const restored = await restoreSquadRunInput(input.teamId, input.runId)
  if (!restored) return undefined
  const { remaining } = await prepareSquadResume(input.teamId)
  if (remaining === 0) {
    const now = Date.now()
    const current = await getAgentTeamRun(input.runId)
    if (!current || isTerminalTeamStatus(current.status)) return undefined
    if (
      !(await updateAgentTeamRunIfCurrent(input.runId, current, {
        status: "completed",
        completedAt: now,
        updatedAt: now,
      }))
    )
      return undefined
    const { settleAgentTeamExecutionRun } = await import("@/lib/execution/agent-team-bridge")
    const run = await getAgentTeamRun(input.runId)
    if (run) await settleAgentTeamExecutionRun(run, "completed", now).catch(() => undefined)
    await setMirroredTeamStatus(input.teamId, "completed")
    const { emitTeamCompletedSchedulerEvent } = await import("../squad/squad-lifecycle-runner")
    void emitTeamCompletedSchedulerEvent(input.teamId, "completed")
    return undefined
  }
  return runSquadLifecycle({
    ...restored,
    taskFilter: resumeTaskFilter,
  })
}

async function resolveTargetRunId(target: SquadControlTarget): Promise<string | undefined> {
  if ("runId" in target) return target.runId
  const { findLiveSquadRun } = await import("../squad/squad-run-records")
  return (await findLiveSquadRun(target.teamId))?.id
}

/** Pause, resume or stop a Squad run: the one entry every surface uses. */
export async function controlSquadRun(
  target: SquadControlTarget,
  action: SquadControlAction,
  deps: SquadControlDeps = {}
): Promise<SquadControlResult> {
  const now = deps.now ?? Date.now
  const runId = await resolveTargetRunId(target)
  if (!runId) return { ok: false, reason: "run_not_found" }
  const run = await getAgentTeamRun(runId)
  if (!run) return { ok: false, reason: "run_not_found" }
  if (isTerminalTeamStatus(run.status)) {
    return { ok: false, reason: "already_terminal", status: run.status }
  }
  const step = { now, ...(deps.coordinator ? { coordinator: deps.coordinator } : {}) }
  const openRecovery = deps.openRecovery ?? defaultOpenRecovery
  /** A child the coordinator could not prove paused or stopped: a person decides. */
  const unconfirmed = async (): Promise<SquadControlResult> => {
    await openRecovery(runId).catch(() => undefined)
    return { ok: false, reason: "recovery_required", status: "needs_input" }
  }

  if (action === "pause") {
    if (!PAUSABLE.has(run.status)) return { ok: false, reason: "not_pausable", status: run.status }
    try {
      await controlDurableRun(runId, "pause", step)
    } catch {
      return unconfirmed()
    }
    await journal(runId, "run.paused", "operator_pause", now())
    await setMirroredTeamStatus(run.teamId, "paused")
    return { ok: true, status: "paused" }
  }

  if (action === "resume") {
    if (!RESUMABLE.has(run.status)) {
      return { ok: false, reason: "not_resumable", status: run.status }
    }
    const live = deps.isLive ? deps.isLive(runId) : await defaultIsLive(runId)
    const guard = await guardSquadRunResume(
      run,
      { reentry: !live },
      { now, ...(deps.readiness ? { readiness: deps.readiness } : {}) }
    )
    if (guard.kind === "legacy") {
      return { ok: false, reason: "not_resumable", status: run.status }
    }
    if (guard.kind === "missing_constraints") {
      if (!(await parkRun(runId, "missing_execution_constraints", now()))) {
        return { ok: false, reason: "already_terminal" }
      }
      await openRecovery(runId).catch(() => undefined)
      return { ok: false, reason: "recovery_required", status: "needs_input" }
    }
    if (guard.kind === "uncertain") {
      const at = now()
      if (!(await parkRun(runId, guard.reason, at))) {
        return { ok: false, reason: "already_terminal" }
      }
      await journal(runId, "run.waiting", "team_recovery", at)
      await setMirroredTeamStatus(run.teamId, "paused")
      // The question a person has to answer, as a durable interrupt every
      // surface can see. Best-effort here: the bootstrap re-arms it.
      await openRecovery(runId).catch(() => undefined)
      return { ok: false, reason: "recovery_required", status: "needs_input" }
    }
    if (guard.kind === "unready") {
      // The readiness guard parked the run and raised its review.
      return { ok: false, reason: "recovery_required", status: "needs_input" }
    }
    if (live) {
      try {
        await controlDurableRun(runId, "resume", step)
      } catch {
        return unconfirmed()
      }
      await journal(runId, "run.resumed", "operator_resume", now())
      await setMirroredTeamStatus(run.teamId, "executing")
      return { ok: true, status: "running" }
    }
    const at = now()
    if (
      !(await updateAgentTeamRunIfCurrent(runId, run, {
        status: "running",
        recoveryReason: undefined,
        updatedAt: at,
      }))
    ) {
      const current = await getAgentTeamRun(runId)
      return {
        ok: false,
        reason:
          current && isTerminalTeamStatus(current.status) ? "already_terminal" : "not_resumable",
        status: current?.status,
      }
    }
    await journal(runId, "run.resumed", "operator_resume", at)
    // Fire-and-forget, like a start: a re-entered lifecycle can run for
    // minutes and every caller has something to acknowledge quickly.
    void (deps.reenter ?? defaultReenter)({ teamId: run.teamId, runId })
      .catch(async () => {
        if (await parkRun(runId, "reentry_failed", now())) await openRecovery(runId)
      })
      .catch(() => undefined)
    return { ok: true, status: "running" }
  }

  // stop: terminal cancellation. Abort the in-process lifecycle (its `finally`
  // journals the terminal event when it is alive), cascade to the children and
  // deny whatever was waiting on a person.
  const at = now()
  const { abortTeam } = await import("../agent-team-runtime")
  abortTeam(run.teamId, new Error("shutdown"), runId)
  try {
    await controlDurableRun(runId, "stop", step)
  } catch {
    return unconfirmed()
  }
  const stopped = await getAgentTeamRun(runId)
  if (stopped?.status !== "cancelled") {
    // Publication may have won while the durable controller loaded children.
    // Its terminal execution and store mirror must keep that same outcome.
    return {
      ok: false,
      reason: !stopped
        ? "run_not_found"
        : isTerminalTeamStatus(stopped.status)
          ? "already_terminal"
          : "not_resumable",
      status: stopped?.status,
    }
  }
  await (deps.denyPendingInterrupts ?? denyPendingSquadInterrupts)(
    agentTeamExecutionRunId(runId),
    at
  ).catch(() => undefined)
  await journal(runId, "run.cancelled", "operator_stop", at)
  await setMirroredTeamStatus(run.teamId, "cancelled")
  return { ok: true, status: "cancelled" }
}

/**
 * Redirect a durable team run without stopping it.
 *
 * Fans out to every child that can still act, because a team's work is spread
 * across children — steering only the lead would leave the workers running on
 * the instruction the person just corrected.
 *
 * The coordinator's own `steer` owns the PII gate and the durable receipt, and
 * it is the receipt that makes this safe to call when nothing is live: an
 * undelivered steer stays `queued` and the next provider turn consumes it at
 * its next safe boundary. So "no live control attached" is not a failure here —
 * it is the durable path working. Only "no child can act at all" is.
 */
export async function steerDurableRun(
  runId: string,
  message: string,
  options: DurableRunControlOptions = {}
): Promise<{ receiptIds: string[]; childCount: number }> {
  const coordinator = options.coordinator ?? getDurableTeamCoordinator()
  const now = options.now ?? Date.now
  const run = await getAgentTeamRun(runId)
  if (!run) throw new Error(`Unknown durable AgentTeam run: ${runId}`)
  const children = (await listAgentTeamChildRuns(runId)).filter(
    (child) => !isTerminalTeamStatus(child.status)
  )
  if (children.length === 0) return { receiptIds: [], childCount: 0 }

  const receipts = await Promise.all(
    children.map(async (child) => {
      try {
        return (await coordinator.steer(child.id, message)).id
      } catch {
        // One refusing child must not swallow the correction for the others.
        return undefined
      }
    })
  )
  const receiptIds = receipts.filter((id): id is string => typeof id === "string")
  await appendAgentTeamTrajectory({
    runId,
    kind: "run_controlled",
    correlationId: `run-steer:${runId}:${now()}`,
    // Receipt ids only. The message text lives in the receipt rows, which are
    // redaction-gated; the trajectory is a projection surface.
    payload: { action: "steer", childCount: children.length, receiptIds },
    createdAt: now(),
  })
  return { receiptIds, childCount: children.length }
}
