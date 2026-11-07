import type { TeamDelegationRecord } from "@/types/agent/agent-team"
import type { ExecutionRun, ExecutionRunStatus } from "@/types/execution/run"
import { delegationExecutionRunId, projectDelegation } from "./delegation-view"

const RUN_ID = "execution:job:bg_1"

function record(overrides: Partial<TeamDelegationRecord> = {}): TeamDelegationRecord {
  return {
    id: "d1",
    sourceTeamId: "team-1",
    sourceTaskId: "task-1",
    targetType: "background",
    targetId: "bg_1",
    status: "active",
    reason: "Offload",
    manual: true,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    metadata: { executionRunId: RUN_ID },
    ...overrides,
  }
}

function run(status: ExecutionRunStatus, overrides: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: RUN_ID,
    kind: "job",
    sourceId: "bg_1",
    title: "child",
    status,
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

describe("delegationExecutionRunId", () => {
  it("reads the linked child run and ignores anything that is not an id", () => {
    expect(delegationExecutionRunId(record())).toBe(RUN_ID)
    expect(delegationExecutionRunId(record({ metadata: { executionRunId: "" } }))).toBeUndefined()
    expect(delegationExecutionRunId(record({ metadata: { executionRunId: 3 } }))).toBeUndefined()
    expect(delegationExecutionRunId(record({ metadata: undefined }))).toBeUndefined()
  })
})

describe("projectDelegation", () => {
  it("leaves a record with no row as it is", () => {
    const awaiting = record({ status: "awaiting_approval", metadata: undefined })
    expect(projectDelegation(awaiting, undefined)).toBe(awaiting)
  })

  it("ignores a row the record is not linked to", () => {
    const linked = record()
    expect(projectDelegation(linked, run("completed", { id: "execution:job:other" }))).toBe(linked)
  })

  it("reads a running child as active with no extra status", () => {
    const view = projectDelegation(record(), run("running"))
    expect(view.status).toBe("active")
    expect(view.runStatus).toBeUndefined()
  })

  it.each(["queued", "waiting", "paused", "recovery_required"] as const)(
    "says when the child is %s",
    (status) => {
      const view = projectDelegation(record(), run(status))
      expect(view).toMatchObject({ status: "active", runStatus: status })
    }
  )

  it("reads the row's settle over a record that has not caught up", () => {
    expect(projectDelegation(record(), run("completed", { endedAt: 50 }))).toMatchObject({
      status: "completed",
      completedAt: new Date(50),
    })
    expect(projectDelegation(record(), run("cancelled")).status).toBe("cancelled")
    expect(projectDelegation(record(), run("failed")).status).toBe("failed")
  })

  it("keeps the record's completion time when it has one", () => {
    const done = record({ status: "completed", completedAt: new Date(9) })
    expect(projectDelegation(done, run("completed", { endedAt: 50 })).completedAt).toEqual(
      new Date(9)
    )
  })

  it("keeps a timeout the row can only call a failure", () => {
    const timedOut = record({ status: "timeout", result: "deadline" })
    expect(projectDelegation(timedOut, run("failed"))).toMatchObject({
      status: "timeout",
      error: "deadline",
    })
  })

  it("keeps the operator's cancel while the child is still winding down", () => {
    const cancelled = record({ status: "cancelled" })
    expect(projectDelegation(cancelled, run("running")).status).toBe("cancelled")
  })

  it("surfaces why a delegation failed", () => {
    // A child that failed hands its error back as the record's result.
    expect(projectDelegation(record({ result: "boom" }), run("failed")).error).toBe("boom")
    // A refusal before launch keeps its reason in metadata.
    const refused = record({
      status: "failed",
      metadata: { error: "team delegation cycle rejected" },
    })
    expect(projectDelegation(refused, undefined).error).toBe("team delegation cycle rejected")
    // The record's own error wins.
    expect(projectDelegation(record({ status: "failed", error: "own" }), undefined).error).toBe(
      "own"
    )
    // A completed delegation's result is its output, not an error.
    expect(projectDelegation(record({ result: "output" }), run("completed")).error).toBeUndefined()
  })
})
