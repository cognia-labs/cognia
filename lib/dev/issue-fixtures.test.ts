/**
 * @jest-environment jsdom
 */

import type { IssueActor } from "@/types/issues"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getAgentTask } from "@/lib/db/agent-tasks"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { getIssueRun } from "@/lib/db/issue-runs"
import { AGENT_TASK_RUN_ADAPTER_ID } from "@/lib/issues/run/agent-task-adapter"
import {
  cancelIssueRun,
  getIssueRunRegistry,
  resetIssueRunRegistry,
  startIssueRun,
} from "@/lib/issues/run/registry"
import type { IssueRunAdapter } from "@/lib/issues/run/types"
import {
  createE2EIssueFixtures,
  createFakeIssueRunEngine,
  ISSUE_BRIDGE_BOOT_TIMEOUT_MS,
} from "./issue-fixtures"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(resetIssueRunRegistry)

let activeWorkspace: string | null = null
beforeEach(() => {
  activeWorkspace = null
})
const fixturesFor = () => createE2EIssueFixtures({ activeWorkspaceId: () => activeWorkspace })

const HUMAN: IssueActor = { kind: "human" }

/** Stand-in for the adapter the tracker's boot registers under the same id. */
function bootAdapter(): IssueRunAdapter {
  return {
    id: AGENT_TASK_RUN_ADAPTER_ID,
    kind: "agent-task",
    canRun: async () => ({ ok: false, reason: "assignee-kind-mismatch" }),
    start: async () => {
      throw new Error("the real engine must not be reached")
    },
    poll: async () => null,
  }
}

async function seedIssue(status: "todo" | "backlog" = "todo") {
  const project = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
  return createIssue({
    projectId: "w1",
    issueProjectId: project.id,
    title: "Fix the flaky sync",
    createdBy: HUMAN,
    status,
  })
}

describe("createFakeIssueRunEngine", () => {
  it("accepts every issue and holds the item running until it is finished", async () => {
    const engine = createFakeIssueRunEngine("agent-task")
    expect(engine.adapter).toMatchObject({ id: "agent-task", kind: "agent-task" })
    const target = { issue: await seedIssue(), project: undefined }
    await expect(engine.adapter.canRun(target)).resolves.toEqual({ ok: true })

    const dispatch = await engine.adapter.start(target, {
      runId: "run_1",
      by: HUMAN,
      origin: "interactive",
    })
    expect(dispatch).toEqual({ targetId: "e2e-run:run_1", status: "running" })
    expect(engine.running()).toEqual(["e2e-run:run_1"])

    const run = { targetId: dispatch.targetId } as Parameters<IssueRunAdapter["poll"]>[0]
    await expect(engine.adapter.poll(run)).resolves.toBeNull()
    engine.finish(dispatch.targetId, "succeeded")
    expect(engine.running()).toEqual([])
    await expect(engine.adapter.poll(run)).resolves.toEqual({
      status: "succeeded",
      summary: "e2e run finished",
      artifacts: [],
    })
  })

  it("reports a failure, leaves a cancel to the bridge, and refuses to end an idle item", async () => {
    const engine = createFakeIssueRunEngine("agent-task")
    const target = { issue: await seedIssue(), project: undefined }
    const context = { by: HUMAN, origin: "interactive" as const }
    const failed = await engine.adapter.start(target, { ...context, runId: "a" })
    const cancelled = await engine.adapter.start(target, { ...context, runId: "b" })

    engine.finish(failed.targetId, "failed")
    await expect(
      engine.adapter.poll({ targetId: failed.targetId } as Parameters<IssueRunAdapter["poll"]>[0])
    ).resolves.toEqual({ status: "failed", error: "e2e run failed" })

    const cancelRun = { targetId: cancelled.targetId } as Parameters<IssueRunAdapter["poll"]>[0]
    await engine.adapter.cancel!(cancelRun)
    await expect(engine.adapter.poll(cancelRun)).resolves.toBeNull()
    expect(engine.running()).toEqual([])
    expect(() => engine.finish(cancelled.targetId, "succeeded")).toThrow(/not running/)
    expect(() => engine.finish(failed.targetId, "succeeded")).toThrow(/not running/)
  })

  it("fails a run it never started instead of holding it active", async () => {
    const engine = createFakeIssueRunEngine("agent-task")
    await expect(
      engine.adapter.poll({ targetId: "agent-task:real" } as Parameters<IssueRunAdapter["poll"]>[0])
    ).resolves.toEqual({ status: "failed", error: "the e2e engine has no record of this run" })
  })
})

