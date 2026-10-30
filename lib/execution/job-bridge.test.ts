/** @jest-environment jsdom */
import {
  registerDispatchContext,
  clearDispatchContext,
} from "@/lib/claude/agents/dispatch-context-registry"
import { getDb } from "@/lib/db/schema"
import { getExecutionRun, listExecutionRunEvents } from "@/lib/db/execution-runs"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { BackgroundTaskJournalRecord } from "@/lib/background-tasks/registry-core"
import { jobExecutionRunId, syncJobExecutionRun } from "./job-bridge"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const SOURCE = "bg-run-1"
const RUN_ID = jobExecutionRunId(SOURCE)

function record(overrides: Partial<BackgroundTaskJournalRecord> = {}): BackgroundTaskJournalRecord {
  return {
    runId: SOURCE,
    kind: "subagent",
    subagentId: "code-reviewer",
    prompt: "review /Users/someone/private/secret.ts and my API key sk-live-123",
    sessionId: "sess-1",
    host: "renderer",
    status: "running",
    startedAt: 1_000,
    ...overrides,
  }
}

const eventTypes = async () => (await listExecutionRunEvents(RUN_ID)).map((event) => event.type)

it("projects a running background task as a job run", async () => {
  await syncJobExecutionRun(record())
  expect((await getExecutionRun(RUN_ID))?.actingIdentity).toMatchObject({
    lane: "legacy",
    trigger: "child",
    requesters: [],
    authorityRevision: 0,
  })
  expect(await getExecutionRun(RUN_ID)).toMatchObject({
    kind: "job",
    sourceId: SOURCE,
    sessionId: "sess-1",
    title: "code-reviewer",
    status: "running",
  })
  expect(await eventTypes()).toEqual(["run.started"])
})

it("never copies the prompt into the journal", async () => {
  await syncJobExecutionRun(record())
  const serialized = JSON.stringify(await listExecutionRunEvents(RUN_ID))
  expect(serialized).not.toContain("sk-live-123")
  expect(serialized).not.toContain("/Users/someone/private")
})

it("never copies result text or an error message into the journal", async () => {
  await syncJobExecutionRun(record())
  await syncJobExecutionRun(
    record({
      status: "error",
      settledAt: 2_000,
      error: "ENOENT /Users/someone/private/secret.ts",
      resultText: "leaked answer",
    })
  )
  const serialized = JSON.stringify(await listExecutionRunEvents(RUN_ID))
  expect(serialized).not.toContain("/Users/someone/private")
  expect(serialized).not.toContain("leaked answer")
})

describe("status mapping", () => {
  it.each([
    ["done", "completed", "run.completed"],
    ["error", "failed", "run.failed"],
    // Its writer went away; the work did not go wrong.
    ["interrupted", "cancelled", "run.cancelled"],
  ] as const)("%s → %s", async (status, expected, event) => {
    await syncJobExecutionRun(record())
    await syncJobExecutionRun(record({ status, settledAt: 2_000 }))
    expect((await getExecutionRun(RUN_ID))?.status).toBe(expected)
    expect(await eventTypes()).toEqual(["run.started", event])
  })
})

it("projects a task that is already settled on first sight", async () => {
  await syncJobExecutionRun(record({ status: "done", settledAt: 2_000 }))
  expect((await getExecutionRun(RUN_ID))?.status).toBe("completed")
  expect(await eventTypes()).toEqual(["run.started", "run.completed"])
})

it("is idempotent — a re-emitted row does not duplicate events", async () => {
  const running = record()
  await syncJobExecutionRun(running)
  await syncJobExecutionRun(running)
  await syncJobExecutionRun(running)
  expect(await eventTypes()).toEqual(["run.started"])
})

it("does not reopen the journal of a settled run", async () => {
  await syncJobExecutionRun(record())
  const settled = record({ status: "done", settledAt: 2_000 })
  await syncJobExecutionRun(settled)
  await syncJobExecutionRun(settled)
  // The journal closes on settle; a repeat must be a no-op, not an error.
  expect(await eventTypes()).toEqual(["run.started", "run.completed"])
})

it("offers stop and open_details, but never steer or pause", async () => {
  await syncJobExecutionRun(record())
  const run = await getExecutionRun(RUN_ID)
  expect(run?.latestSnapshot?.allowedActions).toEqual(["stop", "open_details"])
})

it("offers only open_details once the task has settled", async () => {
  await syncJobExecutionRun(record())
  await syncJobExecutionRun(record({ status: "error", settledAt: 2_000 }))
  const run = await getExecutionRun(RUN_ID)
  expect(run?.latestSnapshot?.allowedActions).toEqual(["open_details"])
})

it("inherits from its active caller and never from a newer projected sibling", async () => {
  const actingIdentity = {
    schemaVersion: 1 as const,
    rootRunId: "parent",
    lane: "legacy" as const,
    trigger: "local" as const,
    requesters: [{ kind: "local-person" as const }],
    authorityRevision: 2,
  }
  const authority = {
    schemaVersion: 1 as const,
    permissionMode: "plan" as const,
    pools: { rootRunId: "parent", costUsd: 1 },
  }
  await getDb().executionRuns.add({
    id: "parent",
    kind: "agent-turn",
    sourceId: "parent",
    sessionId: "sess-1",
    title: "Caller",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    actingIdentity,
    authority,
  })
  await getDb().executionRuns.add({
    id: "sibling",
    kind: "job",
    sourceId: "other",
    sessionId: "sess-1",
    title: "Sibling",
    status: "running",
    currentRevision: 0,
    startedAt: 2,
    updatedAt: 2,
  })
  await syncJobExecutionRun(record())
  expect((await getExecutionRun(RUN_ID))?.actingIdentity).toEqual(actingIdentity)
  expect((await getExecutionRun(RUN_ID))?.authority).toEqual(authority)
})

it("inherits a nested foreground job's parent through the existing live dispatch context", async () => {
  const identity = {
    schemaVersion: 1 as const,
    rootRunId: jobExecutionRunId("parent-job"),
    lane: "legacy" as const,
    trigger: "local" as const,
    requesters: [{ kind: "local-person" as const }],
    authorityRevision: 3,
  }
  const authority = { schemaVersion: 1 as const, permissionMode: "plan" as const }
  await getDb().executionRuns.add({
    id: jobExecutionRunId("parent-job"),
    kind: "job",
    sourceId: "parent-job",
    sessionId: "grandparent-session",
    title: "Parent",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    actingIdentity: identity,
    authority,
  })
  registerDispatchContext("ephemeral-parent", {
    depth: 1,
    maxDepth: 3,
    parentChain: ["parent"],
    selfRunId: "parent-job",
  })
  try {
    await syncJobExecutionRun(record({ sessionId: "ephemeral-parent", mode: "foreground" }))
    expect((await getExecutionRun(RUN_ID))?.actingIdentity).toEqual(identity)
    expect((await getExecutionRun(RUN_ID))?.authority).toEqual(authority)
  } finally {
    clearDispatchContext("ephemeral-parent")
  }
})
