/** @jest-environment jsdom */
/**
 * Verifies that `dispatchInboundFull` fans out to matching workflows after
 * routing + audit. The trigger dispatch is the M2 addition; the existing
 * pipeline tests (`bus.runtime.test.ts`) cover all other steps.
 */

import "fake-indexeddb/auto"
import { waitFor } from "@testing-library/react"
import { dispatchConnectorInboundToBots } from "@/lib/bot/sources/connector-inbound"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import { recordDeliveredMessage } from "./delivered-messages"
import {
  acceptConnectorAutomationFanOut,
  enqueueConnectorInboundJob,
  listPendingConnectorAutomationFanOuts,
  listRecoverableConnectorInboundJobs,
} from "@/lib/db/connector-inbound-jobs"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { TriggerPolicy } from "@/types/connectors/policy"

const dispatchTriggerMock = jest.fn()
const findMatchingWorkflowsMock = jest.fn()

jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  __esModule: true,
  dispatchTrigger: (...args: unknown[]) => dispatchTriggerMock(...args),
}))

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  __esModule: true,
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflowsMock(...args),
}))

jest.mock("@/lib/bot/sources/connector-inbound", () => ({
  dispatchConnectorInboundToBots: jest.fn().mockResolvedValue({}),
}))

jest.mock("@/lib/db/connector-inbound-jobs", () => {
  const actual = jest.requireActual("@/lib/db/connector-inbound-jobs")
  return {
    ...actual,
    listRecoverableConnectorInboundJobs: jest.fn(actual.listRecoverableConnectorInboundJobs),
  }
})

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

