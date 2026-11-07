import {
  executionEventForSettledTeamRun,
  isLiveRunStatus,
  isSettledTeamRunStatus,
  type SettledTeamRunStatus,
} from "./run-status"
import { isTerminalRunStatus, type ExecutionRunStatus } from "@/types/execution/run"

const EXECUTION_STATUSES: ExecutionRunStatus[] = [
  "queued",
  "running",
  "waiting",
  "paused",
  "recovery_required",
  "completed",
  "failed",
  "cancelled",
]

describe("isLiveRunStatus", () => {
  it("is exactly the complement of the terminal statuses", () => {
    for (const status of EXECUTION_STATUSES) {
      expect(isLiveRunStatus(status)).toBe(!isTerminalRunStatus(status))
    }
    expect(EXECUTION_STATUSES.filter(isLiveRunStatus)).toEqual([
      "queued",
      "running",
      "waiting",
      "paused",
      "recovery_required",
    ])
  })
})

describe("executionEventForSettledTeamRun", () => {
  it.each<[SettledTeamRunStatus, string]>([
    ["completed", "run.completed"],
    ["failed", "run.failed"],
    ["cancelled", "run.cancelled"],
    // A forced stop ends the run; the ledger records a cancellation.
    ["terminated", "run.cancelled"],
    ["paused", "run.paused"],
    // Nobody paused a run that waits for a person.
    ["needs_input", "run.waiting"],
  ])("%s → %s", (status, event) => {
    expect(executionEventForSettledTeamRun(status)).toBe(event)
  })
})

describe("isSettledTeamRunStatus", () => {
  it("is terminal, paused or waiting for a person, never a status the coordinator passes through", () => {
    const all = [
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
    expect(all.filter(isSettledTeamRunStatus)).toEqual([
      "paused",
      "needs_input",
      "completed",
      "failed",
      "cancelled",
      "terminated",
    ])
  })
})
