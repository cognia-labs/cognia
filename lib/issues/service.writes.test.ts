/**
 * @jest-environment jsdom
 */

/**
 * The service's write doors against the real database (plan 2026-11-05 §6):
 * what each refuses, what each does after the write, and that the two-step
 * create lands whole or not at all.
 */

const mockSyncSchedule = jest.fn(async () => ({ action: "skipped", bindingCount: 0 }))
jest.mock("./github-sync-schedule", () => ({
  syncGithubIssueSchedule: () => mockSyncSchedule(),
}))
const mockDiscard = jest.fn(async (_id: string) => undefined)
const mockRebase = jest.fn(async (_id: string) => ({ id: "row" }))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  discardCollabConflict: (id: string) => mockDiscard(id),
  rebaseCollabConflict: (id: string) => mockRebase(id),
}))

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { listIssueCycles } from "@/lib/db/issue-cycles"
import { createIssueProject, getIssueProject, listIssueProjects } from "@/lib/db/issue-projects"
import { claimIssueRun } from "@/lib/db/issue-runs"
import { createIssue, getIssue, listIssues } from "@/lib/db/issues"
import { listIssueEvents } from "@/lib/db/issue-events"
import type { IssueProjectResource } from "@/types/issues"
import {
  attachProjectResource,
  createIssueCycleRecord,
  createIssueProjectRecord,
  createIssueProjectWithFirstIssue,
  createIssueRecord,
  deleteIssueCycleRecord,
  deleteIssueProjectRecord,
  detachProjectResource,
  isIssueActor,
  linkIssueGithubRecord,
  acceptIssueDeliverableRecord,
  moveIssueRecord,
  parseIssueAction,
  reorderIssueRecords,
  resolveCollabConflict,
  updateIssueCycleRecord,
  updateIssueProjectRecord,
} from "./service"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
beforeEach(() => jest.clearAllMocks())

const HUMAN = { kind: "human" } as const
const REPO: IssueProjectResource = { kind: "github-repo", repoFullName: "acme/app", addedAt: 1 }
const ROOT: IssueProjectResource = { kind: "workspace-root", rootId: "root-1", addedAt: 1 }

function container(over: Partial<Parameters<typeof createIssueProject>[0]> = {}) {
  return createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC", ...over })
}

describe("parseIssueAction", () => {
  it("returns a well-formed action typed", () => {
    expect(parseIssueAction({ kind: "status", to: "done" })).toEqual({ kind: "status", to: "done" })
    expect(parseIssueAction({ kind: "assignee", to: null })).toEqual({ kind: "assignee", to: null })
    expect(parseIssueAction({ kind: "comment", body: "hi", mentions: ["u1"] })).toEqual({
      kind: "comment",
      body: "hi",
      mentions: ["u1"],
    })
    expect(parseIssueAction({ kind: "stage", to: 2 })).toEqual({ kind: "stage", to: 2 })
    expect(
      parseIssueAction({
        kind: "unlinkExternal",
        ref: { provider: "github", externalId: "a#1", url: "x" },
      })
    ).toEqual({ kind: "unlinkExternal", ref: { provider: "github", externalId: "a#1" } })
  })

  it.each([
    [null, /must be an object/],
    [{ kind: "teleport" }, /Unknown issue action/],
    [{ kind: "status", to: "shipped" }, /invalid to/],
    [{ kind: "priority", to: 3 }, /invalid to/],
    [{ kind: "title", to: "  " }, /invalid to/],
    [{ kind: "assignee", to: { kind: "robot" } }, /invalid to/],
    [{ kind: "addLabel" }, /invalid labelId/],
    [{ kind: "dueDate", to: "soon" }, /invalid to/],
    [{ kind: "estimate", to: Number.NaN }, /invalid to/],
    [{ kind: "stage", to: 0 }, /invalid to/],
    [{ kind: "triage", to: "later" }, /invalid to/],
    [{ kind: "linkExternal", ref: { provider: "github" } }, /invalid ref/],
    [{ kind: "comment", body: "" }, /invalid body/],
    [{ kind: "comment", body: "hi", mentions: [1] }, /invalid mentions/],
  ])("refuses %j", (raw, error) => {
    expect(() => parseIssueAction(raw)).toThrow(error)
  })

  it("knows a well-formed actor", () => {
    expect(isIssueActor({ kind: "agent", id: "a1", label: "A" })).toBe(true)
    expect(isIssueActor({ kind: "team" })).toBe(true)
    expect(isIssueActor({ kind: "robot" })).toBe(false)
    expect(isIssueActor({ kind: "human", id: 7 })).toBe(false)
    expect(isIssueActor("human")).toBe(false)
  })
})

