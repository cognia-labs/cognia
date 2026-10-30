import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflow, updateWorkflow } from "@/lib/db/workflows"
import { holdWorkflowDispatchForApproval } from "@/lib/connectors/hitl/workflow-run-approval"
import { createPublishedWorkflowDependencyBinding } from "@/lib/workflow/runtime/execution-authority"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { publishWorkflowLifecycle } from "@/lib/workflow/publish/publication-lifecycle"
import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { startWorkflowFromIM } from "@/lib/workflow/runtime/start-from-im"
import { consumeCallbackBindingAtomically } from "@/lib/connectors/callback-authorization"
import {
  handleWorkflowApprovalCallback,
  recoverPendingWorkflowApprovals,
  startWorkflowApprovalRecovery,
} from "./workflow-approval-handler"

jest.mock("@/lib/workflow/runtime/start-from-im", () => {
  const actual = jest.requireActual("@/lib/workflow/runtime/start-from-im")
  return { ...actual, startWorkflowFromIM: jest.fn(actual.startWorkflowFromIM) }
})

// Pass-through spy: the real gateway still queues the job, the test can see
// what the handler asked it to authorize.
jest.mock("@/lib/connectors/delivery-gateway", () => {
  const actual = jest.requireActual("@/lib/connectors/delivery-gateway")
  return { ...actual, enqueueGoverned: jest.fn(actual.enqueueGoverned) }
})

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})

async function seedBindingPair(
  workflowId: string,
  workflowName: string,
  extra: Record<string, unknown> = {}
) {
  const adapterId = "wecom:a"
  const surfaceId = "wfsurf:abc"
  const conversationKey = "wecom:wecom:a:room"
  const payload = {
    workflowId,
    workflowName,
    runParams: { x: 1 },
    triggeredFrom: {
      source: "im" as const,
      adapterId,
      conversationKey,
      sessionId: "s1",
    },
    ...extra,
  }
  const lockedDependency = await createPublishedWorkflowDependencyBinding(workflowId).catch(
    () => undefined
  )
  if (lockedDependency) Object.assign(payload, { lockedDependency })
  await recordCallbackBinding({
    adapterId,
    actionId: "wfapp:abc",
    kind: "wf_approve",
    surfaceId,
    componentId: "approve",
    conversationKey,
    payload,
  })
  await recordCallbackBinding({
    adapterId,
    actionId: "wfcan:abc",
    kind: "wf_cancel",
    surfaceId,
    componentId: "cancel",
    conversationKey,
    payload,
  })
  return { adapterId, surfaceId, conversationKey }
}

afterAll(dbFixture.dispose)

async function waitForCheck(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("Timed out awaiting approval recovery")
}

