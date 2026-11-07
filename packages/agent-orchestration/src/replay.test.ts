import { contractChild, contractRun } from "./store-contract"
import type { AgentTeamCheckpoint, AgentTeamTrajectoryEvent } from "./records"
import {
  CHILD_ADMISSION_WAITING_REASON,
  isChildReplaySafe,
  ownsDispatchAttempt,
  planDispatchAttempt,
  assessRecoveryEligibility,
  deriveFenceExpiryProof,
  childStopProof,
  summarizeRunRecovery,
} from "./replay"

function checkpoint(overrides: Partial<AgentTeamCheckpoint> = {}): AgentTeamCheckpoint {
  return {
    id: "cp",
    runId: "run-1",
    childRunId: "child-1",
    trajectorySequence: 3,
    decisionVersion: 0,
    replay: "safe",
    sideEffects: [],
    createdAt: 1,
    ...overrides,
  }
}

function event(sequence: number, kind: AgentTeamTrajectoryEvent["kind"], childRunId = "child-1") {
  return {
    id: `run-1:${sequence}`,
    runId: "run-1",
    childRunId,
    sequence,
    kind,
    correlationId: "c",
    createdAt: sequence,
  }
}

describe("task recovery admission", () => {
  it("does not treat a completed legacy row without startup metadata as never started", () => {
    const child = contractChild({ status: "completed" })
    expect(
      assessRecoveryEligibility({ runId: child.runId, taskId: child.taskId }, [child], [], [], 100)
    ).toMatchObject({ eligible: false, reason: "stop_unconfirmed" })
  })
  it("requires current epoch disposal ACK for a completed child, not turn completion or expiry", () => {
    const child = contractChild({ status: "completed", startedAt: 1, dispatchEpoch: 2 })
    const task = { runId: child.runId, taskId: child.taskId }
    const ack = {
      state: "confirmed" as const,
      epoch: 2,
      requestedAt: 1,
      proof: { kind: "ack" as const, epoch: 2, at: 2 },
    }
    for (const candidate of [
      child,
      { ...child, settledEpoch: 2 },
      { ...child, settledEpoch: 1, stop: ack },
      { ...child, stop: ack },
    ]) {
      expect(
        assessRecoveryEligibility(task, [candidate], [checkpoint()], [], 100, new Set([child.id]))
      ).toMatchObject({ eligible: false, reason: "stop_unconfirmed" })
    }
    expect(
      assessRecoveryEligibility(
        task,
        [{ ...child, settledEpoch: 2, stop: ack }],
        [checkpoint()],
        [],
        100
      )
    ).toEqual({ eligible: true })
  })
  it("requires host-confirmed absence for a started local child after WebView reload", () => {
    const child = contractChild({ status: "running", startedAt: 1, dispatchEpoch: 1 })
    expect(
      assessRecoveryEligibility(
        { runId: child.runId, taskId: child.taskId },
        [child],
        [checkpoint()],
        [],
        100
      )
    ).toMatchObject({ eligible: false, reason: "stop_unconfirmed" })
  })
  it("preserves an explicitly unconfirmed local stop after process activity is lost", () => {
    const child = contractChild({
      status: "needs_input",
      dispatchEpoch: 1,
      startedAt: 1,
      stop: { state: "unconfirmed", epoch: 1, requestedAt: 2 },
    })
    expect(
      assessRecoveryEligibility(
        { runId: child.runId, taskId: child.taskId },
        [child],
        [checkpoint()],
        [],
        100
      )
    ).toMatchObject({ eligible: false, reason: "stop_unconfirmed" })
  })
  const child = contractChild({
    status: "failed",
    dispatchEpoch: 2,
    remoteDispatchEpoch: 2,
    hostRef: "a",
    startedAt: 1,
  })
  it("refuses settled Write plus connection loss, regardless of the next teammate or host", () => {
    expect(
      assessRecoveryEligibility(
        { runId: child.runId, taskId: child.taskId },
        [child],
        [checkpoint()],
        [],
        100
      )
    ).toMatchObject({ eligible: false, reason: "stop_unconfirmed" })
  })
  it.each(["ack", "fence-expiry"] as const)(
    "accepts a current %s proof and safe checkpoint",
    (kind) => {
      const stopped = {
        ...child,
        ...(kind === "fence-expiry"
          ? { fenceCapable: true, lastRenewalSentAt: 1, leaseTtlMs: 1, fenceGraceMs: 0 }
          : {}),
        stop: {
          state: "confirmed" as const,
          epoch: 2,
          requestedAt: 1,
          proof: { kind, epoch: 2, at: 10 },
        },
      }
      expect(
        assessRecoveryEligibility(
          { runId: child.runId, taskId: child.taskId },
          [stopped],
          [checkpoint()],
          [],
          100
        ).eligible
      ).toBe(true)
      expect(
        assessRecoveryEligibility(
          { runId: child.runId, taskId: child.taskId },
          [{ ...stopped, dispatchEpoch: 3 }],
          [checkpoint()],
          [],
          100
        ).eligible
      ).toBe(false)
    }
  )
  it("does not reuse a recorded fence proof after a later renewal was sent", () => {
    const fenced = {
      ...child,
      fenceCapable: true,
      lastRenewalSentAt: 1,
      leaseTtlMs: 10,
      fenceGraceMs: 5,
      stop: {
        state: "confirmed" as const,
        epoch: 2,
        requestedAt: 1,
        proof: { kind: "fence-expiry" as const, epoch: 2, at: 16 },
      },
    }
    expect(childStopProof(fenced, 16)?.kind).toBe("fence-expiry")
    expect(childStopProof({ ...fenced, lastRenewalSentAt: 17 }, 20)).toBeUndefined()
  })
  it("counts expiry from renewal sent, refuses old workers and a newer lease epoch", () => {
    const fencing = {
      ...child,
      fenceCapable: true,
      lastRenewalSentAt: 100,
      leaseTtlMs: 60,
      fenceGraceMs: 30,
      dispatchLeaseExpiresAt: 160,
    }
    expect(deriveFenceExpiryProof(fencing, 189)).toBeUndefined()
    expect(deriveFenceExpiryProof(fencing, 190)).toEqual({
      kind: "fence-expiry",
      epoch: 2,
      at: 190,
    })
    expect(deriveFenceExpiryProof({ ...fencing, fenceCapable: false }, 1000)).toBeUndefined()
    expect(
      deriveFenceExpiryProof(
        { ...fencing, stop: { state: "requested", epoch: 1, requestedAt: 1 } },
        1000
      )
    ).toBeUndefined()
  })
})

