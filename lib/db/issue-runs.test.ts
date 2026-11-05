/**
 * @jest-environment jsdom
 */

import type { IssueActor } from "@/types/issues"
import { createDbTestFixture } from "./test-fixture"
import { createIssueProject, deleteIssueProject } from "./issue-projects"
import { createIssue, deleteIssue } from "./issues"
import { listIssueEvents } from "./issue-events"
import {
  acceptIssueDeliverable,
  bindIssueRunDispatch,
  claimIssueRun,
  isUnboundIssueRun,
  IssueRunActiveError,
  deleteIssueRuns,
  deleteIssueRunsForIssues,
  getIssueRun,
  getIssueRunByTarget,
  hasActiveIssueRun,
  linkIssueRunArtifact,
  listActiveIssueRunIssueIds,
  listIssueRuns,
  mapIssueRunsByTarget,
  markIssueRunRunning,
  settleIssueRun,
} from "./issue-runs"
import { createDeliveryReceipt } from "@/lib/issues/deliverables"

it("keeps versions of the same URL and confirms only the selected receipt, idempotently", async () => {
  const run = await start()
  const href = "https://example.com/report"
  const first = createDeliveryReceipt(href, { externalVersion: "commit:1" })
  const second = createDeliveryReceipt(href, { externalVersion: "commit:2" })
  for (const delivery of [first, first, second])
    await linkIssueRunArtifact(run.id, { href, label: "Report", deliverable: true, delivery })
  expect((await getIssueRun(run.id))?.artifacts).toHaveLength(2)
  await expect(acceptIssueDeliverable(run.id, first.id, second.digest)).rejects.toThrow(
    "version changed"
  )
  expect(await acceptIssueDeliverable(run.id, first.id, first.digest, 123)).toBe(123)
  expect(await acceptIssueDeliverable(run.id, first.id, first.digest, 456)).toBe(123)
  expect((await getIssueRun(run.id))?.artifacts.map((row) => row.delivery?.acceptedAt)).toEqual([
    123,
    undefined,
  ])
  expect((await kindsOf(issueId)).filter((kind) => kind === "deliverable_accepted")).toHaveLength(1)
  await expect(
    linkIssueRunArtifact(run.id, { href, label: "forged", delivery: { ...second, acceptedAt: 1 } })
  ).rejects.toThrow("Invalid delivery")
  await expect(
    settleIssueRun(run.id, {
      status: "succeeded",
      artifacts: [
        {
          href: "https://example.com/other",
          label: "forged",
          delivery: { ...second, acceptedAt: 1 },
        },
      ],
    })
  ).rejects.toThrow("Invalid delivery")
  expect((await getIssueRun(run.id))?.status).toBe("running")
})

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const HUMAN: IssueActor = { kind: "human" }

let projectId: string
let issueId: string

beforeEach(async () => {
  projectId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
  issueId = (
    await createIssue({ projectId: "w1", issueProjectId: projectId, title: "x", createdBy: HUMAN })
  ).id
})

/** A bound, running claim on `issueId` (or `over.issueId`). */
function start(over: Partial<Parameters<typeof claimIssueRun>[0]> = {}) {
  return claimIssueRun({
    issueId,
    projectId: "w1",
    adapterId: "agent-task",
    kind: "agent-task",
    targetId: "agent-task:1",
    status: "running",
    by: HUMAN,
    ...over,
  })
}

/** A fresh issue in the same container, for tests that need several active runs. */
async function anotherIssue(title = "y"): Promise<string> {
  return (
    await createIssue({ projectId: "w1", issueProjectId: projectId, title, createdBy: HUMAN })
  ).id
}

async function kindsOf(id: string) {
  return (await listIssueEvents({ issueId: id })).map((e) => e.kind)
}