describe("handleWorkflowApprovalCallback", () => {
  it("recovers the same admitted run after a transient driver startup failure", async () => {
    const wf = await createWorkflow({ name: "Driver startup retry" })
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, conversationKey } = await seedBindingPair(wf.id, "Driver retry")
    const binding = (await getDb().connectorCallbackBindings.get(`${adapterId}:wfapp:abc`))!
    const failStartup = jest
      .spyOn(getDb().workflowInvocations, "update")
      .mockRejectedValueOnce(new Error("startup storage unavailable"))
    try {
      await handleWorkflowApprovalCallback({
        binding,
        adapterId,
        conversationKey,
        platform: "wecom",
        cancelled: false,
      })
    } finally {
      failStartup.mockRestore()
    }
    const [admitted] = await getDb().workflowRuns.toArray()
    expect(admitted.status).toBe("pending")
    expect(await getDb().connectorCallbackBindings.get(binding.id)).toMatchObject({
      workflowDispatch: { status: "started", runId: admitted.id },
    })
    await recoverPendingWorkflowApprovals({ ownsAdapter: () => true })
    await waitForCheck(
      async () => (await getDb().workflowRuns.get(admitted.id))?.status === "succeeded"
    )
    await recoverPendingWorkflowApprovals({ ownsAdapter: () => true })
    expect(await getDb().workflowInvocations.count()).toBe(1)
    expect(await getDb().workflowRuns.count()).toBe(1)
    expect(await getDb().connectorCallbackBindings.get(binding.id)).toMatchObject({
      workflowDispatch: { status: "settled", runId: admitted.id },
    })
  })

  it("runs the recovery clock at boot and every five seconds without overlap, and stops on abort", async () => {
    const wf = await createWorkflow({ name: "Clock retry" })
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId } = await seedBindingPair(wf.id, "Clock retry")
    const binding = (await getDb().connectorCallbackBindings.get(`${adapterId}:wfapp:abc`))!
    await consumeCallbackBindingAtomically(binding, Date.now())
    let tick: () => void = () => undefined
    const interval = jest.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
      tick = callback as () => void
      return 123 as unknown as ReturnType<typeof setInterval>
    })
    const clear = jest.spyOn(globalThis, "clearInterval")
    let fail!: (error: Error) => void
    jest.mocked(startWorkflowFromIM).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )
    const calls = jest.mocked(startWorkflowFromIM).mock.calls.length
    const errors = jest.fn(),
      ownsAdapter = jest.fn(() => true),
      controller = new AbortController()
    const recoverObservers = jest.fn().mockResolvedValue(undefined)
    const stop = startWorkflowApprovalRecovery({
      recoverObservers,
      ownsAdapter,
      signal: controller.signal,
      onError: errors,
    })
    try {
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000)
      await waitForCheck(() => jest.mocked(startWorkflowFromIM).mock.calls.length === calls + 1)
      tick()
      tick()
      await waitForCheck(() => recoverObservers.mock.calls.length >= 2)
      expect(jest.mocked(startWorkflowFromIM).mock.calls.length).toBe(calls + 1)
      fail(new Error("transient startup"))
      await waitForCheck(() => errors.mock.calls.length === 1)
      tick()
      await waitForCheck(async () => (await getDb().workflowRuns.count()) === 1)
      await waitForCheck(
        async () => (await getDb().workflowRuns.toArray())[0]?.status === "succeeded"
      )
      controller.abort()
      const owned = ownsAdapter.mock.calls.length
      const observerCalls = recoverObservers.mock.calls.length
      tick()
      expect(recoverObservers.mock.calls.length).toBe(observerCalls)
      expect(ownsAdapter.mock.calls.length).toBe(owned)
      expect(clear).toHaveBeenCalledWith(123)
    } finally {
      stop()
      interval.mockRestore()
      clear.mockRestore()
    }
  })

  it("does not admit a new run from a card after its deployment is disabled", async () => {
    const wf = await createWorkflow({ name: "Disabled after ask" })
    const published = await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, conversationKey } = await seedBindingPair(wf.id, "Disabled")
    const binding = (await getDb().connectorCallbackBindings.get(`${adapterId}:wfapp:abc`))!
    await getDb().workflowDeployments.update(published.deploymentId, { status: "disabled" })
    await handleWorkflowApprovalCallback({
      binding,
      adapterId,
      conversationKey,
      platform: "wecom",
      cancelled: false,
    })
    expect(await getDb().workflowRuns.count()).toBe(0)
    expect(await getDb().connectorCallbackBindings.get(binding.id)).toMatchObject({
      workflowDispatch: { status: "settled" },
    })
  })

  it("recovers an accepted approval after transient admission failure without another click", async () => {
    const wf = await createWorkflow({ name: "Recoverable" })
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, conversationKey } = await seedBindingPair(wf.id, "Recoverable")
    const binding = (await getDb().connectorCallbackBindings.get(`${adapterId}:wfapp:abc`))!
    await consumeCallbackBindingAtomically(binding, Date.now())
    jest
      .mocked(startWorkflowFromIM)
      .mockRejectedValueOnce(new Error("temporary storage unavailable"))
    await expect(
      handleWorkflowApprovalCallback({
        binding,
        adapterId,
        conversationKey,
        platform: "wecom",
        cancelled: false,
      })
    ).rejects.toThrow("temporary storage")
    expect(await getDb().connectorCallbackBindings.get(binding.id)).toMatchObject({
      workflowDispatch: { status: "pending" },
    })
    // A different host must not pick up this host's accepted work.
    await recoverPendingWorkflowApprovals({ ownsAdapter: () => false })
    expect(await getDb().workflowRuns.count()).toBe(0)
    await recoverPendingWorkflowApprovals({ ownsAdapter: (id) => id === adapterId })
    await recoverPendingWorkflowApprovals({ ownsAdapter: () => true })
    expect(await getDb().workflowRuns.count()).toBe(1)
    expect(await getDb().connectorCallbackBindings.get(binding.id)).toMatchObject({
      workflowDispatch: { status: "settled" },
    })
  })

  it("retries confirmation delivery without starting another workflow", async () => {
    const wf = await createWorkflow({ name: "Confirmation retry" })
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, conversationKey } = await seedBindingPair(wf.id, "Confirmation retry")
    const binding = (await getDb().connectorCallbackBindings.get(`${adapterId}:wfapp:abc`))!
    jest.mocked(enqueueGoverned).mockRejectedValueOnce(new Error("temporary enqueue failure"))
    const before = jest.mocked(startWorkflowFromIM).mock.calls.length
    await expect(
      handleWorkflowApprovalCallback({
        binding,
        adapterId,
        conversationKey,
        platform: "wecom",
        cancelled: false,
      })
    ).rejects.toThrow("temporary enqueue")
    expect(await getDb().connectorCallbackBindings.get(binding.id)).toMatchObject({
      workflowDispatch: { status: "started", runId: expect.any(String) },
    })
    await recoverPendingWorkflowApprovals({ ownsAdapter: () => true })
    const retries = jest.mocked(startWorkflowFromIM).mock.calls.slice(before)
    expect(new Set(retries.map(([input]) => input.idempotencyKey)).size).toBe(1)
    expect(await getDb().workflowInvocations.count()).toBe(1)
    expect(await getDb().workflowRuns.count()).toBe(1)
  })

  it("executes the publication displayed by a held approval after a newer version is published", async () => {
    const wf = await createWorkflow({ name: "Original approved version" })
    const first = await publishWorkflowLifecycle(wf.id, 10)
    await holdWorkflowDispatchForApproval({
      workflowId: wf.id,
      runParams: {},
      triggeredFrom: { source: "im", adapterId: "tg", conversationKey: "telegram:tg:room" },
      adapterId: "tg",
      conversationKey: "telegram:tg:room",
      conversationRef: { platform: "telegram", adapterId: "tg" },
      enqueue: jest.fn(async () => undefined) as never,
    })
    const binding = (await getDb().connectorCallbackBindings.toArray()).find(
      (row) => row.kind === "wf_approve"
    )!
    await updateWorkflow(wf.id, { name: "New unreviewed version" })
    await publishWorkflowLifecycle(wf.id, 20)
    await handleWorkflowApprovalCallback({
      binding,
      cancelled: false,
      adapterId: "tg",
      platform: "telegram",
      conversationKey: "telegram:tg:room",
    })
    const run = (await getDb().workflowRuns.toArray()).find((row) => row.workflowId === wf.id)
    expect(run?.versionId).toBe(first.versionId)
  })

  it("approve path starts the workflow + enqueues a confirmation + consumes bindings", async () => {
    const wf = await createWorkflow({ name: "Daily Standup" })
    // `executeDeployedWorkflow` is a FORMAL invocation: it resolves a published
    // production deployment and refuses with `deployment-not-found` when there
    // is none. A workflow that was only created has never been published, so
    // without this the approve path takes the not-found branch and asserts
    // nothing about approving.
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair(wf.id, "Daily Standup")
    const approveBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: approveBinding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    // ADR-0239: a confirmation of the click, in the conversation it came from.
    expect(enqueueGoverned).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: { kind: "system-notice", inboundConversationKey: conversationKey },
      })
    )
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].source).toBe("workflow")
    const seg = jobs[0].request.segments[0] as { type: string; text: string }
    expect(seg.type).toBe("text")
    expect(seg.text).toContain("Daily Standup")
    expect(seg.text).toContain("已启动")

    const runs = await getDb().workflowRuns.toArray()
    expect(runs.find((r) => r.workflowId === wf.id)).toBeDefined()

    const bindings = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(bindings).toHaveLength(2)
    expect(bindings.every((row) => row.consumedAt !== undefined)).toBe(true)
    expect(bindings.some((row) => row.workflowDispatch?.status === "settled")).toBe(true)
  })

  it("carries the frozen permission ceiling into the approved run", async () => {
    // The card can sit unanswered for hours. Re-deriving the ceiling at press
    // time would let a policy change between the ask and the answer widen the
    // run that was actually approved, so the binding carries it verbatim.
    const wf = await createWorkflow({ name: "Deploy" })
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, conversationKey } = await seedBindingPair(wf.id, "Deploy", {
      permissionCeiling: { allowedTools: ["Read"], permissionMode: "default" },
    })
    const approveBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: approveBinding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    const run = (await getDb().workflowRuns.toArray()).find((r) => r.workflowId === wf.id)
    expect(run?.securityContext?.permissionCeiling).toEqual({
      allowedTools: ["Read"],
      permissionMode: "default",
    })
  })

  it("cancel path enqueues a cancellation + consumes bindings + does NOT create a run", async () => {
    const wf = await createWorkflow({ name: "Daily Standup" })
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair(wf.id, "Daily Standup")
    const cancelBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfcan:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: cancelBinding,
      cancelled: true,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已取消")

    const runs = await getDb().workflowRuns.toArray()
    expect(runs.find((r) => r.workflowId === wf.id)).toBeUndefined()

    const bindings = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(bindings).toHaveLength(2)
    expect(bindings.every((row) => row.consumedAt !== undefined)).toBe(true)
    expect(bindings.some((row) => row.workflowDispatch?.status === "settled")).toBe(true)
  })

  it("emits an error message when the workflow no longer exists", async () => {
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair("wf_missing", "Ghost")
    const approveBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: approveBinding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("无法启动")
    const bindings = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(bindings).toHaveLength(2)
    expect(bindings.every((row) => row.consumedAt !== undefined)).toBe(true)
    expect(bindings.some((row) => row.workflowDispatch?.status === "settled")).toBe(true)
  })

  it("silently cleans up when the binding payload is malformed", async () => {
    const adapterId = "wecom:a"
    const surfaceId = "wfsurf:bad"
    await recordCallbackBinding({
      adapterId,
      actionId: "wfapp:bad",
      kind: "wf_approve",
      surfaceId,
      payload: { bogus: true } as never,
    })
    const binding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:bad"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey: "wecom:wecom:a:room",
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)
    const remaining = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .toArray()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].workflowDispatch?.status).toBe("settled")
  })
})

