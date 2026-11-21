import "fake-indexeddb/auto"

const mockCheckPersonalSink = jest.fn()
jest.mock("@/lib/execution/personal-sink", () => ({
  ...jest.requireActual("@/lib/execution/personal-sink"),
  checkPersonalSink: (...args: unknown[]) => mockCheckPersonalSink(...args),
}))

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
import { assertWorkflowAppAdmissionQuota } from "@/lib/workflow/apps/quota-service"
import type { WorkflowAppHandoffCreateRequest } from "@/lib/workflow/runtime/app-run-handoff"
import type { WorkflowAppRelease } from "@/types/workflow/app"
import { cancelHandoffRun, createWorkflowAppRunHandoff, getHandoffRun } from "./handoff-run-service"

jest.setTimeout(20_000)

const dbFixture = createDbTestFixture()
beforeAll(() => dbFixture.initialize())
beforeEach(async () => {
  await dbFixture.restore()
  mockCheckPersonalSink.mockReset()
})
afterAll(() => dbFixture.dispose())

async function publishedApp(): Promise<WorkflowAppHandoffCreateRequest> {
  const wf = await createWorkflow({
    name: "placed app workflow",
    nodes: [
      {
        id: "n_manual",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "manual", params: {} },
      },
      {
        id: "n_set",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "set", params: { variable: "x", value: 1 } },
      },
    ],
    edges: [{ id: "e1", source: "n_manual", target: "n_set" }],
  })
  const published = await publishWorkflow(wf.id, 1)
  const version = await getDb().workflowVersions.get(published.versionId)
  return {
    workflowId: wf.id,
    versionId: published.versionId,
    deploymentId: published.deploymentId,
    deploymentRevision: published.deploymentRevision,
    expectedVersionDigest: version!.digest,
    idempotencyKey: "wfi_serving_invocation",
    runId: "run_from_serving_host",
    payload: { input: { topic: "release" }, appId: "wfa_1", appReleaseId: "wfar_1" },
    initiator: { authenticated: false, externalSubjectKey: "visitor" },
  }
}

async function settled(runId: string): Promise<string> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const run = await getDb().workflowRuns.get(runId)
    if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) return run.status
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("createWorkflowAppRunHandoff (WF-13 target)", () => {
  it("admits exactly the locked version under the serving run id, once per serving invocation", async () => {
    const request = await publishedApp()
    const accountId = getActiveAccountId()
    const first = await createWorkflowAppRunHandoff({
      accountId,
      callerDeviceId: "dev-a",
      request,
    })
    expect(first).toMatchObject({ outcome: "accepted", runId: "run_from_serving_host" })
    expect(await settled("run_from_serving_host")).toBe("succeeded")

    // A redelivered job (same serving invocation id) maps to the same run.
    const replay = await createWorkflowAppRunHandoff({
      accountId,
      callerDeviceId: "dev-a",
      request,
    })
    expect(replay).toMatchObject({ outcome: "accepted", runId: "run_from_serving_host" })
    const invocations = await getDb().workflowInvocations.toArray()
    expect(invocations).toHaveLength(1)
    expect(invocations[0]).toMatchObject({
      entrypoint: "http",
      caller: "host:dev-a",
      versionId: request.versionId,
      runId: "run_from_serving_host",
    })
    const run = await getDb().workflowRuns.get("run_from_serving_host")
    expect(run).toMatchObject({
      versionId: request.versionId,
      triggerPayload: request.payload,
      triggeredBy: {
        source: "api",
        deviceId: "dev-a",
        initiator: { authenticated: false, externalSubjectKey: "visitor" },
      },
    })
  })

  it("never counts the App's quota a second time on the target", async () => {
    const request = await publishedApp()
    const accountId = getActiveAccountId()
    await createWorkflowAppRunHandoff({ accountId, callerDeviceId: "dev-a", request })
    const release = {
      snapshot: { quota: { concurrentRuns: 1, requestsPerMinute: 1 } },
    } as unknown as WorkflowAppRelease
    // The handed-over run is admitted as `host:dev-a`, never as an `app:` caller.
    await expect(
      assertWorkflowAppAdmissionQuota({ appId: "wfa_1", accountId, release, now: Date.now() })
    ).resolves.toBeUndefined()
    await settled("run_from_serving_host")
  })

  it("refuses a missing version, a different digest and an inactive deployment, typed and final", async () => {
    const request = await publishedApp()
    const accountId = getActiveAccountId()
    await expect(
      createWorkflowAppRunHandoff({
        accountId,
        callerDeviceId: "dev-a",
        request: { ...request, versionId: "wfv_missing" },
      })
    ).resolves.toMatchObject({
      outcome: "refused",
      refusal: { code: "version_not_found", retryable: false },
    })
    await expect(
      createWorkflowAppRunHandoff({
        accountId,
        callerDeviceId: "dev-a",
        request: { ...request, expectedVersionDigest: "wfv1:other" },
      })
    ).resolves.toMatchObject({
      outcome: "refused",
      refusal: { code: "deployment_digest_mismatch", retryable: false },
    })
    await getDb().workflowDeployments.update(request.deploymentId, { status: "disabled" })
    await expect(
      createWorkflowAppRunHandoff({ accountId, callerDeviceId: "dev-a", request })
    ).resolves.toMatchObject({ outcome: "refused", refusal: { code: "deployment_not_found" } })
    await expect(
      createWorkflowAppRunHandoff({ accountId: "other-account", callerDeviceId: "dev-a", request })
    ).resolves.toMatchObject({ outcome: "refused", refusal: { code: "deployment_not_found" } })
    expect(await getDb().workflowInvocations.count()).toBe(0)
  })
})