describe("isChildReplaySafe", () => {
  it("allows replay from a safe checkpoint with no later remote work", () => {
    expect(
      isChildReplaySafe("child-1", checkpoint(), [
        event(2, "remote_event"),
        event(4, "tool_result"),
      ])
    ).toBe(true)
  })

  it("refuses without a checkpoint, for another child, or when not marked safe", () => {
    expect(isChildReplaySafe("child-1", undefined, [])).toBe(false)
    expect(isChildReplaySafe("child-1", checkpoint({ childRunId: "child-2" }), [])).toBe(false)
    expect(isChildReplaySafe("child-1", checkpoint({ replay: "needs_input" }), [])).toBe(false)
  })

  it("refuses when a side effect has an unknown outcome or an unsafe intent", () => {
    const unknown = checkpoint({
      sideEffects: [{ id: "s", kind: "push", state: "unknown", replay: "safe" }],
    })
    const unsafeIntent = checkpoint({
      sideEffects: [{ id: "s", kind: "push", state: "intent", replay: "unsafe" }],
    })
    const safeIntent = checkpoint({
      sideEffects: [{ id: "s", kind: "read", state: "intent", replay: "safe" }],
    })
    expect(isChildReplaySafe("child-1", unknown, [])).toBe(false)
    expect(isChildReplaySafe("child-1", unsafeIntent, [])).toBe(false)
    expect(isChildReplaySafe("child-1", safeIntent, [])).toBe(true)
  })

  it("refuses when this child recorded remote work after the checkpoint", () => {
    expect(isChildReplaySafe("child-1", checkpoint(), [event(5, "remote_event")])).toBe(false)
    // Another child's remote work does not count.
    expect(isChildReplaySafe("child-1", checkpoint(), [event(5, "remote_event", "child-2")])).toBe(
      true
    )
  })
})

