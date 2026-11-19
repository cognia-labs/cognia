/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  BOT_RUN_RESULT_STEP,
  addBotRunExecutionMs,
  beginBotRunStep,
  botRunStepId,
  completeBotRunStep,
  deleteBotRunStepsForRuns,
  failBotRunStep,
  getBotRunStep,
  listBotRunSteps,
  putBotRunResult,
  readBotRunExecutionMs,
} from "./bot-run-steps"
import { __resetDbForTesting, getDb } from "./schema"

const NOW = 1_700_000_000_000

describe("botRunStepId", () => {
  it("keys on the run and the step name", () => {
    expect(botRunStepId("run_1", "fetch")).toBe("run_1::fetch")
    expect(botRunStepId("run_1", "fetch")).not.toBe(botRunStepId("run_2", "fetch"))
  })
})

describe("bot run steps", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botRunSteps.clear()
  }, 15_000)

  it("claims a fresh step as attempt one", async () => {
    expect(await beginBotRunStep("run_1", "fetch", NOW)).toEqual({ memoized: false, attempt: 1 })
  })

  it("hands back the stored output on a re-entry", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", { issues: 3 }, NOW + 1)

    expect(await beginBotRunStep("run_1", "fetch", NOW + 2)).toEqual({
      memoized: true,
      value: { issues: 3 },
    })
  })

  it("stores an output verbatim, including strings a redactor would rewrite", async () => {
    // This is the whole reason checkpoints are not run-journal events.
    const secretish = "https://api.github.com/repos/acme/web/pulls/42"
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", { url: secretish }, NOW + 1)

    const replay = await beginBotRunStep("run_1", "fetch", NOW + 2)
    expect(replay).toEqual({ memoized: true, value: { url: secretish } })
  })

  it("memoizes an explicitly undefined output as completed", async () => {
    await beginBotRunStep("run_1", "noop", NOW)
    await completeBotRunStep("run_1", "noop", undefined, NOW + 1)

    // A step that legitimately returned nothing must still count as done, or
    // it reruns on every resume.
    expect(await beginBotRunStep("run_1", "noop", NOW + 2)).toEqual({
      memoized: true,
      value: undefined,
    })
  })

  it("re-enters a failed step and counts the attempt", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await failBotRunStep("run_1", "fetch", "upstream 500", NOW + 1)

    // Only a completed step carries an output worth trusting, and the point of
    // a retry is to try the failing work again.
    expect(await beginBotRunStep("run_1", "fetch", NOW + 2)).toEqual({
      memoized: false,
      attempt: 2,
    })
  })

  it("keeps the failure row, so a retry is not mistaken for a first attempt", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await failBotRunStep("run_1", "fetch", "boom", NOW + 1)

    const row = await getBotRunStep("run_1", "fetch")
    expect(row?.status).toBe("failed")
    expect(row?.error).toBe("boom")
    expect(row?.startedAt).toBe(NOW)
  })

  it("keeps the first output when a completion is written twice", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", "first", NOW + 1)
    await completeBotRunStep("run_1", "fetch", "second", NOW + 2)

    expect(await getBotRunStep("run_1", "fetch")).toMatchObject({ output: "first" })
  })

  it("refuses to demote a completed step to failed", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", "done", NOW + 1)
    await failBotRunStep("run_1", "fetch", "late error", NOW + 2)

    // A late failure from an abandoned attempt must not erase a result the
    // handler already carried on from.
    expect(await getBotRunStep("run_1", "fetch")).toMatchObject({
      status: "completed",
      output: "done",
    })
  })

  it("keeps two runs' steps apart", async () => {
    await beginBotRunStep("run_1", "fetch", NOW)
    await completeBotRunStep("run_1", "fetch", "a", NOW)
    await beginBotRunStep("run_2", "fetch", NOW)

    expect(await beginBotRunStep("run_2", "fetch", NOW)).toEqual({ memoized: false, attempt: 2 })
    expect(await getBotRunStep("run_1", "fetch")).toMatchObject({ output: "a" })
  })

  it("lists a run's steps in the order they were reached", async () => {
    await beginBotRunStep("run_1", "first", NOW)
    await beginBotRunStep("run_1", "second", NOW + 5)

    expect((await listBotRunSteps("run_1")).map((s) => s.name)).toEqual(["first", "second"])
  })

  it("deletes every checkpoint of the named runs and nothing else", async () => {
    await beginBotRunStep("run_1", "a", NOW)
    await putBotRunResult("run_1", { summary: "done" }, NOW)
    await beginBotRunStep("run_2", "a", NOW)
    await beginBotRunStep("run_3", "a", NOW)

    expect(await deleteBotRunStepsForRuns(["run_1", "run_2"])).toBe(3)
    expect(await listBotRunSteps("run_1")).toEqual([])
    expect(await listBotRunSteps("run_2")).toEqual([])
    expect(await listBotRunSteps("run_3")).toHaveLength(1)
    expect(await deleteBotRunStepsForRuns([])).toBe(0)
  })

  it("keeps the result of the attempt that settled the run, not the first one", async () => {
    // A step memoizes its first value; the result must not. The first attempt
    // computed A and failed to commit its terminal state, the retry computed
    // B and committed: the run reports B.
    await putBotRunResult("run_1", { output: "A" }, NOW)
    await putBotRunResult("run_1", { output: "B" }, NOW + 1)

    expect(await getBotRunStep("run_1", BOT_RUN_RESULT_STEP)).toMatchObject({
      status: "completed",
      output: { output: "B" },
      attempt: 2,
      startedAt: NOW,
      updatedAt: NOW + 1,
    })
  })
})

describe("run execution time (B14)", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("reads zero before the first segment and sums every segment after", async () => {
    expect(await readBotRunExecutionMs("run_1")).toBe(0)
    expect(await addBotRunExecutionMs("run_1", 40, NOW)).toBe(40)
    expect(await addBotRunExecutionMs("run_1", 25, NOW + 1)).toBe(65)
    expect(await readBotRunExecutionMs("run_1")).toBe(65)
    // Per run: another run's time is its own.
    expect(await readBotRunExecutionMs("run_2")).toBe(0)
  })

  it("counts two segments that end together, and never a negative one", async () => {
    await Promise.all([
      addBotRunExecutionMs("run_1", 30, NOW),
      addBotRunExecutionMs("run_1", 20, NOW),
    ])
    await addBotRunExecutionMs("run_1", -5, NOW)
    expect(await readBotRunExecutionMs("run_1")).toBe(50)
  })
})