it("preserves captured QQ interaction authority in its confirmation", async () => {
  const conversationKey = "qq-official:qq:chat"
  const deliveryTarget = {
    address: {
      platform: "qq-official" as const,
      adapterId: "qq",
      conversationKey,
      scopeKind: "group" as const,
      containerId: "chat",
    },
    conversationRef: {
      platform: "qq-official" as const,
      adapterId: "qq",
      scene: "group",
      sceneId: "chat",
      eventId: "press",
      receivedAt: Date.now(),
    },
    refreshedAt: Date.now(),
  }
  const input = {
    adapterId: "qq",
    platform: "qq-official",
    conversationKey,
    deliveryTarget,
    cancelled: true,
    binding: {
      id: "qq:cancel",
      adapterId: "qq",
      actionId: "cancel",
      kind: "wf_cancel",
      surfaceId: "qq-surface",
      conversationKey,
      createdAt: Date.now(),
      payload: {
        workflowId: "wf",
        triggeredFrom: {
          source: "im",
          adapterId: "qq",
          conversationKey: "qq-official:qq:chat",
          sessionId: "session",
        },
      },
    },
  } as const
  await getDb().connectorCallbackBindings.put(input.binding)
  await handleWorkflowApprovalCallback(input)
  const jobs = await getDb().outboundQueue.toArray()
  expect(jobs).toHaveLength(1)
  expect(jobs[0]!.request.conversationRef).toEqual(deliveryTarget.conversationRef)
  expect(jobs[0]!.request.deliveryTarget).toEqual(deliveryTarget)
})