describe("planDispatchAttempt", () => {
  it("refuses a parked child", () => {
    for (const status of ["pausing", "paused", "sleeping", "needs_input"] as const) {
      expect(planDispatchAttempt(contractChild({ status }), contractRun())).toEqual({
        kind: "conflict",
        reason: `Child is not accepting dispatch while ${status}`,
      })
    }
  })

  it("refuses a child that is running or waiting for admission", () => {
    expect(planDispatchAttempt(contractChild({ status: "running" }), contractRun())).toMatchObject({
      kind: "conflict",
      reason: "Child already has an active dispatch",
    })
    expect(
      planDispatchAttempt(
        contractChild({ status: "queued", waitingReason: CHILD_ADMISSION_WAITING_REASON }),
        contractRun()
      )
    ).toMatchObject({ kind: "conflict" })
  })

  it("refuses when the run is not accepting dispatch", () => {
    expect(planDispatchAttempt(undefined, undefined)).toEqual({
      kind: "conflict",
      reason: "Run is not accepting dispatch",
    })
    expect(planDispatchAttempt(undefined, contractRun({ status: "paused" }))).toMatchObject({
      kind: "conflict",
    })
  })

  it("resumes an unfinished child under the next attempt, keeping failures and the retry host", () => {
    const failed = contractChild({
      status: "failed",
      attempt: 2,
      waitingReason: "retry_host:host-b",
      resourceUsage: { ...contractChild().resourceUsage, failures: 2 },
    })
    expect(planDispatchAttempt(failed, contractRun({ status: "recovering" }))).toEqual({
      kind: "resume",
      child: failed,
      attempt: 3,
      previousFailures: 2,
      retryTargetHostRef: "host-b",
    })
  })

  it("starts fresh at attempt 1 when there is no child or the last one finished", () => {
    expect(planDispatchAttempt(undefined, contractRun())).toEqual({ kind: "fresh", attempt: 1 })
    expect(planDispatchAttempt(contractChild({ status: "completed" }), contractRun())).toEqual({
      kind: "fresh",
      attempt: 1,
    })
  })
})

describe("ownsDispatchAttempt", () => {
  it("fences out every attempt but the current one", () => {
    expect(ownsDispatchAttempt(contractChild({ attempt: 3 }), 3)).toBe(true)
    expect(ownsDispatchAttempt(contractChild({ attempt: 4 }), 3)).toBe(false)
    expect(ownsDispatchAttempt(undefined, 1)).toBe(false)
  })
})

describe("summarizeRunRecovery", () => {
  it("is safe only when every task is, naming each refused child once", () => {
    expect(summarizeRunRecovery([])).toEqual({ safe: true, uncertainChildIds: [] })
    expect(summarizeRunRecovery([{ eligible: true }])).toEqual({
      safe: true,
      uncertainChildIds: [],
    })
    expect(
      summarizeRunRecovery([
        { eligible: true },
        { eligible: false, reason: "uncertain_side_effect", childRunIds: ["a", "b"] },
        { eligible: false, reason: "uncertain_side_effect", childRunIds: ["b"] },
      ])
    ).toEqual({ safe: false, uncertainChildIds: ["a", "b"], reason: "uncertain_side_effect" })
  })

  it("lets an unconfirmed stop outrank an unsafe checkpoint", () => {
    expect(
      summarizeRunRecovery([
        { eligible: false, reason: "uncertain_side_effect", childRunIds: ["a"] },
        { eligible: false, reason: "stop_unconfirmed", childRunIds: ["c"] },
      ])
    ).toEqual({ safe: false, uncertainChildIds: ["a", "c"], reason: "stop_unconfirmed" })
  })
})
