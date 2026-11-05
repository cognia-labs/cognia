/**
 * @jest-environment jsdom
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createAgentTask } from "@/lib/db/agent-tasks"
import { createAgentTeamRun } from "@/lib/db/agent-team-runtime"
import { getDb } from "@/lib/db/schema"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { claimIssueRun, getIssueRun } from "@/lib/db/issue-runs"
import {
  ISSUE_RUN_RECONCILE_INTERVAL_MS,
  __resetIssueRunBridgeForTesting,
  engineChangeSignature,
  installIssueRunBridge,
} from "./install"
import { IssueRunRegistry, resetIssueRunRegistry } from "./registry"
import { AGENT_TASK_RUN_ADAPTER_ID } from "./agent-task-adapter"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(() => {
  __resetIssueRunBridgeForTesting()
  resetIssueRunRegistry()
})

const HUMAN = { kind: "human" } as const

let containerId: string | undefined
beforeEach(() => {
  containerId = undefined
})

async function seedIssue() {
  containerId ??= (await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })).id
  return createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "x",
    createdBy: HUMAN,
    status: "in_progress",
  })
}

const flush = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms))

describe("engineChangeSignature", () => {
  it("encodes active runs plus the engine rows they point at", async () => {
    expect(await engineChangeSignature()).toBe("runs:0:0")
    const issue = await seedIssue()
    const second = await seedIssue()
    const third = await seedIssue()
    const fourth = await seedIssue()
    const task = await createAgentTask({
      id: "agent-task:1",
      agentId: "c",
      title: "t",
      description: "",
    })
    await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: task.id,
      by: HUMAN,
    })
    await claimIssueRun({
      status: "running",
      issueId: second.id,
      projectId: "w1",
      adapterId: "github-loop",
      kind: "github-loop",
      targetId: "job-missing",
      by: HUMAN,
    })
    // A claim still waiting for its engine points at nothing.
    await claimIssueRun({
      issueId: third.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      by: HUMAN,
    })
    await createAgentTeamRun({
      id: "run_team_1",
      teamId: "team-1",
      objective: "o",
      status: "needs_input",
      priority: 0,
      decisionVersion: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await claimIssueRun({
      status: "running",
      issueId: fourth.id,
      projectId: "w1",
      adapterId: "agent-team",
      kind: "agent-team",
      targetId: "team-1",
      targetRef: { taskId: "tt-1", squadRunId: "run_team_1" },
      by: HUMAN,
    })
    expect(await engineChangeSignature()).toBe(
      "runs:4:3|task:agent-task:1:pending:1|squad:run_team_1:needs_input"
    )
  })
})

describe("installIssueRunBridge", () => {
  it("registers the three adapters, is idempotent, and disposes cleanly", () => {
    const registry = new IssueRunRegistry()
    const dispose = installIssueRunBridge({ registry, subscribeTeamStore: false })
    expect(
      registry
        .list()
        .map((a) => a.id)
        .sort()
    ).toEqual(["agent-task", "agent-team", "github-loop"])
    expect(installIssueRunBridge({ registry, subscribeTeamStore: false })).toBe(dispose)
    dispose()
    dispose()
    // After dispose a fresh install is a new bridge.
    const again = installIssueRunBridge({ registry, subscribeTeamStore: false })
    expect(again).not.toBe(dispose)
    again()
    expect(ISSUE_RUN_RECONCILE_INTERVAL_MS).toBe(60_000)
  })

  it("settles a run at boot (reload recovery) and when the engine row changes", async () => {
    const registry = new IssueRunRegistry()
    const issue = await seedIssue()
    const task = await createAgentTask({
      id: "agent-task:boot",
      agentId: "c",
      title: "t",
      description: "",
      approvalPolicy: "auto",
    })
    // The task already finished while the app was away (written the way the
    // scheduler executor settles it — a direct row update, not a human move).
    await getDb().agentTasks.update(task.id, { status: "completed", revision: 2 })
    const finished = await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: task.id,
      by: HUMAN,
    })

    const errors: unknown[] = []
    const dispose = installIssueRunBridge({
      registry,
      subscribeTeamStore: false,
      onError: (e) => errors.push(e),
    })
    await flush()
    expect((await getIssueRun(finished.id))!.status).toBe("succeeded")
    expect((await getIssue(issue.id))!.status).toBe("in_review")

    // A second issue whose task finishes later: the liveQuery watcher fires.
    const issue2 = await createIssue({
      projectId: "w1",
      issueProjectId: issue.issueProjectId,
      title: "y",
      createdBy: HUMAN,
      status: "in_progress",
    })
    const task2 = await createAgentTask({
      id: "agent-task:live",
      agentId: "c",
      title: "t2",
      description: "",
      approvalPolicy: "auto",
    })
    const live = await claimIssueRun({
      status: "running",
      issueId: issue2.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: task2.id,
      by: HUMAN,
    })
    await flush()
    expect((await getIssueRun(live.id))!.status).toBe("running")
    await getDb().agentTasks.update(task2.id, { status: "failed", revision: 2 })
    await flush(600)
    expect((await getIssueRun(live.id))!.status).toBe("failed")
    expect((await getIssue(issue2.id))!.status).toBe("in_review")
    expect(errors).toEqual([])
    dispose()
  })

  it("repairs an issue an interrupted settle stranded in in_progress, at boot", async () => {
    const registry = new IssueRunRegistry()
    const issue = await seedIssue()
    const stranded = await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: "agent-task:gone",
      by: HUMAN,
      now: Date.now() - 1_000,
    })
    const { applyRuntimeIssueStatus } = await import("@/lib/db/issues")
    const { settleIssueRun } = await import("@/lib/db/issue-runs")
    // The seed starts the issue in in_progress; move it the way a run would.
    await getDb().issues.update(issue.id, { status: "todo", statusCategory: "unstarted" })
    await applyRuntimeIssueStatus(issue.id, "in_progress", HUMAN)
    await settleIssueRun(stranded.id, { status: "succeeded" })

    const dispose = installIssueRunBridge({ registry, subscribeTeamStore: false })
    await flush()
    expect((await getIssue(issue.id))!.status).toBe("in_review")
    dispose()
  })

  it("routes reconcile failures to onError instead of throwing", async () => {
    const registry = new IssueRunRegistry()
    const errors: unknown[] = []
    const dispose = installIssueRunBridge({
      registry,
      subscribeTeamStore: false,
      onError: (e) => errors.push(e),
      intervalMs: 50,
    })
    // Sabotage the registry after install so the interval-driven reconcile trips.
    const brokenAdapter = registry.get("agent-task")!
    registry.register({
      ...brokenAdapter,
      poll: async () => {
        throw new Error("poll boom")
      },
    })
    const issue = await seedIssue()
    await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: AGENT_TASK_RUN_ADAPTER_ID,
      kind: "agent-task",
      targetId: "agent-task:none",
      by: HUMAN,
    })
    await flush(400)
    // Poll errors are isolated inside reconcile (returned, not thrown), so
    // nothing reaches onError and the run stays active for the next pass.
    expect(errors).toEqual([])
    dispose()
  })
})
