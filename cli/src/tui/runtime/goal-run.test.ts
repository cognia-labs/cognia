/**
 * @jest-environment node
 */
import type { RunAndCaptureResult } from "@/lib/ai/agent/execution/capture-types"
import type { Goal } from "@/types/goal"
import { runGoalStreaming, type GoalRunDeps } from "./goal-run"
import type { TuiAction } from "../state/types"

const reply = (text: string): RunAndCaptureResult => ({
  text,
  messageId: "m",
  a2uiSurfaces: {},
  a2uiSurfaceOrder: [],
  usage: { inputTokens: 1, outputTokens: 1 },
})

const fakeGoal = (over: Partial<Goal> = {}): Goal =>
  ({
    id: "g1",
    status: "active",
    safeObjective: "do the thing",
    generationId: "gen-1",
    config: { maxTurns: 20 },
    ...over,
  }) as Goal

function baseDeps(over: Partial<GoalRunDeps> = {}): {
  deps: GoalRunDeps
  actions: TuiAction[]
  sent: string[]
} {
  const actions: TuiAction[] = []
  const sent: string[] = []
  const deps: GoalRunDeps = {
    send: async (p) => {
      sent.push(p)
      return reply("ok")
    },
    dispatch: (a) => actions.push(a),
    sessionId: "s1",
    config: { cwd: "/tmp" } as never,
    signal: new AbortController().signal,
    ensureDb: async () => {},
    ensureSession: async () => {},
    appSettings: null,
    createGoal: async () => fakeGoal(),
    buildJudge: () => ({}) as never,
    getSession: async () => ({}) as never,
    getGoal: async () => fakeGoal(),
    pauseGoal: async () => {},
    stopGoal: async () => {},
    guardTurnDeadline: () => () => {},
    ...over,
  }
  return { deps, actions, sent }
}

describe("runGoalStreaming", () => {
  it("resumes the existing paused goal without creating a replacement", async () => {
    const createGoal = jest.fn()
    const resumeGoal = jest.fn(async () => fakeGoal({ status: "active" }))
    const { deps, sent } = baseDeps({
      resume: true,
      createGoal,
      getOpenGoal: async () => fakeGoal({ status: "paused" }),
      resumeGoal,
      handleTurn: (async () => ({
        kind: "exit",
        resultingStatus: "completed",
        reason: "done",
      })) as never,
    })
    await runGoalStreaming("", deps)
    expect(resumeGoal).toHaveBeenCalledWith("g1")
    expect(createGoal).not.toHaveBeenCalled()
    expect(sent).toEqual(["do the thing"])
  })

  it("notices when there is no paused goal to resume", async () => {
    const createGoal = jest.fn()
    const { deps, actions, sent } = baseDeps({
      resume: true,
      getOpenGoal: async () => undefined,
      createGoal,
    })
    await runGoalStreaming("", deps)
    expect(createGoal).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(actions.at(-1)).toMatchObject({ message: "No paused goal to resume in this session." })
  })
  it("notices on an empty objective", async () => {
    const { deps, actions, sent } = baseDeps()
    await runGoalStreaming("   ", deps)
    expect(sent).toEqual([])
    expect(actions).toEqual([{ type: "NOTICE", message: "Usage: /goal <objective>" }])
  })

  it("sends the redacted objective first, then drives to the judge exit", async () => {
    const outcomes = [
      { kind: "continue" as const, userMessage: "keep going" },
      {
        kind: "exit" as const,
        resultingStatus: "completed",
        reason: "all met",
        exit: "judge_done",
      },
    ]
    let i = 0
    const { deps, actions, sent } = baseDeps({
      handleTurn: (async () => outcomes[i++]) as never,
    })
    await runGoalStreaming("do the thing", deps)

    expect(sent).toEqual(["do the thing", "keep going"])
    expect(actions[0]).toMatchObject({ type: "ACTIVITY_START", kind: "goal" })
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Goal completed: all met",
    })
  })

  it("ends with an error and never sends when no judge is available", async () => {
    const { deps, actions, sent } = baseDeps({ buildJudge: () => null })
    await runGoalStreaming("do x", deps)
    expect(sent).toEqual([])
    expect(actions).toContainEqual(
      expect.objectContaining({ type: "ACTIVITY_END", status: "error" })
    )
  })

  it("ends (paused) when the driver reports aborted", async () => {
    const { deps, actions } = baseDeps({ handleTurn: (async () => ({ kind: "aborted" })) as never })
    await runGoalStreaming("do x", deps)
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Goal paused.",
    })
  })

  it("ends with an error when the goal row vanishes mid-run", async () => {
    const { deps, actions } = baseDeps({ getGoal: async () => undefined })
    await runGoalStreaming("do x", deps)
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "error",
      summary: "Goal removed mid-run.",
    })
  })

  it("ends with an error on a stale outcome", async () => {
    const { deps, actions } = baseDeps({
      handleTurn: (async () => ({ kind: "stale", reason: "rotated" })) as never,
    })
    await runGoalStreaming("do x", deps)
    expect(actions.at(-1)).toMatchObject({ type: "ACTIVITY_END", status: "error" })
  })

  it("surfaces a createGoal refusal (goal/loop mutex) as an error end", async () => {
    const { deps, actions, sent } = baseDeps({
      createGoal: async () => {
        throw new Error("loop blocked: session s1 has an active goal")
      },
    })
    await runGoalStreaming("do x", deps)
    expect(sent).toEqual([])
    expect(actions).toEqual([
      {
        type: "ACTIVITY_END",
        status: "error",
        summary: "loop blocked: session s1 has an active goal",
      },
    ])
  })
})

