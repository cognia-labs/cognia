/**
 * @jest-environment jsdom
 */

import type { IssueActor, IssueRun } from "@/types/issues"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import {
  claimIssueRun,
  getIssueRun,
  ISSUE_RUN_DISPATCH_STALE_MS,
  listIssueRuns,
  settleIssueRun,
} from "@/lib/db/issue-runs"
import { listIssueEvents } from "@/lib/db/issue-events"
import {
  IssueRunRefusedError,
  IssueRunRegistry,
  cancelIssueRun,
  checkInIssueRun,
  getIssueRunRegistry,
  issueRunSessionIds,
  steerIssueRun,
  listIssueRunOptions,
  loadIssueRunTarget,
  reconcileIssueRuns,
  registerIssueRunAdapter,
  repairStrandedIssues,
  resetIssueRunRegistry,
  runStatusBefore,
  runtimeActorFor,
  settleIssueRunAndIssue,
  startIssueRun,
} from "./registry"
import type { IssueRunAdapter, IssueRunPollResult, IssueRunTarget } from "./types"
import { isNamedRunOrigin } from "./types"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(resetIssueRunRegistry)

const HUMAN: IssueActor = { kind: "human" }

let projectId: string

beforeEach(async () => {
  projectId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
})

function makeIssue(over: Partial<Parameters<typeof createIssue>[0]> = {}) {
  return createIssue({
    projectId: "w1",
    issueProjectId: projectId,
    title: "x",
    createdBy: HUMAN,
    status: "todo",
    ...over,
  })
}

/** A controllable adapter: canRun / poll driven by the test. */
function fakeAdapter(
  over: Partial<IssueRunAdapter> & { pollResult?: IssueRunPollResult } = {}
): IssueRunAdapter & { starts: IssueRunTarget[]; cancels: IssueRun[] } {
  const starts: IssueRunTarget[] = []
  const cancels: IssueRun[] = []
  const adapter: IssueRunAdapter & { starts: IssueRunTarget[]; cancels: IssueRun[] } = {
    id: "fake",
    kind: "agent-task",
    starts,
    cancels,
    canRun: async () => ({ ok: true }),
    start: async (target) => {
      starts.push(target)
      return { targetId: "t-1", status: "running" }
    },
    poll: async () => over.pollResult ?? null,
    cancel: async (run) => {
      cancels.push(run)
    },
    ...over,
  }
  return adapter
}

describe("IssueRunRegistry", () => {
  it("registers last-write-wins, lists by kind, and resolves waiters", async () => {
    const registry = new IssueRunRegistry()
    expect(registry.has("fake")).toBe(false)
    const waiting = registry.waitFor("fake", 1_000)
    registry.register(fakeAdapter())
    expect(await waiting).toBe(true)
    expect(registry.get("fake")?.id).toBe("fake")
    expect(registry.listByKind("agent-task")).toHaveLength(1)
    expect(registry.listByKind("github-loop")).toHaveLength(0)
    registry.register(fakeAdapter({ kind: "agent-team" }))
    expect(registry.list()).toHaveLength(1)
    expect(registry.get("fake")?.kind).toBe("agent-team")
    expect(await registry.waitFor("fake", 10)).toBe(true)
    registry.unregister("fake")
    expect(await registry.waitFor("fake", 5)).toBe(false)
    registry.register(fakeAdapter())
    registry.clear()
    expect(registry.list()).toEqual([])
  })

  it("exposes a lazily created singleton", () => {
    const first = getIssueRunRegistry()
    expect(getIssueRunRegistry()).toBe(first)
    registerIssueRunAdapter(fakeAdapter())
    expect(first.has("fake")).toBe(true)
    resetIssueRunRegistry()
    expect(getIssueRunRegistry()).not.toBe(first)
  })
})