function privateEvent(adapterId: string, messageId: string): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:private`,
    sender: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
    channel: { id: "ch_private", kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

it("uses common delivery capabilities before forwarding any provider's explicit stream", async () => {
  const bus = getBus(),
    adapter = makeAdapter("stream-provider")
  adapter.streamReply = jest.fn(async () => undefined)
  bus.registerAdapter(adapter)
  const req = {
    conversationRef: { platform: "telegram" as const, adapterId: adapter.id },
    streamKey: "turn",
    text: "Hello",
    sendOptions: { mode: "reengagement" as const },
  }
  expect(await bus.streamReplyOutbound(adapter.id, req)).toBe(false)
  expect(adapter.streamReply).not.toHaveBeenCalled()
  adapter.meta.capabilities = ["send.reengagement"]
  expect(await bus.streamReplyOutbound(adapter.id, req)).toBe(true)
  expect(adapter.streamReply).toHaveBeenCalledWith(req)
})

// 30s hook budget: the first cold open of the full schema (100+ Dexie
// versions) can exceed jest's default 5s under parallel suite load.
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
  dispatchTriggerMock.mockReset()
  findMatchingWorkflowsMock.mockReset()
  jest
    .mocked(dispatchConnectorInboundToBots)
    .mockReset()
    .mockResolvedValue({} as never)
  jest
    .mocked(listRecoverableConnectorInboundJobs)
    .mockReset()
    .mockImplementation(
      jest.requireActual("@/lib/db/connector-inbound-jobs").listRecoverableConnectorInboundJobs
    )
}, 30_000)

describe("ConnectorBus workflow trigger fan-out", () => {
  it("routes a common typed interaction to configured workflows without accepting observer mutations", async () => {
    const event: NormalizedInboundEvent = {
      ...privateEvent("controls", "control"),
      originEventId: "control",
      kind: "system",
      systemKind: "interaction",
      interaction: { kind: "model_change", action: "selected" },
      plainText: "",
      segments: [],
    }
    const bus = getBus(),
      observed = jest.fn()
    bus.subscribeInbound((copy) => {
      copy.interaction = { kind: "session_reset" }
      copy.deliveryPermissionChange = { proactive: true }
    })
    bus.subscribeInbound(observed)
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "controls", nodeId: "n1", params: {} },
    ])
    await bus.dispatchInboundFull(event, { requireAcceptance: true })
    for (let i = 0; i < 100 && !dispatchTriggerMock.mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 2))
    expect(observed).toHaveBeenCalledWith(
      expect.objectContaining({ interaction: { kind: "model_change", action: "selected" } })
    )
    expect(dispatchTriggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "trigger.connector.system",
        payload: expect.objectContaining({
          interaction: { kind: "model_change", action: "selected" },
        }),
      })
    )
    expect(await getDb().messages.count()).toBe(0)
    expect(await getDb().connectorConversationStates.count()).toBe(0)
    expect(
      (await getDb().connectorAudit.toArray()).filter((row) => row.kind === "inbound.interaction")
    ).toHaveLength(1)
  })
  it("carries referral metadata through isolated observers, lifecycle audit and workflow without a model message", async () => {
    const bus = getBus(),
      observed = jest.fn()
    bus.subscribeInbound((event) => {
      event.referral!.state = "forged"
      event.deliveryPermissionChange = { proactive: true }
    })
    bus.subscribeInbound(observed)
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "referrals", nodeId: "n1", params: {} },
    ])
    const event: NormalizedInboundEvent = {
      ...privateEvent("referrals", "friend-event"),
      kind: "system",
      systemKind: "lifecycle",
      originEventId: "friend-event",
      canReplyToMessage: false,
      plainText: "",
      segments: [],
      referral: { source: "campaign", state: "spring" },
    }
    await bus.dispatchInboundFull(event)
    await bus.dispatchInboundFull(event)
    for (let i = 0; i < 100 && !dispatchTriggerMock.mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 1))
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed.mock.calls[0][0].referral).toEqual({ source: "campaign", state: "spring" })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    expect(dispatchTriggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "trigger.connector.system",
        payload: expect.objectContaining({ referral: { source: "campaign", state: "spring" } }),
      })
    )
    const audit = await getDb().connectorAudit.toArray()
    expect(audit).toContainEqual(
      expect.objectContaining({
        kind: "inbound.lifecycle",
        fields: expect.objectContaining({ referral: { source: "campaign", state: "spring" } }),
      })
    )
    expect(event).not.toHaveProperty("deliveryPermissionChange")
    expect(await getDb().connectorConversationStates.count()).toBe(0)
    expect(await getDb().messages.count()).toBe(0)
    expect(await getDb().outboundQueue.count()).toBe(0)
  })
  async function seedAutoAdapter(): Promise<string> {
    const row = await createAdapterInstance({
      type: "telegram",
      displayName: "Auto Bot",
      enabled: true,
      transportMode: "stub",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: AUTO_TRIGGER,
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
    })
    const bus = getBus()
    bus.registerAdapter(makeAdapter(row.id))
    return row.id
  }

  it.each(["matching", "dispatch"])(
    "recovers failed Workflow %s without replaying the responder",
    async (phase) => {
      const adapterId = await seedAutoAdapter()
      const bus = getBus()
      bus.routeHandler = jest.fn().mockResolvedValue(undefined)
      let unavailable = true
      findMatchingWorkflowsMock.mockImplementation(() => {
        if (phase === "matching" && unavailable) throw new Error("subscription lookup unavailable")
        return [{ workflowId: "recoverable", nodeId: "n", params: {} }]
      })
      dispatchTriggerMock.mockImplementation(async () => {
        if (phase === "dispatch" && unavailable) throw new Error("admission store unavailable")
      })
      const event = privateEvent(adapterId, "recover-observer")
      await bus.dispatchInboundFull(event)
      await bus.flushInboundTurns()
      expect(
        (await listPendingConnectorAutomationFanOuts()).map((job) => job.sourceMessageId)
      ).toEqual([event.messageId])
      expect(bus.routeHandler).toHaveBeenCalledTimes(1)
      unavailable = false
      await bus.resumeAutomationFanOuts()
      await bus.flushInboundTurns()
      expect(await listPendingConnectorAutomationFanOuts()).toEqual([])
      expect(bus.routeHandler).toHaveBeenCalledTimes(1)
      const occurrences = dispatchTriggerMock.mock.calls.map(([input]) => input.occurrenceKey)
      expect(occurrences).toHaveLength(phase === "dispatch" ? 2 : 1)
      expect(new Set(occurrences).size).toBe(1)
    }
  )

  it.each(["observers", "startup"])(
    "completes observer-owned jobs through %s recovery after a responder is installed",
    async (recovery) => {
      const adapterId = await seedAutoAdapter()
      const bus = getBus()
      findMatchingWorkflowsMock.mockReturnValue([
        { workflowId: "observer-only", nodeId: "n", params: {} },
      ])
      dispatchTriggerMock
        .mockRejectedValueOnce(new Error("admission unavailable"))
        .mockResolvedValue(undefined)
      await bus.dispatchInboundFull(privateEvent(adapterId, "observer-owned"))
      await bus.flushInboundTurns()
      const [pending] = await listPendingConnectorAutomationFanOuts()
      expect(pending?.status).toBe("queued")
      bus.routeHandler = jest.fn().mockResolvedValue(undefined)
      if (recovery === "startup") await bus.resumeDurableInboundJobs()
      else await bus.resumeAutomationFanOuts()
      await bus.flushInboundTurns()
      expect(await getDb().connectorInboundJobs.get(pending.id)).toMatchObject({
        status: "completed",
        automationFanOut: { state: "settled" },
      })
      expect(await bus.resumeDurableInboundJobs()).toMatchObject({ resumed: 0 })
      await bus.flushInboundTurns()
      expect(bus.routeHandler).not.toHaveBeenCalled()
      expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
    }
  )

  it.each(["workflow", "bot"])(
    "keeps FIFO behind a gated %s sibling after another Workflow fails",
    async (sibling) => {
      const adapterId = await seedAutoAdapter()
      const bus = getBus()
      findMatchingWorkflowsMock.mockReturnValue([
        { workflowId: "fail", nodeId: "fail", params: {} },
        { workflowId: "slow", nodeId: "slow", params: {} },
      ])
      let release!: () => void
      let markSlow!: () => void
      let markSecond!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const slowStarted = new Promise<void>((resolve) => {
        markSlow = resolve
      })
      const secondStarted = new Promise<"advanced">((resolve) => {
        markSecond = () => resolve("advanced")
      })
      let failed = false
      let held = false
      dispatchTriggerMock.mockImplementation(
        async (input: { workflowId: string; payload: { messageId: string } }) => {
          if (input.payload.messageId === "second") markSecond()
          if (input.payload.messageId === "first" && input.workflowId === "fail" && !failed) {
            failed = true
            throw new Error("one sibling failed")
          }
          if (
            input.payload.messageId === "first" &&
            input.workflowId === "slow" &&
            sibling === "workflow" &&
            !held
          ) {
            held = true
            markSlow()
            await gate
          }
        }
      )
      jest.mocked(dispatchConnectorInboundToBots).mockImplementation(async ({ event }) => {
        if (event.messageId === "first" && sibling === "bot" && !held) {
          held = true
          markSlow()
          await gate
        }
        return {} as never
      })
      await bus.dispatchInboundFull(privateEvent(adapterId, "first"))
      await slowStarted
      await waitFor(async () =>
        expect(
          await getDb()
            .connectorAudit.filter((row) => row.reason === "workflow_dispatch_failed")
            .count()
        ).toBe(1)
      )
      await bus.dispatchInboundFull(privateEvent(adapterId, "second"))
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        // A bounded negative observation: the child gate remains closed for the
        // whole window, so an early reject must not admit the next occurrence.
        const outcome = await Promise.race([
          secondStarted,
          new Promise<"held">((resolve) => {
            deadline = setTimeout(() => resolve("held"), 100)
          }),
        ])
        expect(outcome).toBe("held")
      } finally {
        if (deadline) clearTimeout(deadline)
        release()
        await bus.flushInboundTurns()
        await waitFor(async () => expect(await listPendingConnectorAutomationFanOuts()).toEqual([]))
        await bus.flushInboundTurns()
      }
      await expect(secondStarted).resolves.toBe("advanced")
    }
  )

  it("uses committed observer ownership when recovery collected an older snapshot", async () => {
    const adapterId = await seedAutoAdapter()
    const bus = getBus()
    const event = privateEvent(adapterId, "stale-owner-snapshot")
    const job = await enqueueConnectorInboundJob(event, "queue")
    findMatchingWorkflowsMock.mockReturnValue([])
    bus.routeHandler = jest.fn().mockResolvedValue(undefined)
    jest.mocked(listRecoverableConnectorInboundJobs).mockImplementationOnce(async () => {
      const stale = await jest
        .requireActual("@/lib/db/connector-inbound-jobs")
        .listRecoverableConnectorInboundJobs()
      await acceptConnectorAutomationFanOut(job.id, { completeJobOnSettle: true })
      return stale
    })
    await bus.resumeDurableInboundJobs()
    await bus.flushInboundTurns()
    expect(bus.routeHandler).not.toHaveBeenCalled()
    expect(await getDb().connectorInboundJobs.get(job.id)).toMatchObject({
      status: "completed",
      automationFanOut: { state: "settled", completeJobOnSettle: true },
    })
  })

  it("dispatches trigger events to every matching workflow", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf_a", nodeId: "n1", params: {} },
      { workflowId: "wf_b", nodeId: "n2", params: { adapterId } },
    ])

    const evt = privateEvent(adapterId, "msg_1")
    await getBus().dispatchInboundFull(evt)
    // Fan-out is chained onto a per-conversation FIFO and not awaited by the
    // pipeline, so the transport loop is never held by a slow workflow.
    await getBus().flushInboundTurns()

    expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.connector.inbound", {
      adapterId,
      conversationKey: evt.conversationKey,
      senderId: "u_alice",
      channelKind: "private",
      plainText: "hello",
      selfMentioned: false,
    })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
    const calls = dispatchTriggerMock.mock.calls.map(
      ([arg]) => arg as { workflowId: string; kind: string }
    )
    expect(calls.map((c) => c.workflowId).sort()).toEqual(["wf_a", "wf_b"])
    for (const c of calls) {
      expect(c.kind).toBe("trigger.connector.inbound")
    }
  })

  it("keys each inbound run on the platform message, not on the local adapter or the second", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf_a", nodeId: "n1", params: {} }])

    // Two messages in the same second are two occurrences.
    await getBus().dispatchInboundFull(privateEvent(adapterId, "msg_1"))
    await getBus().dispatchInboundFull(privateEvent(adapterId, "msg_2"))
    await getBus().flushInboundTurns()

    const keys = dispatchTriggerMock.mock.calls.map(
      ([arg]) => (arg as { occurrenceKey?: string }).occurrenceKey
    )
    // The adapter id is the local instance's; the key leaves it out, so a
    // second host on the same bot computes the same one.
    expect(keys).toEqual(["telegram:bot_1:private:msg_1", "telegram:bot_1:private:msg_2"])
    for (const key of keys) expect(key).not.toContain(adapterId)
  })

  it("fans gesture-class system events out to trigger.connector.system nodes", async () => {
    const adapterId = await seedAutoAdapter()
    const conversationKey = `telegram:${adapterId}:private`
    // The reacted-to message was delivered by us → targetDeliveredByUs=true.
    await recordDeliveredMessage(adapterId, conversationKey, "bot_out_1")
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf_react", nodeId: "n1", params: {} },
    ])

    const evt: NormalizedInboundEvent = {
      ...privateEvent(adapterId, "sys_reaction_1"),
      kind: "system",
      systemKind: "reaction_added",
      replacesMessageId: "bot_out_1",
      segments: [{ type: "emoji", code: "👍" }],
      plainText: "",
    }
    await getBus().dispatchInboundFull(evt)
    await getBus().flushInboundTurns()
    await waitFor(() => {
      expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.connector.system", {
        adapterId,
        conversationKey,
        connectorSystemKind: "reaction_added",
        targetDeliveredByUs: true,
      })
      expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    })
    const [arg] = dispatchTriggerMock.mock.calls[0] as [{ occurrenceKey?: string }]
    expect(arg).toEqual({
      kind: "trigger.connector.system",
      workflowId: "wf_react",
      triggerId: "n1",
      payload: evt,
      originAt: expect.any(Number),
      binding: { adapterId, conversationKey },
    })
    // A gesture's id is the adapter's construction and nothing deduplicates
    // it, so the run is not keyed: a second identical reaction is its own run.
    expect(arg.occurrenceKey).toBeUndefined()

    // …and the gesture is audited under its own kind (never adapter.error).
    const audits = await getDb().connectorAudit.where("adapterId").equals(adapterId).toArray()
    const reaction = audits.find((a) => a.kind === "inbound.reaction_added")
    expect(reaction).toBeDefined()
    expect(reaction!.fields).toEqual(
      expect.objectContaining({
        systemKind: "reaction_added",
        actorOpenId: "u_alice",
        targetMessageId: "bot_out_1",
        targetDeliveredByUs: true,
        emoji: "👍",
      })
    )
    expect(audits.some((a) => a.kind === "adapter.error")).toBe(false)
  })

  it("passes targetDeliveredByUs=false for a reaction on someone else's message", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([])
    const evt: NormalizedInboundEvent = {
      ...privateEvent(adapterId, "sys_reaction_2"),
      kind: "system",
      systemKind: "reaction_removed",
      replacesMessageId: "human_msg_9",
      segments: [],
      plainText: "",
    }
    await getBus().dispatchInboundFull(evt)
    await waitFor(() =>
      expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.connector.system", {
        adapterId,
        conversationKey: evt.conversationKey,
        connectorSystemKind: "reaction_removed",
        targetDeliveredByUs: false,
      })
    )
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("omits targetDeliveredByUs for lifecycle / request gestures (no target message)", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([])
    for (const systemKind of ["lifecycle", "request", "poke"] as const) {
      const evt: NormalizedInboundEvent = {
        ...privateEvent(adapterId, `sys_${systemKind}`),
        kind: "system",
        systemKind,
        segments: [],
        plainText: "",
      }
      await getBus().dispatchInboundFull(evt)
    }
    await waitFor(() => {
      for (const systemKind of ["lifecycle", "request", "poke"] as const) {
        expect(findMatchingWorkflowsMock).toHaveBeenCalledWith("trigger.connector.system", {
          adapterId,
          conversationKey: `telegram:${adapterId}:private`,
          connectorSystemKind: systemKind,
        })
      }
    })
    const audits = await getDb().connectorAudit.where("adapterId").equals(adapterId).toArray()
    expect(audits.map((a) => a.kind).sort()).toEqual(
      expect.arrayContaining(["inbound.lifecycle", "inbound.poke", "inbound.request"])
    )
  })

  it("skips dispatch when the event is dropped (group without self-mention)", async () => {
    const adapterId = await seedAutoAdapter()
    const base = privateEvent(adapterId, "msg_group_1")
    const evt: NormalizedInboundEvent = {
      ...base,
      channel: { id: "ch_group", kind: "group" },
      mentions: { selfMentioned: false, users: [] },
    }
    await getBus().dispatchInboundFull(evt)
    expect(findMatchingWorkflowsMock).not.toHaveBeenCalled()
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("audits + warns when findMatchingWorkflows throws (fan-out not silently disabled)", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockImplementation(() => {
      throw new Error("subscription index corrupted")
    })
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(
        getBus().dispatchInboundFull(privateEvent(adapterId, "msg_wf_match_err"))
      ).resolves.toBeUndefined()
      await getBus().flushInboundTurns()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    const row = audit.find(
      (r) => r.kind === "adapter.error" && r.reason === "workflow_match_failed"
    )
    expect(row).toBeDefined()
    expect(row?.message).toContain("subscription index corrupted")
  })

  it("audits a workflow failure, dispatches its siblings and drains the next inbound turn", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([
      { workflowId: "wf_oops", nodeId: "n", params: {} },
      { workflowId: "wf_ok", nodeId: "n_ok", params: {} },
    ])
    dispatchTriggerMock
      .mockRejectedValueOnce(new Error("orchestrator down"))
      .mockResolvedValue(undefined)

    await expect(
      getBus().dispatchInboundFull(privateEvent(adapterId, "msg_2"))
    ).resolves.toBeUndefined()
    await getBus().dispatchInboundFull(privateEvent(adapterId, "msg_3"))
    await getBus().flushInboundTurns()
    expect(
      dispatchTriggerMock.mock.calls.map(([arg]) => [arg.workflowId, arg.payload.messageId])
    ).toEqual([
      ["wf_oops", "msg_2"],
      ["wf_ok", "msg_2"],
      ["wf_oops", "msg_3"],
      ["wf_ok", "msg_3"],
    ])
    const audits = await getDb().connectorAudit.where("adapterId").equals(adapterId).toArray()
    expect(audits.filter((row) => row.reason === "workflow_dispatch_failed")).toEqual([
      expect.objectContaining({
        kind: "adapter.error",
        message: "orchestrator down",
        fields: { workflowId: "wf_oops", nodeId: "n" },
      }),
    ])
  })

  // The point of B3: a slow inbound-subscribed workflow must not hold the
  // adapter's transport for-await loop, because the HITL approval click that
  // would unblock it arrives as another envelope on that same loop.
  it("returns from the pipeline before a slow workflow finishes", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf_slow", nodeId: "n", params: {} }])
    let releaseWorkflow: (() => void) | undefined
    let signalStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    dispatchTriggerMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWorkflow = resolve
          signalStarted?.()
        })
    )

    await getBus().dispatchInboundFull(privateEvent(adapterId, "msg_slow"))
    // Pipeline already resolved while the workflow is still suspended.
    await started
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    releaseWorkflow?.()
    await getBus().flushInboundTurns()
  })

  // Per-conversation ordering still holds: a workflow accumulating conversation
  // state must see message N before N+1.
  it("keeps fan-out ordered within a conversation", async () => {
    const adapterId = await seedAutoAdapter()
    findMatchingWorkflowsMock.mockReturnValue([{ workflowId: "wf_seq", nodeId: "n", params: {} }])
    const seen: string[] = []
    const gates: Array<() => void> = []
    let signalSecondStarted: (() => void) | undefined
    const secondStarted = new Promise<void>((resolve) => {
      signalSecondStarted = resolve
    })
    dispatchTriggerMock.mockImplementation((arg: unknown) => {
      const payload = (arg as { payload: { messageId: string } }).payload
      return new Promise<void>((resolve) => {
        gates.push(() => {
          seen.push(payload.messageId)
          resolve()
        })
        if (gates.length === 2) signalSecondStarted?.()
      })
    })

    await getBus().dispatchInboundFull(privateEvent(adapterId, "msg_first"))
    await getBus().dispatchInboundFull(privateEvent(adapterId, "msg_second"))
    // Only the first is in flight — the second is still queued behind it.
    expect(gates).toHaveLength(1)
    gates[0]()
    await secondStarted
    gates[1]()
    await getBus().flushInboundTurns()
    expect(seen).toEqual(["msg_first", "msg_second"])
  })
})