describe("createIssueRecord validation", () => {
  it.each([
    [{ status: "shipped" }, /Unknown issue status/],
    [{ priority: "extreme" }, /Unknown issue priority/],
    [{ assignee: { kind: "robot" } }, /person, an agent or a team/],
    [{ stage: 0 }, /Invalid sub-issue stage/],
    [{ stage: 1.5 }, /Invalid sub-issue stage/],
    [{ parentId: "missing" }, /Unknown issue: missing/],
    [{ blockedBy: ["missing"] }, /Unknown issue: missing/],
    [{ cycleId: "missing" }, /Unknown cycle: missing/],
    [{ dueDate: Number.POSITIVE_INFINITY }, /due date/],
    [{ blockedBy: ["i1", 2] }, /blockedBy must be a list of strings/],
    [{ description: 5 }, /description must be text/],
  ])("refuses %j before writing", async (over, error) => {
    const { id } = await container()
    await expect(
      createIssueRecord({ issueProjectId: id, title: "T", by: HUMAN, ...(over as object) })
    ).rejects.toThrow(error)
    expect(await listIssues({ projectId: "w1" })).toEqual([])
  })

  it("refuses relations into another workspace", async () => {
    const home = await container()
    const away = await container({ projectId: "w2", key: "VEN", name: "Venus" })
    const foreign = await createIssueRecord({ issueProjectId: away.id, title: "Away", by: HUMAN })
    await expect(
      createIssueRecord({ issueProjectId: home.id, title: "T", by: HUMAN, parentId: foreign.id })
    ).rejects.toThrow(/Parent must be in the same workspace/)
    await expect(
      createIssueRecord({ issueProjectId: home.id, title: "T", by: HUMAN, blockedBy: [foreign.id] })
    ).rejects.toThrow(/Blocker must be in the same workspace/)
    const cycle = await createIssueCycleRecord({ projectId: "w2", kind: "cycle", name: "S" })
    await expect(
      createIssueRecord({ issueProjectId: home.id, title: "T", by: HUMAN, cycleId: cycle.id })
    ).rejects.toThrow(/Cycle must be in the same workspace/)
  })

  it("passes blockers through to the row", async () => {
    const { id } = await container()
    const blocker = await createIssueRecord({ issueProjectId: id, title: "Blocker", by: HUMAN })
    const blocked = await createIssueRecord({
      issueProjectId: id,
      title: "Blocked",
      by: HUMAN,
      blockedBy: [blocker.id],
    })
    expect((await getIssue(blocked.id))!.blockedBy).toEqual([blocker.id])
  })
})