describe("loadIssueRunTarget / listIssueRunOptions", () => {
  it("loads the issue with its container and asks every adapter", async () => {
    const issue = await makeIssue()
    const target = await loadIssueRunTarget(issue.id)
    expect(target?.issue.id).toBe(issue.id)
    expect(target?.project?.key).toBe("MERC")
    expect(await loadIssueRunTarget("missing")).toBeUndefined()

    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    registry.register(
      fakeAdapter({ id: "refuser", canRun: async () => ({ ok: false, reason: "no-github-ref" }) })
    )
    const options = await listIssueRunOptions(issue.id, registry)
    expect(options.map((o) => [o.adapter.id, o.verdict.ok])).toEqual([
      ["fake", true],
      ["refuser", false],
    ])
    expect(await listIssueRunOptions("missing", registry)).toEqual([])
  })

  it("applies the tracker-level refusals to every adapter", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    const done = await makeIssue({ status: "done" })
    expect((await listIssueRunOptions(done.id, registry))[0].verdict).toEqual({
      ok: false,
      reason: "issue-finished",
    })
    const busy = await makeIssue()
    await claimIssueRun({
      status: "running",
      issueId: busy.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
    })
    expect((await listIssueRunOptions(busy.id, registry))[0].verdict).toEqual({
      ok: false,
      reason: "run-active",
    })
  })

  it("refuses a blocked issue and names the open blockers, not the finished ones", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    const { addIssueBlocker, moveIssue } = await import("@/lib/db/issues")
    const open = await makeIssue()
    const finished = await makeIssue()
    await moveIssue({ id: finished.id, to: "done", by: HUMAN })
    const target = await makeIssue()
    await addIssueBlocker(target.id, open.id, HUMAN)
    await addIssueBlocker(target.id, finished.id, HUMAN)
    expect((await listIssueRunOptions(target.id, registry))[0].verdict).toEqual({
      ok: false,
      reason: "blocked",
      detail: open.identifier,
    })
    await moveIssue({ id: open.id, to: "done", by: HUMAN })
    expect((await listIssueRunOptions(target.id, registry))[0].verdict).toEqual({ ok: true })
  })
})

describe("triage", () => {
  it("refuses derived runs on an issue in triage and lets a named one through", async () => {
    const registry = new IssueRunRegistry()
    const adapter = fakeAdapter()
    registry.register(adapter)
    const issue = await makeIssue({ triage: "pending" })
    for (const origin of ["im", "wakeup"] as const) {
      expect((await listIssueRunOptions(issue.id, registry, origin))[0].verdict).toEqual({
        ok: false,
        reason: "issue-in-triage",
      })
      await expect(
        startIssueRun({ issueId: issue.id, adapterId: "fake", by: HUMAN, origin }, registry)
      ).rejects.toMatchObject({ reason: "issue-in-triage" })
    }
    expect(adapter.starts).toHaveLength(0)
    expect((await listIssueRunOptions(issue.id, registry))[0].verdict).toEqual({ ok: true })
    await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    expect(adapter.starts).toHaveLength(1)
  })

  it("names only an interactive origin", () => {
    expect(isNamedRunOrigin("interactive")).toBe(true)
    expect(isNamedRunOrigin("im")).toBe(false)
    expect(isNamedRunOrigin("wakeup")).toBe(false)
  })
})

