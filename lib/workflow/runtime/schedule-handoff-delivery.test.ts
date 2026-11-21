import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"
import {
  __resetHostDispatchDeliveriesForTesting,
  deliverHostDispatch,
} from "@/lib/placement/host-dispatch-delivery"
import {
  createScheduleHandoffDelivery,
  registerScheduleHandoffDelivery,
  type WorkflowScheduleHandoffPayload,
} from "./schedule-handoff-delivery"

function job(payload: Partial<WorkflowScheduleHandoffPayload> = {}): HostDispatchJobRow {
  return {
    id: "dispatch-1",
    accountId: "account-1",
    domain: "schedule-handoff",
    targetRef: "cloud-a",
    kind: "workflow.trigger",
    payload: {
      deploymentId: "deployment-1",
      expectedVersionDigest: "wfv1:abc",
      trigger: {
        workflowId: "workflow-1",
        kind: "trigger.cron",
        originAt: 123,
        payload: { scheduledAt: 123 },
      },
      ...payload,
    },
    status: "inflight",
    attempts: 0,
    maxAttempts: 6,
    createdAt: 100,
    updatedAt: 100,
    nextAttemptAt: 100,
    expiresAt: 1_000,
    idempotencyKey: "workflow-trigger:workflow-1:123",
  }
}