describe("projects", () => {
  it("creates a container, refusing a taken key and bad fields", async () => {
    const project = await createIssueProjectRecord({
      projectId: "w1",
      name: "Mercury",
      key: "merc",
    })
    expect(project.key).toBe("MERC")
    await expect(
      createIssueProjectRecord({ projectId: "w1", name: "Again", key: "MERC" })
    ).rejects.toThrow(/already in use/)
    await expect(
      createIssueProjectRecord({ projectId: "w1", name: "Bad", status: "vanished" as never })
    ).rejects.toThrow(/Unknown project status/)
    await expect(
      createIssueProjectRecord({ projectId: "w1", name: "Late", startDate: 10, targetDate: 5 })
    ).rejects.toThrow(/due before it starts/)
    await expect(createIssueProjectRecord({ projectId: "", name: "No workspace" })).rejects.toThrow(
      /needs a workspace/
    )
  })

  it("creates a container with its first issue in one write", async () => {
    const { project, issue } = await createIssueProjectWithFirstIssue(
      { projectId: "w1", name: "Venus" },
      { title: "First", by: HUMAN }
    )
    expect(issue).toMatchObject({
      issueProjectId: project.id,
      projectId: "w1",
      identifier: `${project.key}-1`,
    })
    expect((await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)).toEqual(["created"])
  })

  it("leaves no empty container behind when the first issue is refused", async () => {
    await expect(
      createIssueProjectWithFirstIssue(
        { projectId: "w1", name: "Venus" },
        // A parent that does not exist fails inside the write, after the container.
        { title: "First", by: HUMAN, parentId: "missing" }
      )
    ).rejects.toThrow()
    expect(await listIssueProjects({ projectId: "w1" })).toEqual([])
  })

  it("updates a container, checking a lone date against the stored one", async () => {
    const project = await createIssueProjectRecord({
      projectId: "w1",
      name: "Mercury",
      startDate: 10,
    })
    await updateIssueProjectRecord(project.id, { status: "in_progress" })
    expect((await getIssueProject(project.id))!.status).toBe("in_progress")
    await expect(updateIssueProjectRecord(project.id, { targetDate: 5 })).rejects.toThrow(
      /due before it starts/
    )
    await expect(updateIssueProjectRecord(project.id, { name: " " })).rejects.toThrow(
      /name is required/
    )
    await expect(updateIssueProjectRecord("missing", { status: "paused" })).rejects.toThrow(
      /No project/
    )
  })

  it("re-reconciles the GitHub refresh only when a synced binding is involved", async () => {
    const project = await container()
    await attachProjectResource(project.id, ROOT)
    expect(mockSyncSchedule).not.toHaveBeenCalled()
    await attachProjectResource(project.id, REPO)
    expect(mockSyncSchedule).toHaveBeenCalledTimes(1)
    // Replacing a synced binding with an unsynced one still retires its refresh.
    const otherRoot: IssueProjectResource = { kind: "workspace-root", rootId: "root-2", addedAt: 2 }
    await attachProjectResource(project.id, otherRoot, REPO)
    expect(mockSyncSchedule).toHaveBeenCalledTimes(2)
    await detachProjectResource(project.id, ROOT)
    expect(mockSyncSchedule).toHaveBeenCalledTimes(2)
    await attachProjectResource(project.id, REPO)
    await detachProjectResource(project.id, REPO)
    expect(mockSyncSchedule).toHaveBeenCalledTimes(4)
    expect((await getIssueProject(project.id))!.resources.map((r) => r.kind)).toEqual([
      "workspace-root",
    ])
    await expect(attachProjectResource("missing", REPO)).rejects.toThrow(/No project/)
    await expect(detachProjectResource("missing", REPO)).rejects.toThrow(/No project/)
  })

  it("deletes a container, reconciling the refresh when it held a synced binding", async () => {
    const plain = await container()
    await deleteIssueProjectRecord(plain.id)
    expect(mockSyncSchedule).not.toHaveBeenCalled()
    const synced = await container({ key: "SYNC", resources: [REPO] })
    await deleteIssueProjectRecord(synced.id)
    expect(mockSyncSchedule).toHaveBeenCalledTimes(1)
    expect(await getIssueProject(synced.id)).toBeUndefined()
    await expect(deleteIssueProjectRecord(synced.id)).rejects.toThrow(/No project/)
  })
})

