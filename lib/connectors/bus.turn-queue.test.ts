/** @jest-environment jsdom */
/**
 * Integration tests for the per-conversation route-handler turn queue.
 *
 * Before this queue existed, `dispatchInboundFull` awaited the ENTIRE model
 * turn, so the adapter's transport for-await loop was blocked for the whole
 * turn. The P0 consequence: when an ask-tier tool suspended the turn on a
 * HITL approval, the user's Allow click (another envelope on the SAME loop)
 * could never be processed until the approval TTL auto-denied — and one slow
 * turn head-of-line-blocked every other conversation on the adapter.
 *
 * Scenarios:
 *   (a) approval callback resolves a turn suspended on the approval registry
 *       (the P0 reproduction).
 *   (b) a slow turn in conversation A does not delay conversation B.
 *   (c) a throwing route handler is audited, dispatch resolves, and the next
 *       event still dispatches (transport-loop survivability).
 *   (d) same-conversation ordering is preserved.
 *   (e) queue overflow remains durable as history-only work with a diagnostic.
 */

import "fake-indexeddb/auto"
import { waitFor } from "@testing-library/react"
import { dispatchConnectorInboundToBots } from "@/lib/bot/sources/connector-inbound"
import {
  enqueueConnectorInboundJob,
  acceptConnectorAutomationFanOut,
  completeConnectorInboundJob,
  listPendingConnectorAutomationFanOuts,
} from "@/lib/db/connector-inbound-jobs"

