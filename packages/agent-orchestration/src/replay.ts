/**
 * Replay safety and attempt fencing (ADR-0217).
 *
 * Recovery may re-run a teammate only from a checkpoint that authorizes it,
 * and only one dispatch attempt may own a child at a time. These decisions are
 * pure so every host (and every store) reaches the same answer.
 */

import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamRunRecord,
  AgentTeamTrajectoryEvent,
  StopProof,
} from "./records"

/** The waiting reason a child carries while the fair scheduler admits it. */
export const CHILD_ADMISSION_WAITING_REASON = "scheduler_admission"

/** Brain-local deadline: a renewal being SENT can extend the worker's authority. */
export function deriveFenceExpiryProof(
  child: AgentTeamChildRun,
  now: number
): StopProof | undefined {
  const epoch = child.dispatchEpoch ?? 0
  if (
    !child.fenceCapable ||
    child.lastRenewalSentAt === undefined ||
    child.leaseTtlMs === undefined ||
    child.fenceGraceMs === undefined ||
    !Number.isFinite(child.lastRenewalSentAt) ||
    !Number.isFinite(child.leaseTtlMs) ||
    child.leaseTtlMs <= 0 ||
    !Number.isFinite(child.fenceGraceMs) ||
    child.fenceGraceMs < 0 ||
    (child.stop && child.stop.epoch !== epoch) ||
    (child.dispatchLeaseExpiresAt ?? 0) > now ||
    now < child.lastRenewalSentAt + child.leaseTtlMs + child.fenceGraceMs
  )
    return undefined
  return { kind: "fence-expiry", epoch, at: now }
}

export function childStopProof(child: AgentTeamChildRun, now: number): StopProof | undefined {
  // Turn completion needs an actual current-epoch disposal receipt. Neither a
  // recovery status rewrite nor lease expiry may manufacture that receipt.
  if (child.status === "completed") return isChildSettled(child) ? child.stop?.proof : undefined
  const proof = child.stop?.proof
  if (
    child.stop?.state === "confirmed" &&
    child.stop.epoch === (child.dispatchEpoch ?? 0) &&
    proof?.epoch === (child.dispatchEpoch ?? 0)
  ) {
    if (proof.kind === "ack" || deriveFenceExpiryProof(child, proof.at)) return proof
  }
  return deriveFenceExpiryProof(child, now)
}

/** Remote authority survives transport failure and lease release. */
export function hasRemoteDispatch(child: AgentTeamChildRun): boolean {
  // A proved previous remote attempt may be followed by a local epoch. Its
  // historical attribution must not turn the new local executor into a worker.
  if (child.remoteDispatchEpoch !== undefined)
    return child.remoteDispatchEpoch === (child.dispatchEpoch ?? 0)
  return (
    !!child.dispatchLeaseId ||
    child.leaseTtlMs !== undefined ||
    !!child.remoteSessionId ||
    !!child.lastRemoteEventId
  )
}

export function isChildSettled(child: AgentTeamChildRun): boolean {
  const epoch = child.dispatchEpoch ?? 0
  return (
    ["completed", "failed", "cancelled", "terminated"].includes(child.status) &&
    child.settledEpoch === epoch &&
    (child.status !== "completed" ||
      (child.stop?.state === "confirmed" &&
        child.stop.epoch === epoch &&
        child.stop.proof?.kind === "ack" &&
        child.stop.proof.epoch === epoch))
  )
}

export function isChildNeverStarted(
  child: AgentTeamChildRun,
  checkpoint?: AgentTeamCheckpoint,
  trajectory: readonly AgentTeamTrajectoryEvent[] = []
): boolean {
  return (
    child.status !== "completed" &&
    child.waitingReason !== "stop_unconfirmed" &&
    child.startedAt === undefined &&
    // Only a newly registered WP1 record explicitly says admission never
    // happened. Missing legacy metadata cannot make that assertion.
    child.dispatchEpoch === 0 &&
    !((child.resourceUsage.attempts ?? 0) > 0) &&
    !checkpoint?.sideEffects.length &&
    !trajectory.some(
      (event) =>
        event.childRunId === child.id &&
        [
          "model_turn_started",
          "model_turn_completed",
          "remote_event",
          "tool_intent",
          "tool_result",
        ].includes(event.kind)
    ) &&
    !child.lastRemoteEventId &&
    !hasRemoteDispatch(child) &&
    !child.dispatchLeaseId &&
    !child.remoteSessionId &&
    !child.sessionId
  )
}

export type RecoveryEligibility =
  | { eligible: true }
  | { eligible: false; reason: "stop_unconfirmed" | "uncertain_side_effect"; childRunIds: string[] }