describe("startIssueRun", () => {
  it("dispatches through the adapter and takes in_progress for the runtime", async () => {
    const registry = new IssueRunRegistry()
    const contexts: unknown[] = []
    const adapter = fakeAdapter({
      start: async (target, ctx) => {
        adapter.starts.push(target)
        contexts.push(ctx)
        return { targetId: "engine-1", targetRef: { taskId: "tk" }, status: "queued" }
      },
    })
    registry.register(adapter)
    const issue = await makeIssue()
    const run = await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive", options: { a: 1 } },
      registry
    )
    expect(adapter.starts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ runId: run.id, options: { a: 1 } })
    expect(run).toMatchObject({
      status: "queued",
      targetId: "engine-1",
      targetRef: { taskId: "tk" },
      statusBefore: "todo",
    })
    expect(await getIssueRun(run.id)).toEqual(run)
    expect((await getIssue(issue.id))!.status).toBe("in_progress")
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)
    expect(kinds).toEqual(["created", "run_started", "status_changed"])
  })

  it("lets exactly one of two concurrent dispatches through and refuses the other run-active", async () => {
    const registry = new IssueRunRegistry()
    const adapter = fakeAdapter()
    registry.register(adapter)
    const issue = await makeIssue()
    const start = () =>
      startIssueRun(
        { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
        registry
      )
    const outcomes = await Promise.allSettled([start(), start()])
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1)
    const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult
    expect(refused.reason).toBeInstanceOf(IssueRunRefusedError)
    expect(refused.reason).toMatchObject({ reason: "run-active" })
    expect(adapter.starts).toHaveLength(1)
    expect(await listIssueRuns({ issueId: issue.id })).toHaveLength(1)
  })

  it("holds the issue from the claim: a person cannot drag it into in_progress mid-dispatch", async () => {
    const registry = new IssueRunRegistry()
    const { moveIssue } = await import("@/lib/db/issues")
    let denial: unknown
    registry.register(
      fakeAdapter({
        start: async (target) => {
          denial = await moveIssue({ id: target.issue.id, to: "in_progress", by: HUMAN })
          return { targetId: "t-1", status: "running" }
        },
      })
    )
    const issue = await makeIssue()
    await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    expect(denial).toBe("runtime-owned")
  })

  it("records statusBefore as the column the issue was in when the engine accepted", async () => {
    const registry = new IssueRunRegistry()
    const { moveIssue } = await import("@/lib/db/issues")
    registry.register(
      fakeAdapter({
        start: async (target) => {
          // Any column but the runtime's own is still the person's to change.
          expect(await moveIssue({ id: target.issue.id, to: "backlog", by: HUMAN })).toBeNull()
          return { targetId: "t-1", status: "running" }
        },
      })
    )
    const issue = await makeIssue()
    const run = await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    expect(run.statusBefore).toBe("backlog")
    expect(runStatusBefore(run)).toBe("backlog")
  })

  it("returns the cancelled row and cancels the engine item when a cancel lands mid-dispatch", async () => {
    const registry = new IssueRunRegistry()
    const adapter: ReturnType<typeof fakeAdapter> = fakeAdapter({
      start: async (_target, ctx) => {
        await cancelIssueRun(ctx.runId, registry)
        return { targetId: "engine-9", targetRef: { taskId: "tk" }, status: "running" }
      },
    })
    registry.register(adapter)
    const issue = await makeIssue()
    const run = await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    expect(run.status).toBe("cancelled")
    // The cancel saw an unbound claim and asked no engine; the dispatch path
    // cancelled the item the engine handed back.
    expect(adapter.cancels).toHaveLength(1)
    expect(adapter.cancels[0]).toMatchObject({ targetId: "engine-9", targetRef: { taskId: "tk" } })
    expect((await getIssue(issue.id))!.status).toBe("todo")
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)
    expect(kinds).toEqual(["created", "run_started", "run_cancelled"])
  })

  it("refuses with a machine-readable reason and never touches the issue", async () => {
    const registry = new IssueRunRegistry()
    const issue = await makeIssue()
    await expect(
      startIssueRun({ issueId: issue.id, adapterId: "nope", by: HUMAN, origin: "im" }, registry)
    ).rejects.toMatchObject({ name: "IssueRunRefusedError", reason: "adapter-missing" })

    registry.register(
      fakeAdapter({ canRun: async () => ({ ok: false, reason: "team-busy", detail: "executing" }) })
    )
    let caught: unknown
    try {
      await startIssueRun(
        { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "im" },
        registry
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(IssueRunRefusedError)
    expect((caught as IssueRunRefusedError).reason).toBe("team-busy")
    expect((caught as IssueRunRefusedError).detail).toBe("executing")
    expect((caught as Error).message).toBe("team-busy: executing")
    expect((await getIssue(issue.id))!.status).toBe("todo")
    expect(await listIssueRuns({ issueId: issue.id })).toEqual([])

    const done = await makeIssue({ status: "done" })
    await expect(
      startIssueRun({ issueId: done.id, adapterId: "fake", by: HUMAN, origin: "im" }, registry)
    ).rejects.toMatchObject({ reason: "issue-finished" })
    await expect(
      startIssueRun({ issueId: "missing", adapterId: "fake", by: HUMAN, origin: "im" }, registry)
    ).rejects.toThrow(/Issue not found/)
  })

  it("rethrows engine failures untouched, settles the claim failed and leaves the issue alone", async () => {
    const registry = new IssueRunRegistry()
    registry.register(
      fakeAdapter({
        start: async () => {
          throw new Error("scheduler exploded")
        },
      })
    )
    const issue = await makeIssue()
    await expect(
      startIssueRun(
        { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
        registry
      )
    ).rejects.toThrow("scheduler exploded")
    expect((await getIssue(issue.id))!.status).toBe("todo")
    const [run] = await listIssueRuns({ issueId: issue.id })
    expect(run).toMatchObject({ status: "failed", error: "scheduler exploded", targetId: "" })
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)
    expect(kinds).toEqual(["created", "run_started", "run_failed"])
    // The failed claim released the issue: the next Run is not refused run-active.
    registry.register(fakeAdapter())
    await expect(
      startIssueRun(
        { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
        registry
      )
    ).resolves.toMatchObject({ status: "running" })
  })
})

describe("settleIssueRunAndIssue / reconcileIssueRuns / cancelIssueRun", () => {
  async function running(registry: IssueRunRegistry, adapterId = "fake") {
    const issue = await makeIssue()
    const run = await startIssueRun(
      { issueId: issue.id, adapterId, by: HUMAN, origin: "interactive" },
      registry
    )
    return { issue, run }
  }

  it("success and failure both advance to in_review; cancel hands back to statusBefore", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    const a = await running(registry)
    expect((await settleIssueRunAndIssue(a.run.id, { status: "succeeded" }))?.status).toBe(
      "succeeded"
    )
    expect((await getIssue(a.issue.id))!.status).toBe("in_review")
    expect(
      await settleIssueRunAndIssue(a.run.id, { status: "failed", error: "late" })
    ).toBeUndefined()

    const b = await running(registry)
    await settleIssueRunAndIssue(b.run.id, { status: "failed", error: "boom" })
    expect((await getIssue(b.issue.id))!.status).toBe("in_review")

    const c = await running(registry)
    await settleIssueRunAndIssue(c.run.id, { status: "cancelled" })
    expect((await getIssue(c.issue.id))!.status).toBe("todo")

    const fromBacklog = await makeIssue({ status: "backlog" })
    const d = await startIssueRun(
      { issueId: fromBacklog.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    await settleIssueRunAndIssue(d.id, { status: "cancelled" })
    expect((await getIssue(fromBacklog.id))!.status).toBe("backlog")

    const fromReview = await makeIssue({ status: "in_review" })
    const e = await startIssueRun(
      { issueId: fromReview.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    await settleIssueRunAndIssue(e.id, { status: "cancelled" })
    expect((await getIssue(fromReview.id))!.status).toBe("in_review")
  })

  it("a cancel never pulls back an issue that left in_progress", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    const { issue, run } = await running(registry)
    const { getDb } = await import("@/lib/db/schema")
    await getDb().issues.update(issue.id, { status: "done", statusCategory: "completed" })
    await settleIssueRunAndIssue(run.id, { status: "cancelled" })
    expect((await getIssue(issue.id))!.status).toBe("done")
  })

  it("links the pull requests a settled run opened onto its issue", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    const { issue, run } = await running(registry)
    await settleIssueRunAndIssue(run.id, {
      status: "succeeded",
      artifacts: [
        { label: "Pull request #9", href: "https://github.com/acme/app/pull/9" },
        { label: "Branch", href: "/workspace?tab=environments" },
      ],
    })
    expect((await getIssue(issue.id))!.externalRefs).toEqual([
      {
        provider: "github-pr",
        externalId: "acme/app#9",
        url: "https://github.com/acme/app/pull/9",
        label: "Pull request #9",
      },
    ])
  })

  it("runtimeActorFor names the engine on status changes", () => {
    const base = {
      id: "r",
      issueId: "i",
      projectId: "w",
      targetId: "t",
      status: "running",
    } as IssueRun
    expect(runtimeActorFor({ ...base, kind: "agent-team", adapterId: "agent-team" })).toEqual({
      kind: "team",
      id: "t",
      label: "agent-team",
    })
    expect(runtimeActorFor({ ...base, kind: "github-loop", adapterId: "github-loop" })).toEqual({
      kind: "agent",
      id: "t",
      label: "github-loop",
    })
  })

  it("reconcile polls active runs, settles terminal ones, isolates adapter errors", async () => {
    const registry = new IssueRunRegistry()
    const stillRunning = fakeAdapter({ id: "slow" })
    const finished = fakeAdapter({ id: "done", pollResult: { status: "succeeded", summary: "ok" } })
    const broken = fakeAdapter({
      id: "broken",
      poll: async () => {
        throw new Error("poll boom")
      },
    })
    registry.register(stillRunning)
    registry.register(finished)
    registry.register(broken)
    const a = await running(registry, "slow")
    const b = await running(registry, "done")
    const c = await running(registry, "broken")

    const result = await reconcileIssueRuns(registry)
    expect(result.polled).toBe(3)
    expect(result.settled).toEqual([b.run.id])
    expect(result.errored.map((e) => e.runId)).toEqual([c.run.id])
    expect((await getIssueRun(a.run.id))!.status).toBe("running")
    expect((await getIssueRun(b.run.id))!.status).toBe("succeeded")
    expect((await getIssue(b.issue.id))!.status).toBe("in_review")
    expect((await getIssueRun(c.run.id))!.status).toBe("running")
  })

  it("reconcile skips a claim in flight and fails one left unbound past the stale window", async () => {
    const registry = new IssueRunRegistry()
    const adapter = fakeAdapter({ pollResult: { status: "failed", error: "never asked" } })
    registry.register(adapter)
    const issue = await makeIssue()
    const claim = await claimIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      by: HUMAN,
      now: 1_000,
    })
    const fresh = await reconcileIssueRuns(registry, 1_000 + ISSUE_RUN_DISPATCH_STALE_MS)
    expect(fresh).toMatchObject({ polled: 0, settled: [] })
    expect((await getIssueRun(claim.id))!.status).toBe("queued")

    const stale = await reconcileIssueRuns(registry, 1_001 + ISSUE_RUN_DISPATCH_STALE_MS)
    expect(stale).toMatchObject({ polled: 0, settled: [claim.id] })
    expect(await getIssueRun(claim.id)).toMatchObject({
      status: "failed",
      error: "dispatch interrupted before the engine accepted it",
    })
    expect((await getIssue(issue.id))!.status).toBe("todo")
  })

  it("reconcile marks a queued run running when its engine picked it up", async () => {
    const registry = new IssueRunRegistry()
    registry.register(
      fakeAdapter({
        start: async () => ({ targetId: "t-1", status: "queued" }),
        pollResult: { status: "running" },
      })
    )
    const { run } = await running(registry)
    expect(run.status).toBe("queued")
    const result = await reconcileIssueRuns(registry)
    expect(result).toMatchObject({ polled: 1, settled: [] })
    expect((await getIssueRun(run.id))!.status).toBe("running")
  })

  it("reconcile fails a run whose adapter vanished", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    const { run, issue } = await running(registry)
    registry.unregister("fake")
    const result = await reconcileIssueRuns(registry)
    expect(result.settled).toEqual([run.id])
    const settled = (await getIssueRun(run.id))!
    expect(settled.status).toBe("failed")
    expect(settled.error).toMatch(/not registered/)
    expect((await getIssue(issue.id))!.status).toBe("in_review")
  })

  it("cancelIssueRun asks the adapter to cancel, then settles cancelled", async () => {
    const registry = new IssueRunRegistry()
    const adapter = fakeAdapter()
    registry.register(adapter)
    const { run, issue } = await running(registry)
    const settled = await cancelIssueRun(run.id, registry)
    expect(settled?.status).toBe("cancelled")
    expect(adapter.cancels.map((r) => r.id)).toEqual([run.id])
    expect((await getIssue(issue.id))!.status).toBe("todo")
    expect(await cancelIssueRun(run.id, registry)).toBeUndefined()
    expect(await cancelIssueRun("missing", registry)).toBeUndefined()
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((e) => e.kind)
    expect(kinds).toContain("run_cancelled")
    expect(kinds).not.toContain("run_failed")
  })

  it("cancelIssueRun leaves an engine-side cancel to a claim the engine has not accepted", async () => {
    const registry = new IssueRunRegistry()
    const adapter = fakeAdapter()
    registry.register(adapter)
    const issue = await makeIssue()
    const claim = await claimIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      by: HUMAN,
    })
    expect((await cancelIssueRun(claim.id, registry))?.status).toBe("cancelled")
    expect(adapter.cancels).toEqual([])
  })

  it("cancelIssueRun keeps the run active when the engine refuses to cancel", async () => {
    const registry = new IssueRunRegistry()
    registry.register(
      fakeAdapter({
        cancel: async () => {
          throw new Error("engine unreachable")
        },
      })
    )
    const { run, issue } = await running(registry)
    await expect(cancelIssueRun(run.id, registry)).rejects.toThrow("engine unreachable")
    expect((await getIssueRun(run.id))!.status).toBe("running")
    expect((await getIssue(issue.id))!.status).toBe("in_progress")
  })

  it("cancelIssueRun tolerates adapters without cancel", async () => {
    const registry = new IssueRunRegistry()
    const adapter = fakeAdapter()
    delete (adapter as Partial<IssueRunAdapter>).cancel
    registry.register(adapter)
    const { run } = await running(registry)
    expect((await cancelIssueRun(run.id, registry))?.status).toBe("cancelled")
  })
})