jest.mock("@/lib/bot/sources/connector-inbound", () => ({
  dispatchConnectorInboundToBots: jest.fn().mockResolvedValue({}),
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import { listRecent } from "@/lib/db/connector-audit"
import { markConnectorInboundJobRecoveryRequired } from "@/lib/db/connector-inbound-jobs"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import { recordCallbackBinding } from "./adapters/_shared/a2ui-mapper"
import {
  awaitApproval,
  pendingApprovalCount,
  __resetApprovalRegistryForTesting,
} from "./hitl/approval-registry"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import type { TriggerPolicy } from "@/types/connectors/policy"

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

function privateEvent(
  adapterId: string,
  messageId: string,
  chatId = "chatA"
): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:${chatId}`,
    sender: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
    channel: { id: `ch_${chatId}`, kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

async function seedAdapter(): Promise<string> {
  const row = await createAdapterInstance({
    type: "telegram",
    displayName: "Queue Bot",
    enabled: true,
    transportMode: "stub",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: AUTO_TRIGGER,
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
  })
  getBus().registerAdapter(makeAdapter(row.id))
  return row.id
}

/** Deferred helper: an externally-resolvable promise. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(async () => {
  jest
    .mocked(dispatchConnectorInboundToBots)
    .mockReset()
    .mockResolvedValue({} as never)
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
  __resetApprovalRegistryForTesting()
}, 30_000)

describe("ConnectorBus turn queue — HITL approval mid-turn (P0)", () => {
  it("an approval callback is processed WHILE a turn is suspended, and the turn completes", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const conversationKey = `telegram:${adapterId}:chatA`

    // Route handler suspends the turn on the approval registry — exactly what
    // an ask-tier tool permission request does mid-turn.
    const decisions: string[] = []
    bus.routeHandler = async () => {
      const res = await awaitApproval("sess_q", "req_q", { ttlMs: 0 })
      decisions.push(res.decision)
    }

    await recordCallbackBinding({
      adapterId,
      actionId: "tapa:queue",
      surfaceId: "tool_approve:sfc",
      componentId: "allow",
      conversationKey,
      kind: "tool_approve",
      payload: { sessionId: "sess_q", requestId: "req_q", toolName: "Bash", decision: "allow" },
    })

    // The inbound dispatch must RESOLVE while the turn is still suspended —
    // this is the property that frees the transport loop.
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_hitl"))
    expect(pendingApprovalCount()).toBe(1)
    expect(decisions).toEqual([])

    // The Allow click arrives on the (now free) transport loop.
    const callback: ConnectorCallbackEvent = {
      platform: "telegram",
      adapterId,
      selfId: "bot_1",
      triggerId: "tapa:queue",
      surfaceId: "tool_approve:sfc",
      componentId: "allow",
      actionType: "button",
      value: "allow",
      conversationKey,
      user: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
      timestamp: Date.now(),
      raw: {},
    }
    await bus.dispatchConnectorCallback(callback)
    await bus.flushInboundTurns()

    expect(decisions).toEqual(["allow"])
    expect(pendingApprovalCount()).toBe(0)
    const audit = await listRecent(adapterId)
    expect(audit.some((r) => r.kind === "tool_approve.granted")).toBe(true)
  })
})

describe("ConnectorBus turn queue — parallelism and ordering", () => {
  it("operator resume does not reclassify an unrelated live turn as recovery-required", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const gate = deferred()
    bus.routeHandler = async () => gate.promise

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_still_running"))
    const before = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === "msg_still_running")
      .first()
    expect(before?.status).toBe("running")

    await expect(bus.resumeDurableInboundJobs()).resolves.toEqual({
      resumed: 0,
      recoveryRequired: 0,
    })
    expect((await getDb().connectorInboundJobs.get(before!.id))?.status).toBe("running")

    gate.resolve()
    await bus.flushInboundTurns()
  })

  it("preserves a recovery-required outcome returned by the route handler", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.routeHandler = async (_event, _decision, _resolved, _override, _adapter, context) => {
      await markConnectorInboundJobRecoveryRequired(
        context.inboundJobId,
        "recovery_execution_drift"
      )
    }

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_drift"))
    await bus.flushInboundTurns()

    expect(
      await getDb()
        .connectorInboundJobs.filter((row) => row.sourceMessageId === "msg_drift")
        .first()
    ).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "recovery_execution_drift",
      })
    )
  })

  it("a slow turn in conversation A does not delay conversation B", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const gateA = deferred()
    const completed: string[] = []
    const bDone = deferred()

    bus.routeHandler = async (event) => {
      if (event.conversationKey.endsWith(":chatA")) await gateA.promise
      completed.push(event.messageId)
      if (event.conversationKey.endsWith(":chatB")) bDone.resolve()
    }

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_a1", "chatA"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_b1", "chatB"))

    // B's turn completes while A is still blocked.
    await bDone.promise
    expect(completed).toEqual(["msg_b1"])

    gateA.resolve()
    await bus.flushInboundTurns()
    expect(completed).toEqual(["msg_b1", "msg_a1"])
  })

  it("preserves same-conversation ordering even when the first turn is slower", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const completed: string[] = []

    bus.routeHandler = async (event) => {
      // First message deliberately slower — FIFO must still hold.
      if (event.messageId === "msg_1") await new Promise((r) => setTimeout(r, 30))
      completed.push(event.messageId)
    }

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_1"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_2"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_3"))
    await bus.flushInboundTurns()

    expect(completed).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  it("marks a configured steer follow-up for safe-boundary replay", async () => {
    const adapterId = await seedAdapter()
    await updateAdapterInstance(adapterId, { activeRunDispatchMode: "steer" })
    const bus = getBus()
    const gate = deferred()
    const observed: Array<[string, unknown]> = []

    bus.routeHandler = async (event) => {
      observed.push([event.messageId, event.channelData?.dispatchIntent])
      if (event.messageId === "msg_active") await gate.promise
    }

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_active"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_steer"))
    expect(observed).toEqual([["msg_active", undefined]])

    gate.resolve()
    await bus.flushInboundTurns()
    expect(observed).toEqual([
      ["msg_active", undefined],
      ["msg_steer", "steer-replay"],
    ])
  })

  it("injects a steer into an active safe runtime without enqueueing a second turn", async () => {
    const adapterId = await seedAdapter()
    await updateAdapterInstance(adapterId, { activeRunDispatchMode: "steer" })
    const bus = getBus()
    const gate = deferred()
    const observed: string[] = []
    bus.routeHandler = async (event) => {
      observed.push(event.messageId)
      if (event.messageId === "msg_active") await gate.promise
    }
    bus.liveSteerHandler = jest.fn(async () => ({
      activeRun: true,
      accepted: true,
      executionRunId: "execution:active",
    }))

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_active"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_steer_live"))

    expect(bus.liveSteerHandler).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg_steer_live" })
    )
    expect(observed).toEqual(["msg_active"])
    const job = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === "msg_steer_live")
      .first()
    expect(job).toEqual(
      expect.objectContaining({ status: "completed", executionRunId: "execution:active" })
    )

    gate.resolve()
    await bus.flushInboundTurns()
  })
})

describe("ConnectorBus turn queue — error containment", () => {
  it("a throwing route handler is audited; dispatch resolves; the next event still dispatches", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const completed: string[] = []
    bus.routeHandler = async (event) => {
      if (event.messageId === "msg_boom") throw new Error("turn exploded")
      completed.push(event.messageId)
    }

    // The transport loop must survive: dispatch resolves normally.
    await expect(
      bus.dispatchInboundFull(privateEvent(adapterId, "msg_boom"))
    ).resolves.toBeUndefined()
    await bus.flushInboundTurns()

    const audit = await listRecent(adapterId)
    const errRow = audit.find(
      (r) => r.kind === "adapter.error" && r.reason === "route_handler_failed"
    )
    expect(errRow).toBeDefined()
    expect(errRow?.message).toContain("turn exploded")

    // Subsequent event on the same conversation still dispatches.
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_after"))
    await bus.flushInboundTurns()
    expect(completed).toEqual(["msg_after"])
  })

  it("an inbound-pipeline exception is contained (audited, never thrown to the transport)", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    // Force a pipeline failure upstream of the route handler by breaking the
    // Step 3 override lookup (a Dexie failure mid-pipeline).
    const event = privateEvent(adapterId, "msg_pipeline_boom")
    const spy = jest.spyOn(getDb().conversationOverrides, "where").mockImplementation(() => {
      throw new Error("dexie exploded")
    })
    try {
      await expect(bus.dispatchInboundFull(event)).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    const audit = await listRecent(adapterId)
    expect(
      audit.some((r) => r.kind === "adapter.error" && r.reason === "inbound_pipeline_failed")
    ).toBe(true)
    expect(
      await getDb()
        .connectorInboundJobs.toCollection()
        .filter((job) => job.sourceMessageId === event.messageId)
        .first()
    ).toEqual(expect.objectContaining({ status: "queued" }))
  })
})

describe("ConnectorBus turn queue — overflow backpressure", () => {
  it("keeps 100 turns and marks excess messages history-only with a diagnostic", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const gate = deferred()
    const handler = jest.fn(async () => {
      await gate.promise
    })
    bus.routeHandler = handler

    // 102 distinct messages on ONE conversation while the handler is wedged:
    // 100 queue (including the running one), 2 remain in durable history only.
    for (let i = 0; i < 102; i++) {
      await bus.dispatchInboundFull(privateEvent(adapterId, `msg_flood_${i}`))
    }

    const audit = await listRecent(adapterId)
    const overflow = audit.filter(
      (r) => r.kind === "adapter.error" && r.reason === "turn_queue_overflow"
    )
    expect(overflow).toHaveLength(2)

    gate.resolve()
    await bus.flushInboundTurns()
    expect(handler).toHaveBeenCalledTimes(100)

    const historyOnly = await getDb()
      .connectorInboundJobs.where("status")
      .equals("history_only")
      .toArray()
    expect(historyOnly).toHaveLength(2)
    expect(historyOnly.every((job) => job.recoveryReason === "pending_limit_exceeded")).toBe(true)

    // The queue map is cleaned up once drained (bounded map).
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_after_flood"))
    await bus.flushInboundTurns()
    expect(handler).toHaveBeenCalledTimes(101)
  })
})

it("queued automatic work honors a switch to silent before dispatch", async () => {
  const adapterId = await seedAdapter()
  const bus = getBus()
  const gate = deferred()
  const seen: Array<{ id: string; decision: string; authority?: string }> = []
  bus.routeHandler = async (event, decision, _resolved, override) => {
    seen.push({ id: event.messageId, decision, authority: override?.authority })
    if (event.messageId === "audit_first") await gate.promise
  }
  await bus.dispatchInboundFull(privateEvent(adapterId, "audit_first"))
  await bus.dispatchInboundFull(privateEvent(adapterId, "audit_queued"))
  await upsertByConversationKey({
    conversationKey: `telegram:${adapterId}:chatA`,
    sessionId: "audit_session",
    mode: "manual",
    autonomy: "observe",
    engagement: "human",
    authority: "plan",
  })
  await bus.dispatchInboundFull(privateEvent(adapterId, "audit_after_switch"))
  gate.resolve()
  await bus.flushInboundTurns()
  expect(seen[2]).toMatchObject({
    id: "audit_after_switch",
    decision: "manual-store",
    authority: "plan",
  })
  expect(seen[1]).toMatchObject({ id: "audit_queued", decision: "manual-store", authority: "plan" })
})

it("rechecks queued authority, mute and skill revocation at execution time", async () => {
  const adapterId = await seedAdapter()
  const bus = getBus()
  const gate = deferred()
  const seen: Array<unknown> = []
  bus.routeHandler = async (event, decision, _resolved, override, adapter) => {
    if (event.messageId === "first") await gate.promise
    else
      seen.push({
        decision,
        authority: override?.authority,
        muted: adapter.muted,
        skills: adapter.builtInSkillCeiling,
      })
  }
  await bus.dispatchInboundFull(privateEvent(adapterId, "first"))
  await bus.dispatchInboundFull(privateEvent(adapterId, "queued"))
  await updateAdapterInstance(adapterId, {
    defaultAuthority: "plan",
    muted: true,
    builtInSkillCeiling: [],
  })
  gate.resolve()
  await bus.flushInboundTurns()
  expect(seen).toEqual([{ decision: "ai-run", authority: "plan", muted: true, skills: [] }])
})

it("pins a queued source to its accepted session before a later /new", async () => {
  const adapterId = await seedAdapter()
  const key = `telegram:${adapterId}:chatA`
  await getDb().sessions.put({
    id: "old",
    title: "Old",
    kind: "direct",
    platformConversationKey: key,
    createdAt: 1,
    updatedAt: 1,
  } as never)
  const bus = getBus(),
    gate = deferred(),
    sessions: Array<string | undefined> = []
  bus.routeHandler = async (event, _decision, _resolved, override) => {
    if (event.messageId === "first") await gate.promise
    else sessions.push(override?.activeSessionId)
  }
  await bus.dispatchInboundFull(privateEvent(adapterId, "first"))
  await bus.dispatchInboundFull(privateEvent(adapterId, "queued"))
  await getDb().sessions.put({
    id: "new",
    title: "New",
    kind: "direct",
    platformConversationKey: key,
    createdAt: 2,
    updatedAt: 2,
  } as never)
  await upsertByConversationKey({ conversationKey: key, sessionId: "new", activeSessionId: "new" })
  gate.resolve()
  await bus.flushInboundTurns()
  expect(sessions).toEqual(["old"])
})

it("retains observer transfer when pause wins at the Bot handoff", async () => {
  const adapterId = await seedAdapter(),
    bus = getBus()
  const event = privateEvent(adapterId, "pause-transfer")
  const control = await upsertByConversationKey({
    conversationKey: event.conversationKey,
    sessionId: "s",
  })
  const paused = deferred()
  bus.routeHandler = jest.fn()
  jest.mocked(dispatchConnectorInboundToBots).mockImplementationOnce(async () => {
    await getDb().conversationOverrides.update(control.id, { automationPaused: true })
    paused.resolve()
    return { deferred: true } as never
  })
  await bus.dispatchInboundFull(event)
  await paused.promise
  expect(
    (await listPendingConnectorAutomationFanOuts()).map((job) => job.sourceMessageId)
  ).toContain(event.messageId)
  await getDb().conversationOverrides.update(control.id, { automationPaused: false })
  await bus.flushInboundTurns()
  expect(dispatchConnectorInboundToBots).toHaveBeenCalledTimes(2)
  expect(bus.routeHandler).toHaveBeenCalledTimes(1)
  expect(await listPendingConnectorAutomationFanOuts()).toEqual([])
})

it("recovers observers after responder completion without replaying the responder", async () => {
  const adapterId = await seedAdapter()
  const event = privateEvent(adapterId, "observer-restart")
  const job = await enqueueConnectorInboundJob(event, "queue")
  await acceptConnectorAutomationFanOut(job.id)
  await completeConnectorInboundJob(job.id)
  __resetBusForTesting()
  const bus = getBus()
  bus.registerAdapter(makeAdapter(adapterId))
  bus.routeHandler = jest.fn()
  await Promise.all([bus.resumeAutomationFanOuts(), bus.resumeAutomationFanOuts()])
  await bus.flushInboundTurns()
  expect(dispatchConnectorInboundToBots).toHaveBeenCalledTimes(1)
  expect(bus.routeHandler).not.toHaveBeenCalled()
  expect(await listPendingConnectorAutomationFanOuts()).toEqual([])
})

it("drains durable observer backlog beyond the in-memory queue limit", async () => {
  const adapterId = await seedAdapter(),
    bus = getBus(),
    gate = deferred()
  for (let index = 0; index < 102; index++) {
    const job = await enqueueConnectorInboundJob(
      privateEvent(adapterId, `backlog-${index}`),
      "queue"
    )
    await acceptConnectorAutomationFanOut(job.id)
    await completeConnectorInboundJob(job.id)
  }
  jest.mocked(dispatchConnectorInboundToBots).mockImplementationOnce(async () => {
    await gate.promise
    return {} as never
  })
  await bus.resumeAutomationFanOuts()
  gate.resolve()
  await waitFor(async () => expect(await listPendingConnectorAutomationFanOuts()).toEqual([]), {
    timeout: 20_000,
  })
  await bus.flushInboundTurns()
  expect(dispatchConnectorInboundToBots).toHaveBeenCalledTimes(102)
})

it("recovers a runnable observer behind an unavailable adapter prefix", async () => {
  const adapterId = await seedAdapter(),
    bus = getBus()
  const template = await enqueueConnectorInboundJob(privateEvent("missing", "unavailable"), "queue")
  await getDb().connectorInboundJobs.delete(template.id)
  await getDb().connectorInboundJobs.bulkPut(
    Array.from({ length: 101 }, (_, index) => ({
      ...template,
      id: `a-unavailable-${index}`,
      platformMessageId: `unavailable-${index}`,
      automationFanOut: { state: "pending" as const, acceptedAt: template.createdAt },
    }))
  )
  const ready = await enqueueConnectorInboundJob(privateEvent(adapterId, "ready"), "queue")
  await getDb().connectorInboundJobs.delete(ready.id)
  await getDb().connectorInboundJobs.put({
    ...ready,
    id: "z-ready",
    automationFanOut: { state: "pending", acceptedAt: ready.createdAt },
  })
  await bus.resumeAutomationFanOuts()
  await bus.flushInboundTurns()
  expect(dispatchConnectorInboundToBots).toHaveBeenCalledWith(
    expect.objectContaining({ event: expect.objectContaining({ messageId: "ready" }) })
  )
  expect((await getDb().connectorInboundJobs.get("z-ready"))?.automationFanOut?.state).toBe(
    "settled"
  )
})