describe("claimIssueRun", () => {
  it("stores a wakeup's lineage on the row", async () => {
    const wakeup = {
      taskId: "wk1",
      chain: ["wk0", "wk1"],
      statusBefore: "todo" as const,
      periodic: true,
    }
    const run = await claimIssueRun({
      issueId,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      by: HUMAN,
      wakeup,
    })
    expect((await getIssueRun(run.id))!.wakeup).toEqual(wakeup)
  })

  it("writes an unbound queued claim and appends run_started in one go", async () => {
    const run = await claimIssueRun({
      issueId,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      by: HUMAN,
      now: 5,
    })
    expect(run).toMatchObject({ status: "queued", targetId: "", startedAt: 5, artifacts: [] })
    expect(isUnboundIssueRun(run)).toBe(true)
    expect(await getIssueRun(run.id)).toEqual(run)
    expect(await kindsOf(issueId)).toEqual(["created", "run_started"])
  })

  it("binds a target known at claim time", async () => {
    const run = await start({ targetRef: { taskId: "tt-1" } })
    expect(run).toMatchObject({ status: "running", targetId: "agent-task:1" })
    expect(run.targetRef).toEqual({ taskId: "tt-1" })
    expect(isUnboundIssueRun(run)).toBe(false)
  })

  it("refuses a second claim while one is active, and writes nothing for it", async () => {
    const first = await start()
    await expect(start()).rejects.toEqual(new IssueRunActiveError(issueId, first.id))
    await expect(start()).rejects.toBeInstanceOf(IssueRunActiveError)
    expect(await listIssueRuns({ issueId })).toHaveLength(1)
    expect((await kindsOf(issueId)).filter((kind) => kind === "run_started")).toHaveLength(1)
    await settleIssueRun(first.id, { status: "succeeded" })
    expect((await start()).id).not.toBe(first.id)
  })

  it("lets exactly one of two racing claims through", async () => {
    const outcomes = await Promise.allSettled([start(), start(), start()])
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    expect(await listIssueRuns({ issueId, activeOnly: true })).toHaveLength(1)
  })
})

describe("bindIssueRunDispatch", () => {
  it("records the engine item and statusBefore onto the claim", async () => {
    const claim = await claimIssueRun({
      issueId,
      projectId: "w1",
      adapterId: "agent-team",
      kind: "agent-team",
      by: HUMAN,
    })
    const bound = await bindIssueRunDispatch(
      claim.id,
      { targetId: "team-1", targetRef: { taskId: "t-1" }, status: "running" },
      "backlog",
      42
    )
    expect(bound).toMatchObject({
      targetId: "team-1",
      targetRef: { taskId: "t-1" },
      status: "running",
      statusBefore: "backlog",
      updatedAt: 42,
    })
    expect(await getIssueRun(claim.id)).toEqual(bound)
  })

  it("returns undefined for a claim that was settled meanwhile", async () => {
    const claim = await claimIssueRun({
      issueId,
      projectId: "w1",
      adapterId: "agent-task",
      kind: "agent-task",
      by: HUMAN,
    })
    await settleIssueRun(claim.id, { status: "cancelled" })
    expect(
      await bindIssueRunDispatch(claim.id, { targetId: "t", status: "running" }, "todo")
    ).toBeUndefined()
    expect((await getIssueRun(claim.id))!.targetId).toBe("")
    expect(
      await bindIssueRunDispatch("missing", { targetId: "t", status: "running" }, "todo")
    ).toBeUndefined()
  })
})

describe("listIssueRuns", () => {
  it("filters by issue, project, status and activeOnly, newest first", async () => {
    const a = await start({ now: 1 })
    await settleIssueRun(a.id, { status: "succeeded" })
    const b = await start({ now: 2, status: "queued" })
    // A second workspace needs its own container: an issue whose workspace
    // disagrees with its container's is refused at write time.
    const otherContainer = (
      await createIssueProject({ projectId: "w2", name: "Venus", key: "VEN" })
    ).id
    const other = await createIssue({
      projectId: "w2",
      issueProjectId: otherContainer,
      title: "y",
      createdBy: HUMAN,
    })
    const c = await start({ issueId: other.id, projectId: "w2", now: 3 })

    expect((await listIssueRuns({ issueId })).map((r) => r.id)).toEqual([b.id, a.id])
    expect((await listIssueRuns({ issueId, status: "succeeded" })).map((r) => r.id)).toEqual([a.id])
    expect((await listIssueRuns({ issueId, activeOnly: true })).map((r) => r.id)).toEqual([b.id])
    expect((await listIssueRuns({ projectId: "w2" })).map((r) => r.id)).toEqual([c.id])
    expect((await listIssueRuns({ projectId: "w1", status: "queued" })).map((r) => r.id)).toEqual([
      b.id,
    ])
    expect((await listIssueRuns({ status: "running" })).map((r) => r.id)).toEqual([c.id])
    expect((await listIssueRuns({ activeOnly: true })).map((r) => r.id)).toEqual([c.id, b.id])
    expect(await listIssueRuns()).toHaveLength(3)
  })
})

