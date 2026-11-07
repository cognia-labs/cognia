import type { AgentTeam } from "@/types/agent/agent-team"

const recover = jest.fn(async () => [{ runId: "run-1", status: "needs_input" as const }])
const retryChild = jest.fn(async () => undefined)
const runSquadLifecycle = jest.fn<Promise<{ runId: string; status: "failed" }>, [unknown]>(
  async () => ({ runId: "run-1", status: "failed" })
)
const prepareSquadResume = jest.fn(async () => ({ remaining: 1 }))
const restoredInput = {
  teamId: "team-1",
  runId: "run-1",
  origin: "scheduler" as const,
  requirePlanApprovalFloor: true,
  sessionWorkingDir: "/original-workspace",
}
const restoreSquadRunInput = jest.fn<
  ReturnType<typeof import("../squad/squad-lifecycle-runner").restoreSquadRunInput>,
  Parameters<typeof import("../squad/squad-lifecycle-runner").restoreSquadRunInput>
>(async () => restoredInput)
const parkSquadRecovery = jest.fn<
  ReturnType<typeof import("../squad/squad-lifecycle-runner").parkSquadRecovery>,
  Parameters<typeof import("../squad/squad-lifecycle-runner").parkSquadRecovery>
>(async () => undefined)
const controlSquadRun = jest.fn(async (_target: unknown, _action: string) => ({
  ok: true,
  status: "paused",
}))
const getAgentTeamRun = jest.fn(async () => ({
  id: "run-1",
  teamId: "team-1",
  status: "recovering",
}))
const getAgentTeamChildRun = jest.fn(async () => ({
  id: "child-1",
  runId: "run-1",
  teamId: "team-1",
  taskId: "task-1",
}))
const setTeamStatus = jest.fn()
const updateTask = jest.fn()
const listPendingSquadReviews = jest.fn(
  async () =>
    [] as Array<{
      id: string
      reviewKind: string
    }>
)
const openSquadReview = jest.fn()
jest.mock("../gates/squad-review-gate", () => ({
  listPendingSquadReviews: () => listPendingSquadReviews(),
  openSquadReview: (...args: unknown[]) => openSquadReview(...args),
  squadReviewRequestIdFromInterrupt: () => ({
    runId: "run-1",
    kind: "budget_extension",
    instance: "crossing-1",
  }),
}))

const team = { id: "team-1", status: "executing", config: {} } as AgentTeam

const storeState = {
  teams: { "team-1": team },
  tasks: {},
  teammates: {},
  getTeam: (id: string) => (id === team.id ? team : undefined),
  setTeamStatus,
  updateTask,
}

jest.mock("@/stores/squads/agent-team-store/store", () => ({
  useAgentTeamStore: { getState: () => storeState },
}))

jest.mock("./durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ recover, retryChild }),
}))

jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: () => getAgentTeamRun(),
  getAgentTeamChildRun: () => getAgentTeamChildRun(),
}))

const guardSquadResume = jest.fn<
  ReturnType<typeof import("../squad/squad-lifecycle-runner").guardSquadResume>,
  Parameters<typeof import("../squad/squad-lifecycle-runner").guardSquadResume>
>(async () => ({ blocked: false, blockers: [] }))
jest.mock("../squad/squad-lifecycle-runner", () => ({
  runSquadLifecycle: (input: unknown) => runSquadLifecycle(input),
  prepareSquadResume: () => prepareSquadResume(),
  restoreSquadRunInput: (teamId: string, runId: string) => restoreSquadRunInput(teamId, runId),
  parkSquadRecovery: (...args: Parameters<typeof parkSquadRecovery>) => parkSquadRecovery(...args),
  guardSquadResume: (teamId: string, runId: string) => guardSquadResume(teamId, runId),
  resumeTaskFilter: () => true,
}))

jest.mock("./durable-control", () => ({
  controlSquadRun: (target: unknown, action: string) => controlSquadRun(target, action),
}))

import { retrySquadChild } from "./retry-squad-child"

describe("retrySquadChild", () => {
  beforeEach(() => jest.clearAllMocks())

  it("retries one child through the durable coordinator and re-enters only that task", async () => {
    await retrySquadChild("child-1", "device:worker-b")

    expect(retryChild).toHaveBeenCalledWith("child-1", "device:worker-b")
    expect(updateTask).toHaveBeenCalledWith("task-1", {
      status: "pending",
      error: undefined,
      completedAt: undefined,
    })
    const input = runSquadLifecycle.mock.calls[0]?.[0] as {
      teamId: string
      runId: string
      taskFilter: (task: { id: string }) => boolean
    }
    expect(input).toMatchObject(restoredInput)
    expect(input.taskFilter({ id: "task-1" })).toBe(true)
    expect(input.taskFilter({ id: "task-2" })).toBe(false)
  })

  it("does not run a child whose run fails the resume guards", async () => {
    guardSquadResume.mockResolvedValueOnce({
      blocked: true,
      blockers: [{ code: "missing_environment_ref" }],
    })
    await retrySquadChild("child-1")
    expect(retryChild).toHaveBeenCalledWith("child-1", undefined)
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("does not run a child whose run lost its frozen authority", async () => {
    restoreSquadRunInput.mockResolvedValueOnce(undefined)
    await retrySquadChild("child-1")
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("refuses an unknown child or Squad before touching the coordinator", async () => {
    getAgentTeamChildRun.mockResolvedValueOnce(undefined as never)
    await expect(retrySquadChild("child-x")).rejects.toThrow("Unknown durable child: child-x")
    getAgentTeamChildRun.mockResolvedValueOnce({
      id: "child-2",
      runId: "run-1",
      teamId: "team-gone",
      taskId: "task-2",
    })
    await expect(retrySquadChild("child-2")).rejects.toThrow("Unknown Squad: team-gone")
    expect(retryChild).not.toHaveBeenCalled()
  })
})
