/** @jest-environment jsdom */
import { getExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  BEST_OF_N_TITLE_MAX,
  bestOfNExecutionRunId,
  bestOfNGroupIdOf,
  ensureBestOfNExecutionRun,
  settleBestOfNExecutionRun,
} from "./best-of-n-bridge"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const RUN_ID = bestOfNExecutionRunId("team-run")
const seed = {
  groupId: "group-1",
  teamRunId: "team-run",
  prompt: "Fix the flaky test\nwith details nobody needs in a list",
  sessionId: "chat-1",
  projectId: "project-1",
  at: 1_000,
}
const eventTypes = async () => (await listExecutionRunEvents(RUN_ID)).map((event) => event.type)

describe("ensureBestOfNExecutionRun", () => {
  it("writes the group's row under its own kind, in the conversation it came from", async () => {
    await expect(ensureBestOfNExecutionRun(seed)).resolves.toBe(RUN_ID)
    expect(await getExecutionRun(RUN_ID)).toMatchObject({
      kind: "best-of-n",
      sourceId: "group-1",
      sessionId: "chat-1",
      projectId: "project-1",
      title: "Fix the flaky test",
      status: "running",
    })
    expect((await getExecutionRun(RUN_ID))?.actingIdentity).toMatchObject({
      trigger: "external-event",
    })
    expect(await eventTypes()).toEqual(["run.started"])
  })

  it("writes it once", async () => {
    await ensureBestOfNExecutionRun(seed)
    await ensureBestOfNExecutionRun({ ...seed, prompt: "another title", at: 2_000 })
    expect((await getExecutionRun(RUN_ID))?.title).toBe("Fix the flaky test")
    expect(await eventTypes()).toEqual(["run.started"])
  })

  it("keeps a long prompt's first line short, and names an empty one", async () => {
    await ensureBestOfNExecutionRun({ ...seed, prompt: "x".repeat(500) })
    const title = (await getExecutionRun(RUN_ID))!.title
    expect(title).toHaveLength(BEST_OF_N_TITLE_MAX)
    expect(title.endsWith("…")).toBe(true)
    await ensureBestOfNExecutionRun({ ...seed, teamRunId: "team-2", prompt: "  " })
    expect((await getExecutionRun(bestOfNExecutionRunId("team-2")))?.title).toBe("Best-of-N")
  })
})

describe("settleBestOfNExecutionRun", () => {
  it("settles the row, leaves a parked one open, and keeps a settled one as it is", async () => {
    await ensureBestOfNExecutionRun(seed)
    await expect(settleBestOfNExecutionRun("team-run", "recovery_required", 2_000)).resolves.toBe(
      true
    )
    expect((await getExecutionRun(RUN_ID))?.status).toBe("recovery_required")
    await settleBestOfNExecutionRun("team-run", "cancelled", 3_000)
    expect((await getExecutionRun(RUN_ID))?.status).toBe("cancelled")
    await settleBestOfNExecutionRun("team-run", "completed", 4_000)
    expect((await getExecutionRun(RUN_ID))?.status).toBe("cancelled")
    expect(await eventTypes()).toEqual(["run.started", "run.recovery_required", "run.cancelled"])
  })

  it("answers false for a group with no row of its own", async () => {
    await expect(settleBestOfNExecutionRun("legacy", "completed")).resolves.toBe(false)
    expect(await getExecutionRun(bestOfNExecutionRunId("legacy"))).toBeUndefined()
  })
})

describe("bestOfNGroupIdOf", () => {
  it("names the group of a best-of-N row only", () => {
    expect(bestOfNGroupIdOf({ kind: "best-of-n", sourceId: "group-1" })).toBe("group-1")
    expect(bestOfNGroupIdOf({ kind: "team", sourceId: "group-1" })).toBeUndefined()
    expect(bestOfNGroupIdOf({ kind: "best-of-n", sourceId: "" })).toBeUndefined()
  })
})