describe("active-run queries", () => {
  it("hasActiveIssueRun / listActiveIssueRunIssueIds track queued and running only", async () => {
    expect(await hasActiveIssueRun(issueId)).toBe(false)
    const queued = await start({ status: "queued" })
    expect(await hasActiveIssueRun(issueId)).toBe(true)
    expect(await listActiveIssueRunIssueIds("w1")).toEqual(new Set([issueId]))
    expect(await listActiveIssueRunIssueIds("w-other")).toEqual(new Set())

    await markIssueRunRunning(queued.id)
    expect((await getIssueRun(queued.id))!.status).toBe("running")
    expect(await hasActiveIssueRun(issueId)).toBe(true)

    await settleIssueRun(queued.id, { status: "failed", error: "boom" })
    expect(await hasActiveIssueRun(issueId)).toBe(false)
    expect(await listActiveIssueRunIssueIds("w1")).toEqual(new Set())
  })

  it("markIssueRunRunning is a no-op unless the run is queued", async () => {
    const running = await start()
    await markIssueRunRunning(running.id, 99)
    expect((await getIssueRun(running.id))!.updatedAt).not.toBe(99)
    await markIssueRunRunning("missing")
  })
})

describe("target lookups", () => {
  it("getIssueRunByTarget returns the newest run of that kind for the target", async () => {
    await start({ targetId: "shared", now: 1 })
    const newer = await start({ issueId: await anotherIssue(), targetId: "shared", now: 2 })
    await start({
      issueId: await anotherIssue("z"),
      targetId: "shared",
      kind: "agent-team",
      adapterId: "agent-team",
      now: 3,
    })
    expect((await getIssueRunByTarget("agent-task", "shared"))!.id).toBe(newer.id)
    expect(await getIssueRunByTarget("github-loop", "shared")).toBeUndefined()
    expect(await getIssueRunByTarget("agent-task", "nope")).toBeUndefined()
  })

  it("mapIssueRunsByTarget indexes the newest run per target for a kind", async () => {
    await start({ targetId: "t1", now: 1 })
    const t1 = await start({ issueId: await anotherIssue("b"), targetId: "t1", now: 2 })
    const t2 = await start({ issueId: await anotherIssue("c"), targetId: "t2", now: 1 })
    await start({
      issueId: await anotherIssue("d"),
      targetId: "t3",
      kind: "agent-team",
      adapterId: "agent-team",
    })
    const map = await mapIssueRunsByTarget("w1", "agent-task")
    expect([...map.keys()].sort()).toEqual(["t1", "t2"])
    expect(map.get("t1")!.id).toBe(t1.id)
    expect(map.get("t2")!.id).toBe(t2.id)
  })
})

describe("linkIssueRunArtifact", () => {
  it("appends the artifact and an artifact_linked event, once per href", async () => {
    const run = await start()
    await linkIssueRunArtifact(run.id, { label: "PR #1", href: "https://x/1" })
    await linkIssueRunArtifact(run.id, { label: "PR #1 again", href: "https://x/1" })
    await linkIssueRunArtifact("missing", { label: "n", href: "h" })
    expect((await getIssueRun(run.id))!.artifacts).toEqual([
      { label: "PR #1", href: "https://x/1" },
    ])
    expect(await kindsOf(issueId)).toEqual(["created", "run_started", "artifact_linked"])
  })
})