describe("wakeup support", () => {
  it("passes the brief and the lineage through to the adapter", async () => {
    const registry = new IssueRunRegistry()
    const contexts: unknown[] = []
    registry.register(
      fakeAdapter({
        start: async (_target, ctx) => {
          contexts.push(ctx)
          return { targetId: "t-1", status: "running" }
        },
      })
    )
    const issue = await makeIssue()
    const wakeup = { taskId: "wk", chain: ["wk"], statusBefore: "todo" as const, periodic: true }
    await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "wakeup", brief: "B", wakeup },
      registry
    )
    expect(contexts[0]).toMatchObject({ origin: "wakeup", brief: "B", wakeup })
    // The claim, not the adapter, stores the lineage now.
    const [row] = await listIssueRuns({ issueId: issue.id })
    expect(row.wakeup).toEqual(wakeup)
    expect(contexts[0]).toMatchObject({ runId: row.id })
  })

  it("names sessions only for an active run whose adapter can", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter({ sessionIds: async () => ["s2", "s1"] }))
    const issue = await makeIssue()
    const run = await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    expect(await issueRunSessionIds(run, registry)).toEqual(["s2", "s1"])
    expect(await issueRunSessionIds({ ...run, status: "succeeded" }, registry)).toEqual([])
    expect(await issueRunSessionIds({ ...run, adapterId: "gone" }, registry)).toEqual([])
  })

  it("steers the newest session, and reports false instead of throwing", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter({ sessionIds: async () => ["s2", "s1"] }))
    const issue = await makeIssue()
    const run = await startIssueRun(
      { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )
    const steer = jest.fn(async () => ({ accepted: true }))
    expect(await steerIssueRun(run, "hi", { registry, steer })).toBe(true)
    expect(steer).toHaveBeenCalledWith("s2", "hi")
    const refuse = jest.fn(async () => {
      throw new Error("PII")
    })
    expect(await steerIssueRun(run, "hi", { registry, steer: refuse })).toBe(false)

    const bare = new IssueRunRegistry()
    bare.register(fakeAdapter())
    expect(await steerIssueRun(run, "hi", { registry: bare, steer })).toBe(false)
  })

  it("checks in a periodic wakeup run: settles with the note and hands the issue back", async () => {
    const issue = await makeIssue({ status: "backlog" })
    const run = await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
      wakeup: { taskId: "wk", chain: ["wk"], statusBefore: "backlog", periodic: true },
    })
    const { applyRuntimeIssueStatus } = await import("@/lib/db/issues")
    await applyRuntimeIssueStatus(issue.id, "in_progress", HUMAN)

    const result = await checkInIssueRun(run.id, "nothing to do")
    expect(result).toMatchObject({
      status: "checked-in",
      run: { status: "succeeded", summary: "nothing to do" },
    })
    expect((await getIssue(issue.id))!.status).toBe("backlog")
    const kinds = (await listIssueEvents({ issueId: issue.id })).map((event) => event.kind)
    expect(kinds).toContain("run_checked_in")
    expect(kinds).not.toContain("run_succeeded")
    expect(await checkInIssueRun(run.id, "again")).toEqual({
      status: "refused",
      reason: "not-active",
    })
  })

  it("hands back to the run's own statusBefore, preferring it over the wakeup's", async () => {
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    const issue = await makeIssue({ status: "in_review" })
    const run = await startIssueRun(
      {
        issueId: issue.id,
        adapterId: "fake",
        by: HUMAN,
        origin: "wakeup",
        wakeup: { taskId: "wk", chain: ["wk"], statusBefore: "todo", periodic: true },
      },
      registry
    )
    expect(run.statusBefore).toBe("in_review")
    await checkInIssueRun(run.id, "quiet")
    expect((await getIssue(issue.id))!.status).toBe("in_review")
  })

  it("refuses to check in a run no periodic wakeup started", async () => {
    const issue = await makeIssue()
    const plain = await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
    })
    expect(await checkInIssueRun(plain.id, "x")).toEqual({
      status: "refused",
      reason: "not-periodic-wakeup",
    })
    expect(await checkInIssueRun("missing", "x")).toEqual({
      status: "refused",
      reason: "not-found",
    })
  })

  it("leaves an issue a person moved meanwhile where they put it", async () => {
    const issue = await makeIssue()
    const run = await claimIssueRun({
      status: "running",
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: HUMAN,
      wakeup: { taskId: "wk", chain: ["wk"], statusBefore: "todo", periodic: true },
    })
    const { getDb } = await import("@/lib/db/schema")
    await getDb().issues.update(issue.id, { status: "in_review", statusCategory: "started" })
    await checkInIssueRun(run.id, "ok")
    expect((await getIssue(issue.id))!.status).toBe("in_review")
  })
})