/** The ONE task-level gate. A safe checkpoint says nothing about a still-live executor. */
export function assessRecoveryEligibility(
  task: { runId: string; taskId: string },
  children: readonly AgentTeamChildRun[],
  checkpoints: readonly (AgentTeamCheckpoint | undefined)[],
  trajectory: readonly AgentTeamTrajectoryEvent[],
  now: number,
  stoppedLocalChildIds: ReadonlySet<string> = new Set()
): RecoveryEligibility {
  const earlier = children.filter(
    (child) =>
      child.runId === task.runId &&
      child.taskId === task.taskId &&
      !isChildNeverStarted(
        child,
        checkpoints.find((cp) => cp?.childRunId === child.id),
        trajectory
      )
  )
  const unconfirmed = earlier.filter(
    (child) =>
      !isChildSettled(child) &&
      (child.status === "completed" ||
        (!childStopProof(child, now) &&
          (hasRemoteDispatch(child) || !stoppedLocalChildIds.has(child.id))))
  )
  if (unconfirmed.length)
    return {
      eligible: false,
      reason: "stop_unconfirmed",
      childRunIds: unconfirmed.map((child) => child.id),
    }
  const unsafe = earlier.filter(
    (child) =>
      !isChildReplaySafe(
        child.id,
        checkpoints.find((cp) => cp?.childRunId === child.id),
        trajectory
      )
  )
  return unsafe.length
    ? {
        eligible: false,
        reason: "uncertain_side_effect",
        childRunIds: unsafe.map((child) => child.id),
      }
    : { eligible: true }
}

/**
 * Whether a child may be replayed from `checkpoint`. The checkpoint must be
 * the child's, marked replay-safe, carry no side effect of unknown outcome or
 * unsafe intent, and no remote event may have been recorded after it: a
 * checkpoint cannot authorize replay of remote work recorded later.
 */
export function isChildReplaySafe(
  childRunId: string,
  checkpoint: AgentTeamCheckpoint | undefined,
  trajectory: readonly AgentTeamTrajectoryEvent[]
): boolean {
  if (
    !checkpoint ||
    checkpoint.childRunId !== childRunId ||
    checkpoint.replay !== "safe" ||
    checkpoint.sideEffects.some(
      (effect) =>
        effect.state === "unknown" || (effect.state === "intent" && effect.replay !== "safe")
    )
  ) {
    return false
  }
  return !trajectory.some(
    (event) =>
      event.childRunId === childRunId &&
      event.kind === "remote_event" &&
      event.sequence > checkpoint.trajectorySequence
  )
}

const PARKED_CHILD_STATUSES = new Set(["pausing", "paused", "sleeping", "needs_input"])
const FINISHED_CHILD_STATUSES = new Set(["completed", "cancelled", "terminated"])
const DISPATCHABLE_RUN_STATUSES = new Set(["running", "queued", "recovering"])

export type DispatchAttemptPlan =
  | { kind: "conflict"; reason: string }
  | {
      kind: "resume"
      child: AgentTeamChildRun
      attempt: number
      previousFailures: number
      /** Host a previous attempt asked the retry to run on (`retry_host:<ref>`). */
      retryTargetHostRef?: string
    }
  | { kind: "fresh"; attempt: 1 }

/**
 * Decide the next dispatch attempt for one teammate's task. A parked or
 * already-active child refuses; an unfinished child resumes under the next
 * attempt number (which fences out the previous attempt); otherwise a fresh
 * child starts at attempt 1. The run must be accepting dispatch.
 */
export function planDispatchAttempt(
  previous: AgentTeamChildRun | undefined,
  run: AgentTeamRunRecord | undefined
): DispatchAttemptPlan {
  if (previous && PARKED_CHILD_STATUSES.has(previous.status)) {
    return { kind: "conflict", reason: `Child is not accepting dispatch while ${previous.status}` }
  }
  if (
    previous &&
    (previous.status === "running" ||
      (previous.status === "queued" && previous.waitingReason === CHILD_ADMISSION_WAITING_REASON))
  ) {
    return { kind: "conflict", reason: "Child already has an active dispatch" }
  }
  if (
    !run ||
    !DISPATCHABLE_RUN_STATUSES.has(run.status) ||
    run.stop?.state === "requested" ||
    run.stop?.state === "unconfirmed"
  ) {
    return { kind: "conflict", reason: "Run is not accepting dispatch" }
  }
  const resumable = previous && !FINISHED_CHILD_STATUSES.has(previous.status) ? previous : undefined
  if (!resumable) return { kind: "fresh", attempt: 1 }
  const retryTargetHostRef = resumable.waitingReason?.startsWith("retry_host:")
    ? resumable.waitingReason.slice("retry_host:".length)
    : undefined
  return {
    kind: "resume",
    child: resumable,
    attempt: resumable.attempt + 1,
    previousFailures: resumable.resourceUsage.failures ?? 0,
    ...(retryTargetHostRef !== undefined ? { retryTargetHostRef } : {}),
  }
}

/** Whether the dispatch that holds `attempt` still owns the child. */
export function ownsDispatchAttempt(
  child: AgentTeamChildRun | undefined,
  attempt: number
): child is AgentTeamChildRun {
  return !!child && child.attempt === attempt
}