describe("createScheduleHandoffDelivery", () => {
  afterEach(__resetHostDispatchDeliveriesForTesting)

  it("delivers the exact deployment and trigger over an isolated target transport", async () => {
    const call = jest.fn().mockResolvedValue({ runId: "run-remote", status: "accepted" })
    const close = jest.fn()
    const openTarget = jest.fn().mockResolvedValue({ transport: { call }, close })
    const delivery = createScheduleHandoffDelivery({ openTarget })

    await expect(delivery(job())).resolves.toBe("succeeded")

    expect(openTarget).toHaveBeenCalledWith("cloud-a")
    expect(call).toHaveBeenCalledWith(
      "workflow_handoff_create",
      expect.objectContaining({
        deploymentId: "deployment-1",
        expectedVersionDigest: "wfv1:abc",
        idempotencyKey: "workflow-trigger:workflow-1:123",
      })
    )
    // The occurrence key rides in the payload only. As the transport
    // Idempotency-Key the Host refuses it (not a UUID) on every transport, so
    // every handoff retried until it dead-lettered.
    expect(call.mock.calls[0]).toHaveLength(2)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("closes the isolated transport and marks connection failures retryable", async () => {
    const close = jest.fn()
    const openTarget = jest.fn().mockResolvedValue({
      transport: { call: jest.fn().mockRejectedValue(new Error("offline")) },
      close,
    })
    const delivery = createScheduleHandoffDelivery({ openTarget })

    await expect(delivery(job())).rejects.toMatchObject({
      code: "handoff_failed",
      retryable: true,
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("rejects malformed durable rows without contacting a target", async () => {
    const openTarget = jest.fn()
    const delivery = createScheduleHandoffDelivery({ openTarget })

    await expect(delivery(job({ expectedVersionDigest: "" }))).rejects.toMatchObject({
      code: "malformed",
      retryable: false,
    })
    expect(openTarget).not.toHaveBeenCalled()
  })

  it("normalizes non-Error failures and leaves unopened transports alone", async () => {
    const delivery = createScheduleHandoffDelivery({
      openTarget: jest.fn().mockRejectedValue("offline"),
    })

    await expect(delivery(job())).rejects.toMatchObject({
      message: "workflow handoff failed: offline",
      retryable: true,
    })
  })

  it("registers and unregisters the schedule handoff domain adapter", async () => {
    const call = jest.fn().mockResolvedValue({ runId: "run-remote" })
    const unregister = registerScheduleHandoffDelivery({
      openTarget: jest.fn().mockResolvedValue({ transport: { call }, close: jest.fn() }),
    })

    await expect(deliverHostDispatch(job())).resolves.toBe("succeeded")
    unregister()
    await expect(deliverHostDispatch(job())).rejects.toMatchObject({ code: "unsupported" })
  })

  it("records the run the target minted so the source can point at it", async () => {
    const recordRemoteRun = jest.fn().mockResolvedValue(undefined)
    const delivery = createScheduleHandoffDelivery({
      recordRemoteRun,
      openTarget: async () => ({
        transport: { call: jest.fn().mockResolvedValue({ runId: "remote-run-1" }) },
        close: jest.fn(),
      }),
    })

    await expect(delivery(job())).resolves.toBe("succeeded")
    expect(recordRemoteRun).toHaveBeenCalledWith("dispatch-1", "remote-run-1")
  })

  it("still succeeds when the target answers without a run id", async () => {
    const recordRemoteRun = jest.fn()
    const delivery = createScheduleHandoffDelivery({
      recordRemoteRun,
      openTarget: async () => ({
        transport: { call: jest.fn().mockResolvedValue(undefined) },
        close: jest.fn(),
      }),
    })

    await expect(delivery(job())).resolves.toBe("succeeded")
    expect(recordRemoteRun).not.toHaveBeenCalled()
  })

  it("does not fail a delivered handoff when the pointer write throws", async () => {
    const delivery = createScheduleHandoffDelivery({
      recordRemoteRun: jest.fn().mockRejectedValue(new Error("dexie closed")),
      openTarget: async () => ({
        transport: { call: jest.fn().mockResolvedValue({ runId: "remote-run-1" }) },
        close: jest.fn(),
      }),
    })

    await expect(delivery(job())).resolves.toBe("succeeded")
  })
})

describe("createScheduleHandoffDelivery: placed Workflow App runs (WF-13)", () => {
  afterEach(__resetHostDispatchDeliveriesForTesting)

  function appJob(): HostDispatchJobRow {
    return {
      ...job(),
      kind: "workflow.app-run",
      idempotencyKey: "wfi_serving",
      payload: {
        invocationId: "wfi_serving",
        runId: "run_placed",
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
    }
  }

  function harness(reply: unknown) {
    const call = jest.fn(async (command: string) =>
      command === "workflow_app_handoff_create" ? reply : { cancelled: true }
    )
    const close = jest.fn()
    const recordRemoteRun = jest.fn(async () => undefined)
    const appLedger = {
      accepted: jest.fn(async () => ({ cancelRequested: false })),
      refused: jest.fn(async () => undefined),
    }
    const delivery = createScheduleHandoffDelivery({
      openTarget: jest.fn().mockResolvedValue({ transport: { call }, close }),
      recordRemoteRun,
      appLedger,
    })
    return { call, close, recordRemoteRun, appLedger, delivery }
  }

  it("sends the locked binding keyed by the serving invocation and records the acceptance", async () => {
    const h = harness({ outcome: "accepted", runId: "run_placed", status: "pending" })
    await expect(h.delivery(appJob())).resolves.toBe("succeeded")
    expect(h.call).toHaveBeenCalledWith("workflow_app_handoff_create", {
      workflowId: "wf_1",
      versionId: "wfv_1",
      deploymentId: "wfd_1",
      deploymentRevision: 4,
      expectedVersionDigest: "wfv1:abc",
      dependencyLock: { workflows: {}, indexes: {} },
      idempotencyKey: "wfi_serving",
      runId: "run_placed",
      payload: { input: { topic: "release" }, appId: "wfa_1", appReleaseId: "wfar_1" },
      initiator: { authenticated: false, externalSubjectKey: "visitor" },
    })
    // The transport mints its own UUID key per attempt; exactly-once is the payload's.
    expect(h.call.mock.calls[0]).toHaveLength(2)
    // The App caller marker stays with the serving ledger.
    expect(JSON.stringify(h.call.mock.calls[0])).not.toContain("app:wfa_1:release")
    expect(h.recordRemoteRun).toHaveBeenCalledWith("dispatch-1", "run_placed")
    expect(h.appLedger.accepted).toHaveBeenCalledWith("wfi_serving", "run_placed")
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it("cancels on the target a run that landed after its caller cancelled", async () => {
    const h = harness({ outcome: "accepted", runId: "run_placed", status: "pending" })
    h.appLedger.accepted.mockResolvedValueOnce({ cancelRequested: true })
    await expect(h.delivery(appJob())).resolves.toBe("succeeded")
    expect(h.call).toHaveBeenLastCalledWith("workflow_handoff_run_cancel", { runId: "run_placed" })
  })

  it("ends the invocation on a typed refusal and does not retry it", async () => {
    const h = harness({
      outcome: "refused",
      refusal: { code: "deployment_digest_mismatch", message: "differs", retryable: false },
    })
    await expect(h.delivery(appJob())).rejects.toMatchObject({
      code: "deployment_digest_mismatch",
      retryable: false,
    })
    expect(h.appLedger.refused).toHaveBeenCalledWith("wfi_serving", "deployment_digest_mismatch")
    expect(h.appLedger.accepted).not.toHaveBeenCalled()
  })

  it("retries the target's own capacity refusal and transport failures without ending the invocation", async () => {
    const busy = harness({
      outcome: "refused",
      refusal: { code: "workflow_concurrency_limit", message: "busy", retryable: true },
    })
    await expect(busy.delivery(appJob())).rejects.toMatchObject({ retryable: true })
    expect(busy.appLedger.refused).not.toHaveBeenCalled()

    const malformed = harness({ runId: "run_placed" })
    await expect(malformed.delivery(appJob())).rejects.toMatchObject({
      code: "handoff_failed",
      retryable: true,
    })
    expect(malformed.appLedger.accepted).not.toHaveBeenCalled()
  })

  it("refuses a malformed app-run job without contacting any Host", async () => {
    const h = harness({ outcome: "accepted", runId: "run_placed" })
    const bad = appJob()
    bad.payload = { ...bad.payload, appCaller: "member:someone" }
    await expect(h.delivery(bad)).rejects.toMatchObject({ code: "malformed", retryable: false })
    expect(h.call).not.toHaveBeenCalled()
  })
})