describe("repairStrandedIssues", () => {
  async function strand(
    issueStatus: "todo" | "backlog",
    settle: Parameters<typeof settleIssueRun>[1]
  ) {
    const { applyRuntimeIssueStatus } = await import("@/lib/db/issues")
    const issue = await makeIssue({ status: issueStatus })
    const run = await claimIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      status: "running",
      by: HUMAN,
      now: Date.now() - 1_000,
    })
    const { bindIssueRunDispatch } = await import("@/lib/db/issue-runs")
    await bindIssueRunDispatch(run.id, { targetId: "t", status: "running" }, issueStatus)
    await applyRuntimeIssueStatus(issue.id, "in_progress", HUMAN)
    // The pre-atomic settle: the row settles, the window closes before the issue moves.
    await settleIssueRun(run.id, settle)
    return issue
  }

  it("finishes what an interrupted settle left: review for an outcome, hand-back for a cancel", async () => {
    const succeeded = await strand("todo", { status: "succeeded" })
    const failed = await strand("todo", { status: "failed", error: "boom" })
    const cancelled = await strand("backlog", { status: "cancelled" })
    const checkedIn = await strand("backlog", { status: "succeeded", mode: "checkin", note: "q" })
    const result = await repairStrandedIssues()
    expect(new Set(result.repaired)).toEqual(
      new Set([succeeded.id, failed.id, cancelled.id, checkedIn.id])
    )
    expect((await getIssue(succeeded.id))!.status).toBe("in_review")
    expect((await getIssue(failed.id))!.status).toBe("in_review")
    expect((await getIssue(cancelled.id))!.status).toBe("backlog")
    expect((await getIssue(checkedIn.id))!.status).toBe("backlog")
    expect((await repairStrandedIssues()).repaired).toEqual([])
  })

  it("leaves alone an issue a person put in in_progress, an active run, and a claim that never bound", async () => {
    const { moveIssue } = await import("@/lib/db/issues")
    const byHand = await makeIssue()
    await moveIssue({ id: byHand.id, to: "in_progress", by: HUMAN })

    const afterRun = await strand("todo", { status: "succeeded" })
    const registry = new IssueRunRegistry()
    registry.register(fakeAdapter())
    // Settled properly, then a person moved it back into in_progress.
    const { getDb } = await import("@/lib/db/schema")
    await getDb().issues.update(afterRun.id, { status: "in_review", statusCategory: "started" })
    await new Promise((resolve) => setTimeout(resolve, 2))
    await moveIssue({ id: afterRun.id, to: "in_progress", by: HUMAN })

    const active = await makeIssue()
    await startIssueRun(
      { issueId: active.id, adapterId: "fake", by: HUMAN, origin: "interactive" },
      registry
    )

    const unbound = await makeIssue()
    await moveIssue({ id: unbound.id, to: "in_progress", by: HUMAN })
    const claim = await claimIssueRun({
      issueId: unbound.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      by: HUMAN,
    })
    await settleIssueRun(claim.id, { status: "failed", error: "refused" })

    expect((await repairStrandedIssues()).repaired).toEqual([])
    for (const issue of [byHand, afterRun, active, unbound]) {
      expect((await getIssue(issue.id))!.status).toBe("in_progress")
    }
  })
})

it("preserves Host credential proof for adapter availability and dispatch without inferring it from origin", async () => {
  const registry = new IssueRunRegistry()
  const adapter = fakeAdapter({
    canRun: async (target) =>
      target.credentialContext?.localAuthorization === LOCAL_PERSON_RUN
        ? { ok: true }
        : { ok: false, reason: "no-github-account" },
  })
  registry.register(adapter)
  const issue = await makeIssue()
  expect((await listIssueRunOptions(issue.id, registry))[0].verdict.ok).toBe(false)
  const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
  expect(
    (await listIssueRunOptions(issue.id, registry, "interactive", credentialContext))[0].verdict.ok
  ).toBe(true)
  await startIssueRun(
    { issueId: issue.id, adapterId: "fake", by: HUMAN, origin: "interactive", credentialContext },
    registry
  )
  expect(adapter.starts[0].credentialContext).toBe(credentialContext)
})
