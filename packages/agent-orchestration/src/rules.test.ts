import { contractChild, contractRun } from "./store-contract"
import {
  dispatchLeaseClaimPatch,
  dispatchLeaseRenewPatch,
  dispatchLeaseSettlePatch,
  canAdvanceRemoteEvent,
  isParkedTeamStatus,
  isTerminalTeamStatus,
  matchesControlState,
  nextTrajectoryEvent,
  selectRecoveryCandidates,
  steeringReceiptPatch,
  steeringResolvedChildPatch,
  teamRunOutcome,
} from "./rules"

describe("persistence rules", () => {
  it("checks the epoch even if a stalled dispatch presents the current lease id", () => {
    expect(
      matchesControlState(
        { status: "running", updatedAt: 1, dispatchEpoch: 1 },
        { status: "running", updatedAt: 1 }
      )
    ).toBe(false)
    const child = contractChild({
      dispatchEpoch: 2,
      dispatchLeaseId: "lease",
      dispatchLeaseExpiresAt: 100,
    })
    expect(dispatchLeaseRenewPatch(child, "lease", 10, 60, 1)).toBeUndefined()
    expect(dispatchLeaseSettlePatch(child, "lease", 10, 1)).toBeUndefined()
    expect(canAdvanceRemoteEvent(child, undefined, 1)).toBe(false)
    expect(dispatchLeaseRenewPatch(child, "lease", 10, 60, 2)).toMatchObject({
      lastRenewalSentAt: 10,
    })
    expect(
      dispatchLeaseRenewPatch(
        { ...child, stop: { state: "requested", epoch: 2, requestedAt: 1 } },
        "lease",
        10,
        60,
        2
      )
    ).toBeUndefined()
  })

  it("matches control state only on identical status and updatedAt", () => {
    expect(
      matchesControlState({ status: "running", updatedAt: 1 }, { status: "running", updatedAt: 1 })
    ).toBe(true)
    expect(
      matchesControlState({ status: "running", updatedAt: 2 }, { status: "running", updatedAt: 1 })
    ).toBe(false)
    expect(matchesControlState(undefined, { status: "running", updatedAt: 1 })).toBe(false)
  })

  it("recovers only interrupted execution, by priority then queue entry", () => {
    const runs = [
      contractRun({ id: "queued", status: "queued" }),
      contractRun({ id: "low", status: "running", priority: 1, createdAt: 1 }),
      contractRun({ id: "high-late", status: "recovering", priority: 9, createdAt: 5 }),
      contractRun({
        id: "high-early",
        status: "pausing",
        priority: 9,
        queueEnteredAt: 2,
        createdAt: 9,
      }),
      contractRun({ id: "input", status: "needs_input" }),
    ]
    expect(selectRecoveryCandidates(runs).map((run) => run.id)).toEqual([
      "high-early",
      "high-late",
      "low",
    ])
  })

  it("refuses a lease claim while another live lease holds the child", () => {
    const child = contractChild({ dispatchLeaseId: "A", dispatchLeaseExpiresAt: 100 })
    expect(
      dispatchLeaseClaimPatch(child, { childRunId: "child-1", leaseId: "B", hostRef: "h", now: 50 })
    ).toBeUndefined()
    expect(
      dispatchLeaseClaimPatch(child, {
        childRunId: "child-1",
        leaseId: "B",
        hostRef: "h",
        now: 100,
      })
    ).toMatchObject({
      dispatchLeaseId: "B",
      dispatchLeaseExpiresAt: 60_100,
    })
  })

  it("numbers trajectory events from the last sequence", () => {
    expect(
      nextTrajectoryEvent(undefined, {
        runId: "r",
        kind: "checkpoint",
        correlationId: "c",
        createdAt: 1,
      })
    ).toMatchObject({ id: "r:1", sequence: 1 })
    expect(
      nextTrajectoryEvent(
        7,
        { runId: "r", kind: "checkpoint", correlationId: "c", createdAt: 1 },
        "sha256:x"
      )
    ).toMatchObject({ id: "r:8", sequence: 8, contentHash: "sha256:x" })
  })

  it("stamps steering status times and leaves the pending set only when resolved", () => {
    expect(steeringReceiptPatch("delivered", 4)).toEqual({
      status: "delivered",
      updatedAt: 4,
      deliveredAt: 4,
    })
    expect(steeringReceiptPatch("rejected", 5, "late")).toEqual({
      status: "rejected",
      updatedAt: 5,
      reason: "late",
    })
    const child = contractChild({ pendingSteeringCount: 1 })
    expect(steeringResolvedChildPatch(child, "delivered", 6)).toBeUndefined()
    expect(steeringResolvedChildPatch(child, "applied", 6)).toEqual({
      pendingSteeringCount: 0,
      updatedAt: 6,
    })
  })
})

describe("team status vocabulary", () => {
  const ALL = [
    "queued",
    "running",
    "pausing",
    "paused",
    "sleeping",
    "recovering",
    "needs_input",
    "completed",
    "failed",
    "cancelled",
    "terminated",
  ] as const

  it("splits every status into exactly one of terminal, parked or moving", () => {
    const terminal = ALL.filter(isTerminalTeamStatus)
    const parked = ALL.filter(isParkedTeamStatus)
    expect(terminal).toEqual(["completed", "failed", "cancelled", "terminated"])
    expect(parked).toEqual(["pausing", "paused", "sleeping", "needs_input"])
    expect(ALL.filter((s) => !isTerminalTeamStatus(s) && !isParkedTeamStatus(s))).toEqual([
      "queued",
      "running",
      "recovering",
    ])
  })

  it("reports a forced stop to the caller as cancelled", () => {
    expect(teamRunOutcome("terminated")).toBe("cancelled")
    expect(teamRunOutcome("cancelled")).toBe("cancelled")
    expect(teamRunOutcome("completed")).toBe("completed")
    expect(teamRunOutcome("failed")).toBe("failed")
  })
})
