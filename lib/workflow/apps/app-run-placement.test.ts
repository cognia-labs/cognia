jest.mock("./alert-service", () => ({ emitWorkflowAppQuotaAlert: jest.fn(async () => undefined) }))

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { WorkflowAdmissionError } from "@/lib/workflow/runtime/execution-authority"
import type { ResolvedWorkflowAppRelease } from "@/types/workflow/app"
import type { WorkflowInvocation, WorkflowVersion } from "@/types/workflow/deployment"
import { PlacementWaitingError, type PlacementConstraint } from "@/lib/placement/types"
import { DEFAULT_WORKFLOW_SETTINGS } from "@/types/workflow/visual"
import { emitWorkflowAppQuotaAlert } from "./alert-service"
import {
  admitWorkflowAppRunPlacement,
  cancelPlacedWorkflowAppRun,
  judgePlacedWorkflowAppRunDisclosure,
  listPlacedWorkflowAppRunEvents,
  readPlacedWorkflowAppRun,
  recordWorkflowAppRunPlacementAccepted,
  refreshPlacedWorkflowAppRuns,
  WorkflowAppRunHostUnavailableError,
  type WorkflowAppRunPlacementDeps,
} from "./app-run-placement"
import { WorkflowAppQuotaError } from "./quota-service"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

const actor = { authenticated: false, externalSubjectKey: "visitor" }

function release(quota: Record<string, number> = {}): ResolvedWorkflowAppRelease {
  const accountId = getActiveAccountId()
  return {
    app: { id: "wfa_1", accountId, workflowId: "wf_1", slug: "review" },
    release: {
      id: "wfar_1",
      appId: "wfa_1",
      accountId,
      workflowId: "wf_1",
      versionId: "wfv_1",
      versionDigest: "wfv1:abc",
      deploymentId: "wfd_1",
      deploymentRevision: 4,
      dependencyLock: { workflows: {}, indexes: {} },
      snapshot: {
        access: { mode: "anonymous", oidcGroupIds: [] },
        embed: { enabled: false, allowedOrigins: [] },
        legal: { requireConsent: false },
        quota,
      },
    },
  } as unknown as ResolvedWorkflowAppRelease
}

async function seed(runOn: PlacementConstraint, inputSchema?: Record<string, unknown>) {
  const accountId = getActiveAccountId()
  await getDb().workflowVersions.put({
    id: "wfv_1",
    accountId,
    workflowId: "wf_1",
    sequence: 1,
    digest: "wfv1:abc",
    interface: inputSchema ? { inputSchema } : {},
    definition: {
      id: "wf_1",
      name: "Review",
      nodes: [],
      edges: [],
      settings: { ...DEFAULT_WORKFLOW_SETTINGS, runOn },
    },
    createdAt: 1,
  } as unknown as WorkflowVersion)
  await getDb().workflowDeployments.put({
    id: "wfd_1",
    accountId,
    workflowId: "wf_1",
    environment: "production",
    versionId: "wfv_1",
    revision: 4,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  })
}

interface FakeTarget {
  calls: Array<{ command: string; payload: Record<string, unknown> }>
  reply: (command: string, payload: Record<string, unknown>) => unknown
}

function deps(target?: FakeTarget, host = "host_b"): Partial<WorkflowAppRunPlacementDeps> {
  let seq = 0
  return {
    resolveHost: jest.fn(async () =>
      host === "local" ? { kind: "local" as const } : { kind: "remote" as const, ref: host }
    ),
    openTarget: jest.fn(async () => ({
      transport: {
        call: (async (command: string, payload: Record<string, unknown> = {}) => {
          if (!target) throw new Error("offline")
          target.calls.push({ command, payload })
          return target.reply(command, payload)
        }) as never,
      },
      close: () => undefined,
    })),
    now: () => 1_000,
    newRunId: () => `run_placed_${++seq}`,
    targetTimeoutMs: 1_000,
  }
}

async function admit(
  overrides: Partial<WorkflowAppRunPlacementDeps>,
  idempotencyKey = "request-1",
  resolved = release()
) {
  return admitWorkflowAppRunPlacement(
    { resolved, actor, input: { topic: "release" }, idempotencyKey, placeable: true },
    overrides
  )
}

async function onlyInvocation(): Promise<WorkflowInvocation> {
  const rows = await getDb().workflowInvocations.toArray()
  expect(rows).toHaveLength(1)
  return rows[0]
}

beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
})

