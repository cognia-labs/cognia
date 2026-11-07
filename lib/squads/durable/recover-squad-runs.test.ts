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

const settleAgentTeamExecutionRun = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/execution/agent-team-bridge", () => ({
  settleAgentTeamExecutionRun: (...args: unknown[]) => settleAgentTeamExecutionRun(...args),
}))

jest.mock("./durable-control", () => ({
  controlSquadRun: (target: unknown, action: string) => controlSquadRun(target, action),
}))

import { recoverSquadRuns } from "./recover-squad-runs"

describe("recoverSquadRuns", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    listPendingSquadReviews.mockResolvedValue([])
    getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "team-1", status: "recovering" })
  })

  it("keeps startup ready while a restored review waits, then checks readiness after approval", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    listPendingSquadReviews.mockResolvedValueOnce([
      { id: "review-1", reviewKind: "budget_extension" },
    ])
    let approve!: (value: unknown) => void
    openSquadReview.mockReturnValueOnce(
      new Promise((resolve) => {
        approve = resolve
      })
    )
    await recoverSquadRuns()
    expect(openSquadReview).toHaveBeenCalled()
    expect(guardSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()

    approve({ kind: "budget_extension", outcome: "approve", extraTokens: 25000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(guardSquadResume).toHaveBeenCalledWith("team-1", "run-1")
    expect(runSquadLifecycle).toHaveBeenCalledWith(expect.objectContaining(restoredInput))
  })

  it("pauses a refused restored review without re-entering work", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    listPendingSquadReviews.mockResolvedValueOnce([
      { id: "review-1", reviewKind: "budget_extension" },
    ])
    openSquadReview.mockResolvedValueOnce({ kind: "budget_extension", outcome: "deny" })
    await recoverSquadRuns()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controlSquadRun).toHaveBeenCalledWith({ runId: "run-1" }, "pause")
    expect(guardSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("honors a pause during the restored run's readiness check", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    listPendingSquadReviews.mockResolvedValueOnce([
      { id: "review-1", reviewKind: "budget_extension" },
    ])
    openSquadReview.mockResolvedValueOnce({ kind: "budget_extension", outcome: "approve" })
    let finishGuard!: (result: { blocked: boolean; blockers: Array<{ code: string }> }) => void
    guardSquadResume.mockReturnValueOnce(
      new Promise((resolve) => {
        finishGuard = resolve
      })
    )
    await recoverSquadRuns()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(guardSquadResume).toHaveBeenCalled()
    getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "team-1", status: "paused" })
    finishGuard({ blocked: false, blockers: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runSquadLifecycle).not.toHaveBeenCalled()
    expect(parkSquadRecovery).not.toHaveBeenCalled()
  })

  it.each(["review", "guard"])(
    "parks unexpected %s failures instead of stranding recovery",
    async (failure) => {
      recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
      listPendingSquadReviews.mockResolvedValueOnce([
        { id: "review-1", reviewKind: "budget_extension" },
      ])
      if (failure === "review")
        openSquadReview.mockRejectedValueOnce(new Error("review read failed"))
      else {
        openSquadReview.mockResolvedValueOnce({ kind: "budget_extension", outcome: "approve" })
        guardSquadResume.mockRejectedValueOnce(new Error("readiness read failed"))
      }
      await recoverSquadRuns()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(parkSquadRecovery).toHaveBeenCalledWith("run-1", "team-1", "reentry_failed")
      expect(runSquadLifecycle).not.toHaveBeenCalled()
    }
  )

  it.each(["aborted", "cancelled", "paused"])(
    "does not resume a %s run when its old review settles",
    async (state) => {
      recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
      listPendingSquadReviews.mockResolvedValueOnce([
        { id: "review-1", reviewKind: "budget_extension" },
      ])
      let approve!: (value: unknown) => void
      openSquadReview.mockReturnValueOnce(
        new Promise((resolve) => {
          approve = resolve
        })
      )
      const controller = new AbortController()
      await recoverSquadRuns({ signal: controller.signal })
      expect(openSquadReview).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal })
      )
      if (state === "aborted") controller.abort()
      else getAgentTeamRun.mockResolvedValueOnce({ id: "run-1", teamId: "team-1", status: state })
      approve({ kind: "budget_extension", outcome: "approve", extraTokens: 25000 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(guardSquadResume).not.toHaveBeenCalled()
      expect(runSquadLifecycle).not.toHaveBeenCalled()
      expect(controlSquadRun).not.toHaveBeenCalled()
    }
  )

  it("projects uncertain recovery as an operator input gate without replaying work", async () => {
    await expect(recoverSquadRuns()).resolves.toEqual([{ runId: "run-1", status: "needs_input" }])
    expect(setTeamStatus).toHaveBeenCalledWith("team-1", "paused")
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("re-enters a safely recoverable run over its remaining work", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    await recoverSquadRuns()
    expect(restoreSquadRunInput).toHaveBeenCalledWith("team-1", "run-1")
    expect(prepareSquadResume).toHaveBeenCalledTimes(1)
    expect(runSquadLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        ...restoredInput,
        taskFilter: expect.any(Function),
      })
    )
  })

  it("does not re-enter a run whose Squad is no longer ready", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    guardSquadResume.mockResolvedValueOnce({
      blocked: true,
      blockers: [{ code: "missing_environment_ref" }],
    })
    const outcomes = await recoverSquadRuns()
    expect(prepareSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()
    expect(restoreSquadRunInput).not.toHaveBeenCalled()
    expect(outcomes.map((o) => o.status)).toContain("needs_input")
  })

  it("requires operator input when the original run constraints cannot be restored", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    restoreSquadRunInput.mockResolvedValueOnce(undefined)

    await expect(recoverSquadRuns()).resolves.toEqual([{ runId: "run-1", status: "needs_input" }])
    expect(prepareSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("parks a recovered run when lifecycle re-entry rejects", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    runSquadLifecycle.mockRejectedValueOnce(new Error("re-entry failed"))

    await recoverSquadRuns()

    expect(parkSquadRecovery).toHaveBeenCalledWith("run-1", "team-1", "reentry_failed")
  })

  it("parks a lifecycle failure after it has claimed the recovering run", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    runSquadLifecycle.mockImplementationOnce(async () => {
      getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "team-1", status: "running" })
      throw new Error("execution failed")
    })
    await recoverSquadRuns()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(parkSquadRecovery).toHaveBeenCalledWith("run-1", "team-1", "reentry_failed")
  })

  it.each(["cancelled", "terminated"] as const)(
    "journals a recovered %s run even without a team definition",
    async (status) => {
      const run = { id: "run-1", teamId: "deleted-team", status, completedAt: 123 }
      getAgentTeamRun.mockResolvedValue(run as never)
      recover.mockResolvedValueOnce([{ runId: run.id, status } as never])
      await expect(recoverSquadRuns()).resolves.toEqual([{ runId: run.id, status }])
      expect(settleAgentTeamExecutionRun).toHaveBeenCalledWith(run, "cancelled", 123)
      expect(setTeamStatus).toHaveBeenCalledWith("deleted-team", "cancelled")
    }
  )

  it("does not publish a stale terminal recovery outcome", async () => {
    getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "team-1", status: "running" })
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "cancelled" as never }])
    await recoverSquadRuns()
    expect(settleAgentTeamExecutionRun).not.toHaveBeenCalled()
  })

  it("finishes recovery admission without awaiting a long recovered lifecycle", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    runSquadLifecycle.mockReturnValueOnce(new Promise(() => {}))
    const result = await Promise.race([
      recoverSquadRuns(),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ])
    expect(result).toEqual([{ runId: "run-1", status: "recovering" }])
    expect(runSquadLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ requirePlanApprovalFloor: true })
    )
  })

  it("stops before reading anything once its signal is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(recoverSquadRuns({ signal: controller.signal })).resolves.toEqual([])
    expect(recover).not.toHaveBeenCalled()
  })
})
