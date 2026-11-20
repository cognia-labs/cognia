const startSquadRunMock = jest.fn()
jest.mock("../squad/start-squad-run", () => ({
  startSquadRun: (...args: unknown[]) => startSquadRunMock(...args),
}))
const awaitSettlementMock = jest.fn()
jest.mock("../squad/watch-squad-run", () => ({
  awaitSquadRunSettlement: (...args: unknown[]) => awaitSettlementMock(...args),
}))
const controlSquadRunMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("../durable/durable-control", () => ({
  controlSquadRun: (...args: unknown[]) => controlSquadRunMock(...args),
}))
const readReportMock = jest.fn(async (_runId: string) => ({}) as { text?: string; error?: string })
jest.mock("../squad/squad-run-report", () => ({
  readSquadRunReport: (runId: string) => readReportMock(runId),
}))

import { port } from "./squad-launch"

const launched = {
  started: true,
  runId: "run_team_child",
  executionRunId: "execution:team:run_team_child",
}

beforeEach(() => {
  startSquadRunMock.mockReset()
  awaitSettlementMock.mockReset()
  controlSquadRunMock.mockClear()
  readReportMock.mockReset()
  readReportMock.mockResolvedValue({})
})

describe("squad-launch port", () => {
  it("starts the Squad run through the launch seam, linked to the launching run", async () => {
    startSquadRunMock.mockResolvedValue(launched)
    awaitSettlementMock.mockReturnValue(new Promise(() => undefined))
    const result = await port.start({
      squadId: "squad-2",
      brief: "investigate",
      origin: "delegation",
      launchedByRunId: "execution:team:run_team_parent",
      sessionId: "s1",
      ultracode: true,
    })
    expect(startSquadRunMock).toHaveBeenCalledWith({
      squadId: "squad-2",
      goal: "investigate",
      origin: "delegation",
      triggeredFrom: { source: "api" },
      session: { id: "s1" },
      launchedByRunId: "execution:team:run_team_parent",
      ultracode: true,
    })
    expect(result).toMatchObject({
      started: true,
      squadRunId: "run_team_child",
      executionRunId: "execution:team:run_team_child",
    })
  })

  it.each([
    [
      { started: false, reason: "not_ready", blockers: [{ code: "no_repo" }, { code: "no_env" }] },
      "not_ready:no_repo,no_env",
    ],
    [{ started: false, reason: "already_running", runId: "live" }, "already_running"],
    [{ started: false }, "dispatch_error"],
    [{ ...launched, duplicate: true }, "duplicate"],
  ])("refuses %j as %s", async (result, reason) => {
    startSquadRunMock.mockResolvedValue(result)
    await expect(
      port.start({ squadId: "squad-2", brief: "", origin: "delegation" })
    ).resolves.toEqual({ started: false, reason })
  })

  it("settles completed with this run's own report", async () => {
    startSquadRunMock.mockResolvedValue(launched)
    awaitSettlementMock.mockResolvedValue("completed")
    readReportMock.mockResolvedValue({ text: "shipped" })
    const result = await port.start({ squadId: "squad-2", brief: "", origin: "delegation" })
    if (!result.started) throw new Error("expected a started run")
    await expect(result.outcome).resolves.toEqual({ status: "completed", text: "shipped" })
    expect(awaitSettlementMock).toHaveBeenCalledWith("execution:team:run_team_child")
    expect(readReportMock).toHaveBeenCalledWith("run_team_child")
  })

  it("never returns another run's report, nor invents one (F04)", async () => {
    // The Squad's team record may still hold an earlier Ultracode run's
    // synthesis; only this run's row is read.
    startSquadRunMock.mockResolvedValue(launched)
    awaitSettlementMock.mockResolvedValue("completed")
    const quiet = await port.start({ squadId: "squad-2", brief: "current", origin: "delegation" })
    if (!quiet.started) throw new Error("expected a started run")
    await expect(quiet.outcome).resolves.toEqual({ status: "completed" })

    readReportMock.mockRejectedValueOnce(new Error("row unreadable"))
    const unreadable = await port.start({ squadId: "squad-2", brief: "", origin: "delegation" })
    if (!unreadable.started) throw new Error("expected a started run")
    await expect(unreadable.outcome).resolves.toEqual({ status: "completed" })
  })

  it("settles failed with the run's error, and cancelled for a stopped run", async () => {
    startSquadRunMock.mockResolvedValue(launched)
    readReportMock.mockResolvedValueOnce({ error: "lead gave up" })
    awaitSettlementMock.mockResolvedValueOnce("failed")
    const failed = await port.start({ squadId: "squad-2", brief: "", origin: "delegation" })
    if (!failed.started) throw new Error("expected a started run")
    await expect(failed.outcome).resolves.toEqual({ status: "failed", error: "lead gave up" })

    awaitSettlementMock.mockResolvedValueOnce("cancelled")
    const cancelled = await port.start({ squadId: "squad-2", brief: "", origin: "delegation" })
    if (!cancelled.started) throw new Error("expected a started run")
    await expect(cancelled.outcome).resolves.toMatchObject({ status: "cancelled" })

    awaitSettlementMock.mockResolvedValueOnce("failed")
    const silent = await port.start({ squadId: "squad-2", brief: "", origin: "delegation" })
    if (!silent.started) throw new Error("expected a started run")
    await expect(silent.outcome).resolves.toEqual({
      status: "failed",
      error: "Squad run run_team_child failed",
    })
  })

  it("stops the run through run control", async () => {
    startSquadRunMock.mockResolvedValue(launched)
    awaitSettlementMock.mockReturnValue(new Promise(() => undefined))
    const result = await port.start({ squadId: "squad-2", brief: "", origin: "delegation" })
    if (!result.started) throw new Error("expected a started run")
    result.stop("team delegation cancelled")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controlSquadRunMock).toHaveBeenCalledWith({ runId: "run_team_child" }, "stop")
  })
})