describe("admitWorkflowAppRunPlacement (WF-13)", () => {
  it("reserves the invocation and its handoff job in one admission when the policy places the run elsewhere", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    const admitted = await admit(deps())

    expect(admitted).toMatchObject({ runId: "run_placed_1", reused: false })
    const invocation = await onlyInvocation()
    expect(invocation).toMatchObject({
      entrypoint: "http",
      caller: "app:wfa_1:release:wfar_1:external:visitor",
      versionId: "wfv_1",
      deploymentId: "wfd_1",
      deploymentRevision: 4,
      runId: "run_placed_1",
      status: "admitted",
      placement: { hostRef: "host_b", state: "dispatching", dispatchId: admitted!.dispatchId },
    })
    // No local run: the run belongs to the target.
    expect(await getDb().workflowRuns.count()).toBe(0)
    const job = await getDb().hostDispatchQueue.get(admitted!.dispatchId)
    expect(job).toMatchObject({
      domain: "schedule-handoff",
      kind: "workflow.app-run",
      targetRef: "host_b",
      idempotencyKey: invocation.id,
      runId: "run_placed_1",
      status: "pending",
      payload: {
        invocationId: invocation.id,
        runId: "run_placed_1",
        appCaller: "app:wfa_1:release:wfar_1:external:visitor",
        binding: {
          workflowId: "wf_1",
          versionId: "wfv_1",
          deploymentId: "wfd_1",
          deploymentRevision: 4,
          expectedVersionDigest: "wfv1:abc",
          dependencyLock: { workflows: {}, indexes: {} },
        },
        payload: { input: { topic: "release" }, appId: "wfa_1", appReleaseId: "wfar_1" },
        initiator: { authenticated: false, externalSubjectKey: "visitor" },
      },
    })
  })

  it("leaves colocated policies, a local choice and a held caller on the unchanged local path", async () => {
    await seed({ mode: "colocate" })
    const colocated = deps()
    expect(await admit(colocated)).toBeUndefined()
    expect(colocated.resolveHost).not.toHaveBeenCalled()

    await seed({ mode: "auto" })
    expect(await admit(deps(undefined, "local"))).toBeUndefined()
    // `auto` with no Host that has room: the local path gives its own refusal.
    const full = deps()
    full.resolveHost = jest.fn(async () => {
      throw new PlacementWaitingError("no_compatible_capacity")
    })
    expect(await admit(full)).toBeUndefined()

    await seed({ mode: "pinned", ref: "host_b" })
    const held = deps()
    await expect(
      admitWorkflowAppRunPlacement(
        { resolved: release(), actor, input: {}, idempotencyKey: "request-1", placeable: false },
        held
      )
    ).resolves.toBeUndefined()
    expect(held.resolveHost).not.toHaveBeenCalled()
    expect(await getDb().workflowInvocations.count()).toBe(0)
    expect(await getDb().hostDispatchQueue.count()).toBe(0)
  })

  it("maps a replayed idempotency key to the same placed run, whatever the caller's mode", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    const first = await admit(deps())
    const replay = await admit(deps())
    const held = await admitWorkflowAppRunPlacement(
      { resolved: release(), actor, input: {}, idempotencyKey: "request-1", placeable: false },
      deps()
    )
    expect(replay).toEqual({ ...first, reused: true })
    expect(held).toEqual({ ...first, reused: true })
    expect(await getDb().hostDispatchQueue.count()).toBe(1)
  })

  it("counts the app quota once, here, and refuses without a ledger row or a job", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    const limited = release({ concurrentRuns: 1 })
    await admit(deps(), "request-1", limited)
    await expect(admit(deps(), "request-2", limited)).rejects.toBeInstanceOf(WorkflowAppQuotaError)
    expect(emitWorkflowAppQuotaAlert).toHaveBeenCalledTimes(1)
    expect(await getDb().workflowInvocations.count()).toBe(1)
    expect(await getDb().hostDispatchQueue.count()).toBe(1)
  })

  it("refuses input the version's schema rejects before anything is dispatched", async () => {
    await seed(
      { mode: "pinned", ref: "host_b" },
      { type: "object", required: ["question"], properties: { question: { type: "string" } } }
    )
    await expect(admit(deps())).rejects.toMatchObject({ code: "input-schema-violation" })
    await expect(admit(deps())).rejects.toBeInstanceOf(WorkflowAdmissionError)
    expect(await getDb().hostDispatchQueue.count()).toBe(0)
  })

  it("refuses a release whose deployment is no longer active", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    await getDb().workflowDeployments.update("wfd_1", { status: "disabled" })
    await expect(admit(deps())).rejects.toMatchObject({ code: "deployment-not-found" })
    expect(await getDb().workflowInvocations.count()).toBe(0)
  })
})

