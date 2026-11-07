import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

const hostIsTauriMock = jest.fn(() => true)
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => (hostIsTauriMock() ? "tauri" : "web"),
  isTauri: () => hostIsTauriMock(),
}))

const teams: Record<string, { id: string; status: string }> = {}
const runToEndMock = jest.fn()

jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: { getState: () => ({ teams }) },
}))
jest.mock("@/lib/squads/squad/run-squad-to-end", () => ({
  runSquadToEnd: (...a: unknown[]) => runToEndMock(...a),
}))

import { executeAgentTeamTask } from "./team-executor"

function makeTask(payload: Record<string, unknown>): ScheduledTask {
  return {
    id: "task_1",
    name: "team task",
    type: "agent-team",
    payload,
    config: { timeout: 300000 },
  } as unknown as ScheduledTask
}

const execution = { id: "exec_1" } as unknown as TaskExecution

const ended = (status: string, reason?: string) => ({
  start: { started: true, runId: "run-1", executionRunId: "execution:team:run-1" },
  status,
  outcome: status === "completed" || status === "cancelled" ? status : "failed",
  ...(reason ? { reason } : {}),
})

beforeEach(() => {
  for (const id of Object.keys(teams)) delete teams[id]
  runToEndMock.mockReset().mockResolvedValue(ended("completed"))
})

describe("executeAgentTeamTask", () => {
  it("rejects payloads missing teamId", async () => {
    const r = await executeAgentTeamTask(makeTask({}), execution, new AbortController().signal)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/teamId/)
  })

  it("fails clearly when the team is not in the store", async () => {
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/team not found/)
    expect(runToEndMock).not.toHaveBeenCalled()
  })

  it("succeeds when the run completes", async () => {
    teams.t1 = { id: "t1", status: "idle" }
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(true)
    expect(r.output).toEqual({
      teamId: "t1",
      runId: "run-1",
      executionRunId: "execution:team:run-1",
      status: "completed",
    })
  })

  it("starts as the schedule's run under a stable id, forwarding ultracode and cancellation", async () => {
    teams.t1 = { id: "t1", status: "idle" }
    runToEndMock.mockResolvedValue(ended("failed", "plan_rejected"))
    const ac = new AbortController()
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1", ultracode: true }),
      execution,
      ac.signal
    )
    expect(runToEndMock).toHaveBeenCalledWith(
      {
        squadId: "t1",
        goal: "",
        runId: "run_team_scheduled_exec_1",
        ultracode: true,
        origin: "scheduler",
        triggeredFrom: { source: "schedule" },
      },
      { signal: ac.signal }
    )
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/failed/)
    expect(r.output).toMatchObject({ reason: "plan_rejected" })
  })

  it("uses the run's outcome even when the team mirror is stale", async () => {
    teams.t1 = { id: "t1", status: "completed" }
    runToEndMock.mockResolvedValue(ended("cancelled"))
    const result = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(result.success).toBe(false)
    expect(result.output).toMatchObject({
      status: "cancelled",
      executionRunId: "execution:team:run-1",
    })
  })

  it("reports a refused start", async () => {
    teams.t1 = { id: "t1", status: "idle" }
    runToEndMock.mockRejectedValue(new Error("Squad run refused: already_running"))
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(r).toEqual({ success: false, error: "Squad run refused: already_running" })
  })

  it("rejects when already aborted", async () => {
    teams.t1 = { id: "t1", status: "idle" }
    const ac = new AbortController()
    ac.abort()
    const r = await executeAgentTeamTask(makeTask({ teamId: "t1" }), execution, ac.signal)
    expect(r.success).toBe(false)
    expect(runToEndMock).not.toHaveBeenCalled()
  })
})

it("refuses on a host without the sidecar instead of starting the team", async () => {
  hostIsTauriMock.mockReturnValue(false)
  try {
    const r = await executeAgentTeamTask(
      makeTask({ teamId: "t1" }),
      execution,
      new AbortController().signal
    )
    expect(r.success).toBe(false)
    expect(r.terminalReason).toBe("unsupported-on-host")
    expect(runToEndMock).not.toHaveBeenCalled()
  } finally {
    hostIsTauriMock.mockReturnValue(true)
  }
})
