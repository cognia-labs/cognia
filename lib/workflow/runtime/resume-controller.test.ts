import { registerRunRecoveryOwner, resumeInFlightRuns } from "./resume-controller"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { registerNodeExecutor } from "@/lib/workflow/nodes/registry"
import { createWorkflowVersion } from "@/lib/workflow/versioning/version-snapshot"
import { listRunEvents } from "./event-log"
import type { VisualWorkflow, WorkflowNode, WorkflowRunRow } from "@/types/workflow/visual"
import type { WorkflowInvocation } from "@/types/workflow/deployment"

// Mock the native bridge so tests don't depend on a Tauri window. Each test
// overrides `reloadInFlightRuns` with a fixture set of mirror rows, and says
// whether this Host executes runs (and so scans its own run table).
jest.mock("./tauri-bridge", () => ({
  reloadInFlightRuns: jest.fn(),
  hasNativeWorkflowPlane: jest.fn(() => false),
  persistRunState: jest.fn(),
  ackRunCompleted: jest.fn(),
  registerTrigger: jest.fn(),
  unregisterTrigger: jest.fn(),
  listenTriggerEvents: jest.fn(),
  listenResumeEvents: jest.fn(),
}))

import { ackRunCompleted, hasNativeWorkflowPlane, reloadInFlightRuns } from "./tauri-bridge"

const mockedReload = reloadInFlightRuns as jest.MockedFunction<typeof reloadInFlightRuns>
const mockedNativePlane = hasNativeWorkflowPlane as jest.MockedFunction<
  typeof hasNativeWorkflowPlane
>

jest.setTimeout(30_000)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  const db = getDb()
  await db.workflowRuns.clear()
  await db.workflowRunEvents.clear()
  await db.workflowInvocations.clear()
  await db.workflowVersions.clear()
  mockedReload.mockReset()
  mockedReload.mockResolvedValue([])
  mockedNativePlane.mockReset()
  mockedNativePlane.mockReturnValue(false)
  jest.mocked(ackRunCompleted).mockClear()
})
afterAll(dbFixture.dispose)

const settings: VisualWorkflow["settings"] = {
  errorPolicy: "stop",
  timeoutMs: 60_000,
  concurrency: 1,
  retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
}

function nodeOf(id: string, type: WorkflowNode["type"], params: Record<string, unknown> = {}) {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params },
  } as WorkflowNode
}

function workflowOf(
  id: string,
  nodes: WorkflowNode[],
  edges: VisualWorkflow["edges"] = []
): VisualWorkflow {
  return { id, schemaVersion: 2, name: id, createdAt: 0, updatedAt: 0, nodes, edges, settings }
}

/** A workflow with a manual root and a cron root that each reach their own node. */
const twoRoots = workflowOf(
  "wf_roots",
  [
    nodeOf("n_manual", "trigger.manual"),
    nodeOf("n_cron", "trigger.cron", { cron: "0 9 * * *" }),
    nodeOf("after_manual", "flow.set", { variable: "m", value: "manual path" }),
    nodeOf("after_cron", "flow.set", { variable: "c", value: "cron path" }),
  ],
  [
    { id: "e1", source: "n_manual", target: "after_manual" },
    { id: "e2", source: "n_cron", target: "after_cron" },
  ]
)

/** The row an interrupted run leaves behind. */
function interruptedRow(over: Partial<WorkflowRunRow> & { id: string }): WorkflowRunRow {
  return {
    workflowId: twoRoots.id,
    status: "running",
    triggerKind: "trigger.cron",
    triggerId: "n_cron",
    triggerPayload: { scheduledFor: 1_700_000_000_000 },
    triggerOriginAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_500,
    workflowSnapshot: twoRoots,
    triggeredBySource: "trigger",
    triggeredBy: { source: "trigger" },
    ...over,
  }
}

const completedSteps = async (runId: string) =>
  (await listRunEvents(runId))
    .filter((event) => event.type === "step_completed")
    .map((event) => event.stepId)