describe("reading a placed run through its Host", () => {
  it("reports a run that has not landed as queued, never run_not_found", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    await admit(deps())
    const invocation = await onlyInvocation()
    const target: FakeTarget = { calls: [], reply: () => ({ run: null }) }
    await expect(readPlacedWorkflowAppRun(invocation, deps(target))).resolves.toMatchObject({
      runId: "run_placed_1",
      workflowId: "wf_1",
      status: "pending",
      placement: { state: "dispatching" },
    })
    await expect(
      listPlacedWorkflowAppRunEvents(invocation, { afterSequence: 0 }, deps(target))
    ).resolves.toEqual({ events: [], terminal: false })
    // Nothing was asked of a Host that does not have the run yet.
    expect(target.calls).toEqual([])
  })

  it("settles a run whose job ran out of attempts as a typed refusal and frees its quota slot", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    const admitted = await admit(deps())
    await getDb().hostDispatchQueue.update(admitted!.dispatchId, {
      status: "deadletter",
      lastError: "workflow app-run handoff failed: Remote Host host_b is not configured",
    })
    const view = await readPlacedWorkflowAppRun(await onlyInvocation(), deps())
    expect(view).toMatchObject({
      status: "failed",
      error: { code: "handoff_exhausted", message: "The run could not be handed to its Host" },
      placement: { state: "refused" },
    })
    // The transport detail stays in the job, not in the public view.
    expect(JSON.stringify(view)).not.toContain("host_b")
    expect((await onlyInvocation()).status).toBe("rejected")
    const events = await listPlacedWorkflowAppRunEvents(await onlyInvocation(), {
      afterSequence: 0,
    })
    expect(events).toEqual({ events: [], terminal: true })
  })

  it("proxies status to the Host, writes status and usage back, and serves a settled run from the ledger", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    await admit(deps())
    const invocation = await onlyInvocation()
    await recordWorkflowAppRunPlacementAccepted(invocation.id, "run_placed_1", 1_000)
    let status = "running"
    const target: FakeTarget = {
      calls: [],
      reply: () => ({
        run: {
          runId: "run_placed_1",
          workflowId: "wf_1",
          status,
          startedAt: 900,
          ...(status === "succeeded" ? { completedAt: 1_500, output: { answer: 42 } } : {}),
        },
        usage: { tokens: 120, costUsd: 0.25, costKnown: true },
      }),
    }

    await expect(
      readPlacedWorkflowAppRun(await onlyInvocation(), deps(target))
    ).resolves.toMatchObject({
      runId: "run_placed_1",
      status: "running",
      placement: { state: "accepted" },
    })
    expect(await onlyInvocation()).toMatchObject({
      status: "running",
      placement: {
        remoteStatus: "running",
        usage: { tokens: 120, costUsd: 0.25, costKnown: true },
      },
    })

    status = "succeeded"
    await readPlacedWorkflowAppRun(await onlyInvocation(), deps(target))
    expect(await onlyInvocation()).toMatchObject({
      status: "completed",
      placement: { state: "settled", terminal: { status: "succeeded", output: { answer: 42 } } },
    })
    const calls = target.calls.length
    // Settled: the Host is no longer needed to answer status.
    await expect(readPlacedWorkflowAppRun(await onlyInvocation(), deps())).resolves.toMatchObject({
      status: "succeeded",
      completedAt: 1_500,
      output: { answer: 42 },
      placement: { state: "settled" },
    })
    expect(target.calls).toHaveLength(calls)
    expect(target.calls[0]).toEqual({
      command: "workflow_handoff_run_get",
      payload: { runId: "run_placed_1" },
    })
  })

  it("reports the last status as unreachable when the Host cannot answer, and fails an event read", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    await admit(deps())
    await recordWorkflowAppRunPlacementAccepted((await onlyInvocation()).id, "run_placed_1", 1_000)
    await expect(readPlacedWorkflowAppRun(await onlyInvocation(), deps())).resolves.toMatchObject({
      status: "pending",
      placement: { state: "accepted", reachable: false },
    })
    await expect(
      listPlacedWorkflowAppRunEvents(await onlyInvocation(), { afterSequence: 0 }, deps())
    ).rejects.toBeInstanceOf(WorkflowAppRunHostUnavailableError)
  })

  it("pages events from the Host under the serving run id", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    await admit(deps())
    await recordWorkflowAppRunPlacementAccepted((await onlyInvocation()).id, "run_placed_1", 1_000)
    const target: FakeTarget = {
      calls: [],
      reply: () => ({
        run: { runId: "run_placed_1", workflowId: "wf_1", status: "running", startedAt: 900 },
        events: {
          events: [{ runId: "run_placed_1", sequence: 3, type: "step.started", timestamp: "t" }],
          terminal: false,
        },
      }),
    }
    await expect(
      listPlacedWorkflowAppRunEvents(
        await onlyInvocation(),
        { afterSequence: 2, limit: 50 },
        deps(target)
      )
    ).resolves.toEqual({
      events: [{ runId: "run_placed_1", sequence: 3, type: "step.started", timestamp: "t" }],
      terminal: false,
    })
    expect(target.calls[0].payload).toEqual({ runId: "run_placed_1", afterSequence: 2, limit: 50 })
  })
})