describe("createE2EIssueFixtures", () => {
  it("replaces the booted agent-task adapter and drives a run through the real bridge", async () => {
    const registry = getIssueRunRegistry()
    registry.register(bootAdapter())
    const fixtures = fixturesFor()
    await fixtures.installFakeRunEngine()
    await fixtures.installFakeRunEngine() // idempotent
    const issue = await seedIssue()
    // The boot adapter refused this issue; the fake accepts it.
    await expect(
      registry.get(AGENT_TASK_RUN_ADAPTER_ID)!.canRun({ issue, project: undefined })
    ).resolves.toEqual({ ok: true })

    const run = await startIssueRun({
      issueId: issue.id,
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      by: HUMAN,
      origin: "interactive",
    })
    expect((await getIssue(issue.id))?.status).toBe("in_progress")

    await fixtures.finishActiveRun(issue.identifier, "succeeded")
    expect((await getIssueRun(run.id))?.status).toBe("succeeded")
    expect((await getIssue(issue.id))?.status).toBe("in_review")
  })

  it("lets the bridge hand a cancelled run's issue back to its column", async () => {
    getIssueRunRegistry().register(bootAdapter())
    const fixtures = fixturesFor()
    await fixtures.installFakeRunEngine()
    const issue = await seedIssue("backlog")
    const run = await startIssueRun({
      issueId: issue.id,
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      by: HUMAN,
      origin: "interactive",
    })
    await cancelIssueRun(run.id)
    expect((await getIssueRun(run.id))?.status).toBe("cancelled")
    expect((await getIssue(issue.id))?.status).toBe("backlog")
    await expect(fixtures.finishActiveRun(issue.identifier, "succeeded")).rejects.toThrow(
      /has no active run/
    )
  })

  it("refuses to finish before install, or an identifier nothing has", async () => {
    const fixtures = fixturesFor()
    await expect(fixtures.finishActiveRun("MERC-1", "succeeded")).rejects.toThrow(
      /installFakeRunEngine/
    )
    getIssueRunRegistry().register(bootAdapter())
    await fixtures.installFakeRunEngine()
    await expect(fixtures.finishActiveRun("MERC-404", "failed")).rejects.toThrow(
      /no issue is identified as MERC-404/
    )
  })

  it("throws when the tracker never registers its adapters", async () => {
    jest.useFakeTimers()
    try {
      const pending = fixturesFor().installFakeRunEngine()
      const settled = expect(pending).rejects.toThrow(/never registered its run adapters/)
      await jest.advanceTimersByTimeAsync(ISSUE_BRIDGE_BOOT_TIMEOUT_MS + 1)
      await settled
      expect(getIssueRunRegistry().has(AGENT_TASK_RUN_ADAPTER_ID)).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it("seeds agent tasks into the active workspace and moves them", async () => {
    const fixtures = fixturesFor()
    await expect(fixtures.seedAgentTask({ agentId: "c1", title: "Triage" })).rejects.toThrow(
      /no active workspace/
    )
    activeWorkspace = "w1"
    const id = await fixtures.seedAgentTask({ agentId: "c1", title: "Triage" })
    expect(await getAgentTask(id)).toMatchObject({
      agentId: "c1",
      projectId: "w1",
      title: "Triage",
      status: "pending",
    })
    await fixtures.moveAgentTask(id, "cancelled")
    expect((await getAgentTask(id))?.status).toBe("cancelled")
  })
})