describe("goal admission and cancellation", () => {
  it.each(["pause", "stop"])("persists %s and ignores a late completed reply", async (action) => {
    const controller = new AbortController()
    const pauseGoal = jest.fn(async () => {})
    const stopGoal = jest.fn(async () => {})
    const handleTurn = jest.fn()
    const { deps } = baseDeps({
      signal: controller.signal,
      pauseGoal,
      stopGoal,
      handleTurn,
      send: async () => {
        controller.abort(action)
        return reply("late")
      },
    })
    await runGoalStreaming("work", deps)
    expect(handleTurn).not.toHaveBeenCalled()
    expect(action === "pause" ? pauseGoal : stopGoal).toHaveBeenCalledWith("g1")
    expect(action === "pause" ? stopGoal : pauseGoal).not.toHaveBeenCalled()
  })

  it("does not clean up a newer goal generation", async () => {
    const controller = new AbortController()
    const pauseGoal = jest.fn()
    const { deps } = baseDeps({
      signal: controller.signal,
      pauseGoal,
      getGoal: async () => fakeGoal({ generationId: "new" }),
      send: async () => {
        controller.abort("pause")
        return null
      },
    })
    await runGoalStreaming("work", deps)
    expect(pauseGoal).not.toHaveBeenCalled()
  })

  it("does not create a goal without a judge or after pre-admission cancellation", async () => {
    const createGoal = jest.fn()
    const { deps } = baseDeps({ buildJudge: () => null, createGoal })
    await runGoalStreaming("work", deps)
    await runGoalStreaming("work", { ...deps, signal: AbortSignal.abort() })
    expect(createGoal).not.toHaveBeenCalled()
  })

  it("passes the admitted generation rather than a later row generation to the driver", async () => {
    const handleTurn = jest.fn(async () => ({ kind: "stale", reason: "rotated" })) as never
    const { deps } = baseDeps({
      getGoal: async () => fakeGoal({ generationId: "new" }),
      handleTurn,
    })
    await runGoalStreaming("work", deps)
    expect(handleTurn).toHaveBeenCalledWith(
      expect.objectContaining({ capturedGenerationId: "gen-1" })
    )
  })
})

describe("the goal's wall-clock deadline (F21)", () => {
  it("stops the turn in flight at the deadline and ends the run as timed out", async () => {
    let stopAtDeadline: (() => unknown) | undefined
    const release = jest.fn()
    let status: Goal["status"] = "active"
    const abortTurn = jest.fn()
    const handleTurn = jest.fn()
    const { deps, actions } = baseDeps({
      guardTurnDeadline: (_goal, stop) => {
        stopAtDeadline = stop
        return release
      },
      abortTurn,
      getGoal: async () =>
        status === "active"
          ? fakeGoal()
          : fakeGoal({ status: "timed_out", generationId: "gen-after-deadline" }),
      handleTurn: handleTurn as never,
      // The deadline passes mid-turn: the goal ends and the turn is aborted, so
      // the send reports no reply.
      send: async () => {
        status = "timed_out"
        stopAtDeadline?.()
        return null
      },
    })
    await runGoalStreaming("long task", deps)
    expect(abortTurn).toHaveBeenCalledTimes(1)
    // The deadline's end is the goal's, not a failed turn: no judge runs.
    expect(handleTurn).not.toHaveBeenCalled()
    expect(actions.at(-1)).toEqual({
      type: "ACTIVITY_END",
      status: "done",
      summary: "Goal timed_out: wall-clock timeout reached",
    })
    expect(release).toHaveBeenCalled()
  })

  it("releases the deadline guard when the run ends normally", async () => {
    const release = jest.fn()
    const { deps } = baseDeps({
      guardTurnDeadline: () => release,
      handleTurn: (async () => ({
        kind: "exit",
        resultingStatus: "completed",
        reason: "done",
      })) as never,
    })
    await runGoalStreaming("quick task", deps)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