describe("cancelling a placed run", () => {
  it("cancels a job that has not been claimed and settles the run as cancelled", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    const admitted = await admit(deps())
    await expect(cancelPlacedWorkflowAppRun(await onlyInvocation(), deps())).resolves.toEqual({
      runId: "run_placed_1",
      cancelled: true,
      mode: "handoff-cancelled",
    })
    expect((await getDb().hostDispatchQueue.get(admitted!.dispatchId))?.status).toBe("cancelled")
    const view = await readPlacedWorkflowAppRun(await onlyInvocation(), deps())
    expect(view).toMatchObject({ status: "cancelled", error: { code: "cancelled" } })
  })

  it("asks the delivery to cancel a run that lands after a cancel during delivery", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    const admitted = await admit(deps())
    await getDb().hostDispatchQueue.update(admitted!.dispatchId, { status: "inflight" })
    await expect(cancelPlacedWorkflowAppRun(await onlyInvocation(), deps())).resolves.toMatchObject(
      {
        cancelled: true,
        mode: "handoff-cancel-pending",
      }
    )
    await expect(
      recordWorkflowAppRunPlacementAccepted((await onlyInvocation()).id, "run_placed_1", 2_000)
    ).resolves.toEqual({ cancelRequested: true })
    expect((await onlyInvocation()).placement).toMatchObject({
      state: "accepted",
      remoteRunId: "run_placed_1",
    })
  })

  it("cancels an accepted run on its Host", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    await admit(deps())
    await recordWorkflowAppRunPlacementAccepted((await onlyInvocation()).id, "run_placed_1", 1_000)
    const target: FakeTarget = {
      calls: [],
      reply: () => ({ runId: "run_placed_1", found: true, cancelled: true, mode: "aborted" }),
    }
    await expect(cancelPlacedWorkflowAppRun(await onlyInvocation(), deps(target))).resolves.toEqual(
      {
        runId: "run_placed_1",
        cancelled: true,
        mode: "aborted",
      }
    )
    expect(target.calls).toEqual([
      { command: "workflow_handoff_run_cancel", payload: { runId: "run_placed_1" } },
    ])
  })
})

describe("quota and sharing across Hosts", () => {
  it("refreshes unsettled placed runs so a finished one stops counting against concurrency", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    const limited = release({ concurrentRuns: 1 })
    await admit(deps(), "request-1", limited)
    await recordWorkflowAppRunPlacementAccepted((await onlyInvocation()).id, "run_placed_1", 1_000)
    const target: FakeTarget = {
      calls: [],
      reply: () => ({
        run: { runId: "run_placed_1", workflowId: "wf_1", status: "failed", startedAt: 900 },
        usage: { tokens: 10, costUsd: 0, costKnown: true },
      }),
    }
    await refreshPlacedWorkflowAppRuns(
      { accountId: getActiveAccountId(), appId: "wfa_1" },
      deps(target)
    )
    expect((await onlyInvocation()).status).toBe("completed")
    // The slot is free again for the next admission.
    await expect(admit(deps(target), "request-2", limited)).resolves.toMatchObject({
      reused: false,
    })
  })

  it("asks the run's Host for a share verdict and withholds when it cannot answer", async () => {
    await seed({ mode: "pinned", ref: "host_b" })
    await admit(deps())
    const pending = await onlyInvocation()
    await expect(
      judgePlacedWorkflowAppRunDisclosure(
        pending,
        { payload: "{}", label: "public workflow result" },
        deps()
      )
    ).resolves.toMatchObject({ outcome: "withhold" })

    await recordWorkflowAppRunPlacementAccepted(pending.id, "run_placed_1", 1_000)
    const target: FakeTarget = {
      calls: [],
      reply: () => ({
        run: { runId: "run_placed_1", workflowId: "wf_1", status: "succeeded", startedAt: 1 },
        disclosure: { outcome: "allow" },
      }),
    }
    await expect(
      judgePlacedWorkflowAppRunDisclosure(
        await onlyInvocation(),
        { payload: '{"run":1}', label: "public workflow result" },
        deps(target)
      )
    ).resolves.toEqual({ outcome: "allow" })
    expect(target.calls[0].payload).toEqual({
      runId: "run_placed_1",
      disclosure: { payload: '{"run":1}', label: "public workflow result" },
    })
    await expect(
      judgePlacedWorkflowAppRunDisclosure(
        await onlyInvocation(),
        { payload: "{}", label: "public workflow result" },
        deps()
      )
    ).resolves.toMatchObject({ outcome: "withhold" })
  })
})