describe("resumeInFlightRuns", () => {
  it("returns an all-zero summary when there is nothing to continue", async () => {
    const { settled, ...summary } = await resumeInFlightRuns()
    expect(summary).toEqual({ attempted: 0, started: 0, deferred: 0, skipped: 0, delegated: 0 })
    await expect(settled).resolves.toEqual({ succeeded: 0, failed: 0, waiting: 0, elsewhere: 0 })
  })

  it("skips mirror rows that have no durable run row", async () => {
    mockedReload.mockResolvedValueOnce([
      { runId: "run_a", workflowId: "wf_x", startedAt: 0, snapshot: twoRoots },
      {
        runId: "run_b",
        workflowId: "wf_x",
        startedAt: 0,
        snapshot: { name: "missing id" } as unknown as VisualWorkflow,
      },
    ])
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const r = await resumeInFlightRuns()
    warn.mockRestore()
    expect(r).toMatchObject({ attempted: 2, skipped: 2, started: 0 })
    expect(await getDb().workflowRuns.count()).toBe(0)
  })

  it("acks a mirror row whose run already finished instead of replaying it", async () => {
    await getDb().workflowRuns.put(interruptedRow({ id: "run_done", status: "succeeded" }))
    mockedReload.mockResolvedValueOnce([
      { runId: "run_done", workflowId: twoRoots.id, startedAt: 0, snapshot: twoRoots },
    ])
    const r = await resumeInFlightRuns()
    expect(r).toMatchObject({ skipped: 1, started: 0 })
    expect(ackRunCompleted).toHaveBeenCalledWith("run_done")
  })

  it("continues a scheduled run on its own trigger, not as a manual run", async () => {
    await getDb().workflowRuns.put(interruptedRow({ id: "run_cron" }))
    mockedReload.mockResolvedValueOnce([
      { runId: "run_cron", workflowId: twoRoots.id, startedAt: 0, snapshot: twoRoots },
    ])

    const r = await resumeInFlightRuns()
    expect(r.started).toBe(1)
    await expect(r.settled).resolves.toMatchObject({ succeeded: 1 })

    const row = await getDb().workflowRuns.get("run_cron")
    expect(row).toMatchObject({
      status: "succeeded",
      triggerKind: "trigger.cron",
      triggerId: "n_cron",
      triggerPayload: { scheduledFor: 1_700_000_000_000 },
      triggerOriginAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_500,
      triggeredBy: { source: "trigger" },
    })
    const completed = await completedSteps("run_cron")
    expect(completed).toContain("after_cron")
    expect(completed).not.toContain("after_manual")
  })

  it("continues a formal run through its invocation, keeping its binding and settling it", async () => {
    const version = createWorkflowVersion({
      workflow: twoRoots,
      workflowInterface: { inputSchema: {}, outputSchema: {} } as never,
      accountId: "acct",
      sequence: 1,
      createdAt: 1,
    })
    const invocation: WorkflowInvocation = {
      id: "wfi_resume",
      accountId: "acct",
      entrypoint: "trigger",
      caller: "trigger.cron",
      deploymentId: "wfd_roots",
      deploymentRevision: 3,
      versionId: version.id,
      idempotencyKey: "cron:slot",
      runId: "run_formal",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    }
    const executionBinding = {
      invocationId: invocation.id,
      versionId: version.id,
      deploymentId: invocation.deploymentId,
      deploymentRevision: invocation.deploymentRevision,
      entrypoint: invocation.entrypoint,
      caller: invocation.caller,
      idempotencyKey: invocation.idempotencyKey,
    }
    const db = getDb()
    await db.workflowVersions.put(version)
    await db.workflowInvocations.put(invocation)
    await db.workflowRuns.put(
      interruptedRow({
        id: "run_formal",
        workflowSnapshot: version.definition,
        versionId: version.id,
        deploymentId: invocation.deploymentId,
        deploymentRevision: invocation.deploymentRevision,
        executionBinding,
      })
    )
    mockedReload.mockResolvedValueOnce([
      { runId: "run_formal", workflowId: twoRoots.id, startedAt: 0, snapshot: twoRoots },
    ])

    const r = await resumeInFlightRuns()
    await expect(r.settled).resolves.toMatchObject({ succeeded: 1 })

    expect(await db.workflowInvocations.get(invocation.id)).toMatchObject({ status: "completed" })
    expect(await db.workflowRuns.get("run_formal")).toMatchObject({
      status: "succeeded",
      triggerKind: "trigger.cron",
      versionId: version.id,
      deploymentRevision: 3,
      executionBinding: expect.objectContaining({ invocationId: invocation.id }),
    })
    expect(await completedSteps("run_formal")).not.toContain("after_manual")
  })

  it("finds an admitted run the mirror never heard of, keeping its original trigger time", async () => {
    mockedNativePlane.mockReturnValue(true)
    const version = createWorkflowVersion({
      workflow: twoRoots,
      workflowInterface: { inputSchema: {}, outputSchema: {} } as never,
      accountId: "acct",
      sequence: 1,
      createdAt: 1,
    })
    const invocation: WorkflowInvocation = {
      id: "wfi_pending",
      accountId: "acct",
      entrypoint: "http",
      caller: "api",
      deploymentId: "wfd_roots",
      deploymentRevision: 1,
      versionId: version.id,
      runId: "run_pending",
      status: "admitted",
      createdAt: 1,
      updatedAt: 1,
    }
    const db = getDb()
    await db.workflowVersions.put(version)
    await db.workflowInvocations.put(invocation)
    // Admission wrote the ledger and the pending run, handed out the run id,
    // and died before the first mirror write: only Dexie knows the run.
    await db.workflowRuns.put(
      interruptedRow({
        id: "run_pending",
        status: "pending",
        workflowSnapshot: version.definition,
        executionBinding: {
          invocationId: invocation.id,
          versionId: version.id,
          deploymentId: invocation.deploymentId,
          deploymentRevision: invocation.deploymentRevision,
          entrypoint: invocation.entrypoint,
          caller: invocation.caller,
        },
      })
    )

    const r = await resumeInFlightRuns()
    expect(r).toMatchObject({ attempted: 1, started: 1 })
    await expect(r.settled).resolves.toMatchObject({ succeeded: 1 })
    expect(await db.workflowRuns.get("run_pending")).toMatchObject({
      status: "succeeded",
      triggerOriginAt: 1_700_000_000_000,
    })
    expect(await db.workflowInvocations.get(invocation.id)).toMatchObject({ status: "completed" })
  })

  it("does not scan the run table on a host that only mirrors another Host's runs", async () => {
    await getDb().workflowRuns.put(interruptedRow({ id: "run_synced" }))
    const r = await resumeInFlightRuns()
    expect(r.attempted).toBe(0)
    expect((await getDb().workflowRuns.get("run_synced"))?.status).toBe("running")
  })

  it("re-checks a run whose stale lease was still live at boot once that lease expires", async () => {
    mockedNativePlane.mockReturnValue(true)
    await getDb().workflowRuns.put(
      interruptedRow({
        id: "run_leased",
        // The previous process died seconds ago; its lease outlives it.
        lease: { ownerId: "exec_dead", claimedAt: Date.now(), expiresAt: Date.now() + 150 },
      })
    )
    const r = await resumeInFlightRuns()
    expect(r).toMatchObject({ deferred: 1, started: 0 })
    expect((await getDb().workflowRuns.get("run_leased"))?.status).toBe("running")

    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await getDb().workflowRuns.get("run_leased"))?.status === "succeeded") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect((await getDb().workflowRuns.get("run_leased"))?.status).toBe("succeeded")
  })

  it("stops following a deferred lease when the runtime shuts down", async () => {
    mockedNativePlane.mockReturnValue(true)
    await getDb().workflowRuns.put(
      interruptedRow({
        id: "run_shutdown",
        lease: { ownerId: "exec_dead", claimedAt: Date.now(), expiresAt: Date.now() + 100 },
      })
    )
    const stop = new AbortController()
    const r = await resumeInFlightRuns({ signal: stop.signal })
    expect(r.deferred).toBe(1)
    stop.abort()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await getDb().workflowRuns.get("run_shutdown"))?.status).toBe("running")
  })

  it("starts every replay without waiting for a slow one to finish", async () => {
    mockedNativePlane.mockReturnValue(true)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    registerNodeExecutor({
      kind: "action.test.resume-blocks" as never,
      typeVersion: 1,
      execute: async () => {
        await blocked
        return { output: "late" }
      },
    })
    const slow = workflowOf(
      "wf_slow",
      [
        nodeOf("n_cron", "trigger.cron", { cron: "0 9 * * *" }),
        nodeOf("hold", "action.test.resume-blocks" as never),
      ],
      [{ id: "e1", source: "n_cron", target: "hold" }]
    )
    await getDb().workflowRuns.put(
      interruptedRow({ id: "run_slow", workflowId: slow.id, workflowSnapshot: slow, startedAt: 1 })
    )
    await getDb().workflowRuns.put(interruptedRow({ id: "run_fast", startedAt: 2 }))

    const r = await resumeInFlightRuns()
    expect(r.started).toBe(2)
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await getDb().workflowRuns.get("run_fast"))?.status === "succeeded") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // The independent run finished while the first is still blocked.
    expect((await getDb().workflowRuns.get("run_fast"))?.status).toBe("succeeded")
    expect((await getDb().workflowRuns.get("run_slow"))?.status).toBe("running")
    release()
    await expect(r.settled).resolves.toMatchObject({ succeeded: 2 })
  })

  it("counts a failing replay as failed without throwing", async () => {
    const bad = workflowOf(
      "wf_bad",
      [
        nodeOf("n_cron", "trigger.cron", { cron: "0 9 * * *" }),
        // Unregistered kind: the orchestrator returns status failed.
        nodeOf("n_team", "action.team.run"),
      ],
      [{ id: "e1", source: "n_cron", target: "n_team" }]
    )
    await getDb().workflowRuns.put(
      interruptedRow({ id: "run_failing", workflowId: bad.id, workflowSnapshot: bad })
    )
    mockedReload.mockResolvedValueOnce([
      { runId: "run_failing", workflowId: bad.id, startedAt: 1, snapshot: bad },
    ])
    const r = await resumeInFlightRuns()
    expect(r.started).toBe(1)
    await expect(r.settled).resolves.toMatchObject({ failed: 1, succeeded: 0 })
  })

  it("leaves runs a recovery owner claims to that owner instead of replaying them", async () => {
    const unregister = registerRunRecoveryOwner({
      id: "test-owner",
      owns: (row) => row.workflowId.startsWith("__owned__:"),
    })
    try {
      mockedReload.mockResolvedValueOnce([
        {
          runId: "run_owned",
          workflowId: "__owned__:x",
          startedAt: 0,
          snapshot: { id: "__owned__:x" } as unknown as VisualWorkflow,
        },
      ])
      const { settled, ...r } = await resumeInFlightRuns()
      expect(r).toEqual({ attempted: 1, started: 0, deferred: 0, skipped: 0, delegated: 1 })
      await settled
      expect(await getDb().workflowRuns.get("run_owned")).toBeUndefined()
    } finally {
      unregister()
    }
  })

  it("hands a run whose owner resumes it back to that owner, after the usual checks", async () => {
    const resume = jest.fn(async (row: WorkflowRunRow) => {
      expect(row.triggerOriginAt).toBe(1_700_000_000_000)
      return "succeeded" as const
    })
    const unregister = registerRunRecoveryOwner({
      id: "test-resuming-owner",
      owns: (row) => row.workflowId.startsWith("__owned__:"),
      resume,
    })
    try {
      mockedNativePlane.mockReturnValue(true)
      const owned = { ...twoRoots, id: "__owned__:x" }
      await getDb().workflowRuns.bulkPut([
        interruptedRow({ id: "run_owned", workflowId: owned.id, workflowSnapshot: owned }),
        // Leased by a live executor: deferred like any other run, never resumed now.
        interruptedRow({
          id: "run_owned_leased",
          workflowId: owned.id,
          workflowSnapshot: owned,
          lease: {
            ownerId: "other-executor",
            claimedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        }),
        // Finished: acked, never resumed.
        interruptedRow({
          id: "run_owned_done",
          workflowId: owned.id,
          workflowSnapshot: owned,
          status: "succeeded",
        }),
      ])
      mockedReload.mockResolvedValueOnce([
        { runId: "run_owned_done", workflowId: owned.id, startedAt: 0, snapshot: owned },
      ])
      const controller = new AbortController()
      const { settled, ...r } = await resumeInFlightRuns({ signal: controller.signal })
      controller.abort()
      expect(r).toEqual({ attempted: 3, started: 1, deferred: 1, skipped: 1, delegated: 0 })
      await expect(settled).resolves.toMatchObject({ succeeded: 1, failed: 0 })
      expect(resume).toHaveBeenCalledTimes(1)
      expect(resume.mock.calls[0]![0].id).toBe("run_owned")
      expect(ackRunCompleted).toHaveBeenCalledWith("run_owned_done")
      // The owner drove it; the generic replay never ran its steps.
      expect(await completedSteps("run_owned")).toEqual([])
    } finally {
      unregister()
    }
  })
})
