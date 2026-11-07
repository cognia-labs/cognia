/** @jest-environment node */
import type { ExecutionRunStatus } from "@/types/execution/run"
import {
  runSquadToEnd,
  SquadRunRefusedError,
  squadStartRefusalDetail,
  type RunSquadToEndDeps,
} from "./run-squad-to-end"
import type { StartSquadRunInput, StartSquadRunResult } from "./start-squad-run"

const INPUT: StartSquadRunInput = {
  squadId: "t1",
  goal: "",
  origin: "scheduler",
  triggeredFrom: { source: "schedule" },
  runId: "stable",
}
const STARTED: StartSquadRunResult = {
  started: true,
  runId: "run_team_1",
  executionRunId: "execution:team:run_team_1",
}

function deps(patch: Partial<RunSquadToEndDeps> = {}) {
  const start = jest.fn(async (_input: StartSquadRunInput) => STARTED)
  const awaitSettlement = jest.fn(
    async (_id: string, _options: { signal?: AbortSignal }): Promise<ExecutionRunStatus> =>
      "completed"
  )
  const stop = jest.fn(async (_runId: string) => ({ ok: true }))
  const lifecycleResult = jest.fn((_runId: string): { reason?: string } | undefined => undefined)
  const recoveryReason = jest.fn(async (_runId: string): Promise<string | undefined> => undefined)
  const all = { start, awaitSettlement, stop, lifecycleResult, recoveryReason, ...patch }
  return all as typeof all & Required<RunSquadToEndDeps>
}

describe("runSquadToEnd", () => {
  it("launches through startSquadRun and resolves when the run's row ends", async () => {
    const d = deps()
    await expect(runSquadToEnd(INPUT, {}, d)).resolves.toEqual({
      start: STARTED,
      status: "completed",
      outcome: "completed",
    })
    expect(d.start).toHaveBeenCalledWith(INPUT, undefined)
    expect(d.awaitSettlement).toHaveBeenCalledWith("execution:team:run_team_1", {})
    expect(d.stop).not.toHaveBeenCalled()
  })

  it("names why the lifecycle ended, or why the run was parked before it ended", async () => {
    const failed = deps({
      awaitSettlement: jest.fn(async () => "failed" as const),
      lifecycleResult: jest.fn(() => ({ reason: "plan_rejected" })),
    })
    await expect(runSquadToEnd(INPUT, {}, failed)).resolves.toMatchObject({
      outcome: "failed",
      reason: "plan_rejected",
    })
    expect(failed.recoveryReason).not.toHaveBeenCalled()
    const parked = deps({
      awaitSettlement: jest.fn(async () => "cancelled" as const),
      recoveryReason: jest.fn(async () => "stop_unconfirmed"),
    })
    await expect(runSquadToEnd(INPUT, {}, parked)).resolves.toMatchObject({
      outcome: "cancelled",
      reason: "stop_unconfirmed",
    })
    const unreadable = deps({
      recoveryReason: jest.fn(async () => {
        throw new Error("db closed")
      }),
    })
    await expect(runSquadToEnd(INPUT, {}, unreadable)).resolves.not.toHaveProperty("reason")
  })

  it("stops that exact run when its caller aborts while it runs", async () => {
    const controller = new AbortController()
    const d = deps({
      awaitSettlement: jest.fn(async (_id: string, options: { signal?: AbortSignal }) => {
        controller.abort(new Error("caller stopped"))
        options.signal?.throwIfAborted()
        return "completed" as const
      }),
    })
    await expect(runSquadToEnd(INPUT, { signal: controller.signal }, d)).rejects.toThrow(
      "caller stopped"
    )
    expect(d.stop).toHaveBeenCalledWith("run_team_1")
  })

  it("starts nothing for a caller already aborted, and stops a run its caller left during launch", async () => {
    const aborted = new AbortController()
    aborted.abort(new Error("gone"))
    const before = deps()
    await expect(runSquadToEnd(INPUT, { signal: aborted.signal }, before)).rejects.toThrow("gone")
    expect(before.start).not.toHaveBeenCalled()

    const during = new AbortController()
    const d = deps({
      start: jest.fn(async () => {
        during.abort(new Error("left"))
        return STARTED
      }),
      awaitSettlement: jest.fn(async (_id: string, options: { signal?: AbortSignal }) => {
        options.signal?.throwIfAborted()
        return "completed" as const
      }),
    })
    await expect(runSquadToEnd(INPUT, { signal: during.signal }, d)).rejects.toThrow("left")
    expect(d.stop).toHaveBeenCalledWith("run_team_1")
  })

  it("waits for the run a replayed run id already launched", async () => {
    const d = deps({ start: jest.fn(async () => ({ ...STARTED, duplicate: true })) })
    await expect(runSquadToEnd(INPUT, {}, d)).resolves.toMatchObject({
      start: { duplicate: true },
      outcome: "completed",
    })
    expect(d.awaitSettlement).toHaveBeenCalledTimes(1)
  })

  it("throws the seam's refusal, naming readiness blockers", async () => {
    const notReady: StartSquadRunResult = {
      started: false,
      reason: "not_ready",
      blockers: [{ code: "missing_environment_ref" }, { code: "no_teammates" }] as never,
    }
    const d = deps({ start: jest.fn(async () => notReady) })
    const error = await runSquadToEnd(INPUT, {}, d).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SquadRunRefusedError)
    expect((error as SquadRunRefusedError).message).toBe(
      "Squad run refused: not_ready:missing_environment_ref,no_teammates"
    )
    expect((error as SquadRunRefusedError).result).toBe(notReady)
    expect(squadStartRefusalDetail({ started: false, reason: "already_running" })).toBe(
      "already_running"
    )
    expect(squadStartRefusalDetail({ started: false })).toBe("dispatch_error")
    expect(d.awaitSettlement).not.toHaveBeenCalled()
  })
})