describe("settleIssueRun", () => {
  it("succeeded: stamps endedAt, summary, artifacts and run_succeeded", async () => {
    const run = await start()
    const settled = await settleIssueRun(
      run.id,
      { status: "succeeded", summary: "did it", artifacts: [{ label: "branch", href: "b" }] },
      77
    )
    expect(settled).toMatchObject({
      status: "succeeded",
      endedAt: 77,
      summary: "did it",
      artifacts: [{ label: "branch", href: "b" }],
    })
    expect(await kindsOf(issueId)).toEqual([
      "created",
      "run_started",
      "artifact_linked",
      "run_succeeded",
    ])
    const events = await listIssueEvents({ issueId })
    expect(events.at(-1)!.payload).toMatchObject({ kind: "run_succeeded", summary: "did it" })
  })

  it("failed: records the error and run_failed", async () => {
    const run = await start()
    expect((await settleIssueRun(run.id, { status: "failed", error: "boom" }))!.error).toBe("boom")
    const events = await listIssueEvents({ issueId })
    expect(events.at(-1)!.payload).toEqual({
      kind: "run_failed",
      runId: run.id,
      adapterId: run.adapterId,
      error: "boom",
    })
  })

  it("cancelled: says run_cancelled, never run_failed, and keeps a reason on the row", async () => {
    const plain = await start()
    const plainSettled = await settleIssueRun(plain.id, { status: "cancelled" })
    expect(plainSettled).toMatchObject({ status: "cancelled" })
    expect(plainSettled!.error).toBeUndefined()
    const reasoned = await start()
    expect(
      (await settleIssueRun(reasoned.id, { status: "cancelled", reason: "squad run terminated" }))!
        .error
    ).toBe("squad run terminated")
    const events = await listIssueEvents({ issueId })
    expect(events.some((e) => e.kind === "run_failed")).toBe(false)
    expect(events.filter((e) => e.kind === "run_cancelled").map((e) => e.payload)).toEqual([
      { kind: "run_cancelled", runId: plain.id, adapterId: plain.adapterId },
      {
        kind: "run_cancelled",
        runId: reasoned.id,
        adapterId: reasoned.adapterId,
        reason: "squad run terminated",
      },
    ])
  })

  it("is one-shot: a second settle or a missing run returns undefined", async () => {
    const run = await start()
    await settleIssueRun(run.id, { status: "succeeded" })
    expect(await settleIssueRun(run.id, { status: "failed", error: "late" })).toBeUndefined()
    expect(await settleIssueRun("missing", { status: "succeeded" })).toBeUndefined()
    expect((await getIssueRun(run.id))!.status).toBe("succeeded")
  })

  it("checkin: settles succeeded with the note, and says run_checked_in rather than run_succeeded", async () => {
    const run = await start()
    const settled = await settleIssueRun(
      run.id,
      { status: "succeeded", mode: "checkin", note: "all quiet" },
      9
    )
    expect(settled).toMatchObject({ status: "succeeded", summary: "all quiet", endedAt: 9 })
    const events = await listIssueEvents({ issueId })
    expect(events.at(-1)!.payload).toEqual({
      kind: "run_checked_in",
      runId: run.id,
      adapterId: run.adapterId,
      note: "all quiet",
    })
    expect(events.some((event) => event.kind === "run_succeeded")).toBe(false)
  })

  it("does not duplicate an artifact already linked", async () => {
    const run = await start()
    await linkIssueRunArtifact(run.id, { label: "a", href: "h" })
    const settled = await settleIssueRun(run.id, {
      status: "succeeded",
      artifacts: [{ label: "a2", href: "h" }],
    })
    expect(settled!.artifacts).toEqual([{ label: "a", href: "h" }])
  })
})

describe("cascade", () => {
  it("deleteIssueRuns / deleteIssueRunsForIssues remove only the targeted issues' runs", async () => {
    const other = await createIssue({
      projectId: "w1",
      issueProjectId: projectId,
      title: "y",
      createdBy: HUMAN,
    })
    await start()
    await start({ issueId: other.id })
    await deleteIssueRuns(issueId)
    expect(await listIssueRuns({ issueId })).toEqual([])
    expect(await listIssueRuns({ issueId: other.id })).toHaveLength(1)
    await deleteIssueRunsForIssues([])
    await deleteIssueRunsForIssues([other.id])
    expect(await listIssueRuns({ issueId: other.id })).toEqual([])
  })

  it("deleteIssue and deleteIssueProject cascade to runs", async () => {
    const other = await createIssue({
      projectId: "w1",
      issueProjectId: projectId,
      title: "y",
      createdBy: HUMAN,
    })
    await start()
    await start({ issueId: other.id })
    await deleteIssue(issueId)
    expect(await listIssueRuns({ issueId })).toEqual([])
    await deleteIssueProject(projectId)
    expect(await listIssueRuns({ issueId: other.id })).toEqual([])
  })
})