describe("cycles", () => {
  it("creates, updates and deletes, refusing bad fields and a foreign container", async () => {
    const home = await container()
    const foreign = await container({ projectId: "w2", key: "VEN", name: "Venus" })
    await expect(
      createIssueCycleRecord({ projectId: "w1", kind: "sprint" as never, name: "S1" })
    ).rejects.toThrow(/Unknown cycle kind/)
    await expect(
      createIssueCycleRecord({
        projectId: "w1",
        kind: "cycle",
        name: "S1",
        issueProjectId: foreign.id,
      })
    ).rejects.toThrow(/not in workspace w1/)
    const cycle = await createIssueCycleRecord({
      projectId: "w1",
      kind: "cycle",
      name: "S1",
      issueProjectId: home.id,
    })
    await updateIssueCycleRecord(cycle.id, { status: "active" })
    await expect(updateIssueCycleRecord(cycle.id, { name: "" })).rejects.toThrow(/name is required/)
    await expect(updateIssueCycleRecord(cycle.id, { status: "paused" as never })).rejects.toThrow(
      /Unknown cycle status/
    )
    await expect(updateIssueCycleRecord(cycle.id, { issueProjectId: foreign.id })).rejects.toThrow(
      /not in workspace w1/
    )
    expect((await listIssueCycles({ projectId: "w1" }))[0]).toMatchObject({
      status: "active",
      name: "S1",
    })
    await deleteIssueCycleRecord(cycle.id)
    expect(await listIssueCycles({ projectId: "w1" })).toEqual([])
    await expect(deleteIssueCycleRecord(cycle.id)).rejects.toThrow(/No cycle/)
  })
})

describe("issue writes", () => {
  it("moves through moveIssue's own gate and refuses an unknown status", async () => {
    const { id } = await container()
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: id,
      title: "T",
      createdBy: HUMAN,
    })
    expect(await moveIssueRecord({ id: issue.id, to: "done", by: HUMAN })).toBeNull()
    await expect(
      moveIssueRecord({ id: issue.id, to: "shipped" as never, by: HUMAN })
    ).rejects.toThrow(/Unknown issue status/)
    // The run lock is read inside the write, whoever calls.
    await getDb().issues.update(issue.id, { status: "todo", statusCategory: "unstarted" })
    await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      targetId: "t1",
      by: HUMAN,
    })
    expect(await moveIssueRecord({ id: issue.id, to: "in_progress", by: HUMAN })).not.toBeNull()
  })

  it("reorders, refusing a non-finite order", async () => {
    const { id } = await container()
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: id,
      title: "T",
      createdBy: HUMAN,
    })
    await reorderIssueRecords([{ sourceId: issue.id, order: 5 }])
    expect((await getIssue(issue.id))!.order).toBe(5)
    await expect(reorderIssueRecords([{ sourceId: issue.id, order: Number.NaN }])).rejects.toThrow(
      /finite order/
    )
  })

  it("links a GitHub issue with a derived URL and refuses a malformed target", async () => {
    const { id } = await container()
    const issue = await createIssue({
      projectId: "w1",
      issueProjectId: id,
      title: "T",
      createdBy: HUMAN,
    })
    const ref = await linkIssueGithubRecord(
      issue.id,
      { repoFullName: " acme/app ", number: 7 },
      HUMAN
    )
    expect(ref).toEqual({
      repoFullName: "acme/app",
      number: 7,
      htmlUrl: "https://github.com/acme/app/issues/7",
    })
    expect((await getIssue(issue.id))!.githubRef).toEqual(ref)
    await expect(
      linkIssueGithubRecord(issue.id, { repoFullName: "not a repo", number: 7 }, HUMAN)
    ).rejects.toThrow(/owner\/repository/)
    await expect(
      linkIssueGithubRecord(issue.id, { repoFullName: "acme/app", number: 0 }, HUMAN)
    ).rejects.toThrow(/positive whole number/)
    await expect(
      linkIssueGithubRecord("missing", { repoFullName: "acme/app", number: 1 }, HUMAN)
    ).rejects.toThrow(/No issue/)
  })

  it("refuses to accept a delivery without its identity", async () => {
    await expect(acceptIssueDeliverableRecord("", "d", "sha")).rejects.toThrow(/needs its run/)
    await expect(acceptIssueDeliverableRecord("r", "d", "sha")).rejects.toThrow(
      /changed or is unavailable/
    )
  })
})

describe("resolveCollabConflict", () => {
  it("routes the choice and refuses an unknown one", async () => {
    await resolveCollabConflict("row-1", "discard")
    expect(mockDiscard).toHaveBeenCalledWith("row-1")
    await resolveCollabConflict("row-2", "rebase")
    expect(mockRebase).toHaveBeenCalledWith("row-2")
    await expect(resolveCollabConflict("row-3", "merge" as never)).rejects.toThrow(
      /Unknown conflict choice/
    )
  })
})