describe("host-scoped reads of a handed-over run", () => {
  it("answers only the Host that handed the run over, with usage, events and a disclosure verdict", async () => {
    const request = await publishedApp()
    const accountId = getActiveAccountId()
    await createWorkflowAppRunHandoff({ accountId, callerDeviceId: "dev-a", request })
    await settled("run_from_serving_host")
    await getDb().sessionUsage.put({
      messageId: "wf:run_from_serving_host:prompt",
      sessionId: "wf:run_from_serving_host",
      runId: "run_from_serving_host",
      at: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 2,
      cacheReadTokens: 3,
      costUsd: 0.5,
      costKnown: true,
      durationMs: 1,
      surface: "workflow",
    } as never)
    mockCheckPersonalSink.mockResolvedValue({ outcome: "allow" })

    const reply = await getHandoffRun({
      accountId,
      callerDeviceId: "dev-a",
      request: {
        runId: "run_from_serving_host",
        afterSequence: 0,
        disclosure: { payload: '{"run":1}', label: "public workflow result" },
      },
    })
    expect(reply.run).toMatchObject({ runId: "run_from_serving_host", status: "succeeded" })
    expect(reply.usage).toEqual({ tokens: 20, costUsd: 0.5, costKnown: true })
    expect(reply.events?.events.length).toBeGreaterThan(0)
    expect(reply.events?.terminal).toBe(true)
    expect(reply.disclosure).toEqual({ outcome: "allow" })
    expect(mockCheckPersonalSink).toHaveBeenCalledWith(
      { executionRunId: "execution:workflow:run_from_serving_host" },
      { kind: "unknown", label: "public workflow result" },
      '{"run":1}',
      { kind: "public-share", workflowRunId: "run_from_serving_host" }
    )

    // Another Host, even a paired one, learns nothing about the run.
    await expect(
      getHandoffRun({
        accountId,
        callerDeviceId: "dev-b",
        request: { runId: "run_from_serving_host" },
      })
    ).resolves.toEqual({ run: null })
    await expect(
      cancelHandoffRun({ accountId, callerDeviceId: "dev-b", runId: "run_from_serving_host" })
    ).resolves.toEqual({
      runId: "run_from_serving_host",
      found: false,
      cancelled: false,
      mode: "not-found",
    })
  })

  it("withholds when the run's personal sink withholds or cannot decide", async () => {
    const request = await publishedApp()
    const accountId = getActiveAccountId()
    await createWorkflowAppRunHandoff({ accountId, callerDeviceId: "dev-a", request })
    await settled("run_from_serving_host")
    mockCheckPersonalSink.mockResolvedValueOnce({
      outcome: "withhold",
      persons: [],
      reason: "disclosure-mismatch",
    })
    const disclosure = { payload: "{}", label: "public workflow result" }
    await expect(
      getHandoffRun({
        accountId,
        callerDeviceId: "dev-a",
        request: { runId: "run_from_serving_host", disclosure },
      })
    ).resolves.toMatchObject({ disclosure: { outcome: "withhold", reason: "disclosure-mismatch" } })
    mockCheckPersonalSink.mockRejectedValueOnce(new Error("Personal sink execution unavailable"))
    await expect(
      getHandoffRun({
        accountId,
        callerDeviceId: "dev-a",
        request: { runId: "run_from_serving_host", disclosure },
      })
    ).resolves.toMatchObject({
      disclosure: { outcome: "withhold", reason: "Personal sink execution unavailable" },
    })
  })

  it("lets the handing-over Host cancel its run", async () => {
    const request = await publishedApp()
    const accountId = getActiveAccountId()
    await createWorkflowAppRunHandoff({ accountId, callerDeviceId: "dev-a", request })
    await settled("run_from_serving_host")
    const result = await cancelHandoffRun({
      accountId,
      callerDeviceId: "dev-a",
      runId: "run_from_serving_host",
    })
    // The run already finished, so there is nothing left to stop — but it was found.
    expect(result).toMatchObject({ runId: "run_from_serving_host", found: true, cancelled: false })
  })
})
