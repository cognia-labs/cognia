/** @jest-environment jsdom */

/**
 * Tests for the `trigger.pet.event` runner. The trigger bridge is mocked at
 * the module boundary and the subscription cache is seeded directly, so the
 * runner's matching / cooldown / projection logic is exercised in isolation
 * via `_injectPetEventForTest`.
 */

const dispatchTrigger = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (args: unknown) => dispatchTrigger(args),
}))

import {
  _injectPetEventForTest,
  disposePetEventTrigger,
  initPetEventTrigger,
} from "./workflow-trigger"
import { _seedTriggerSubscriptionsForTest } from "@/lib/workflow/runtime/trigger-subscriptions"
import { __resetPortsForTesting, __setPortForTesting } from "@/lib/modules/ports"
import type { PetEvent } from "@/types/pet"
import type { WorkflowRow } from "@/types/workflow/visual"

function workflowWithPetTrigger(id: string, params: Record<string, unknown> = {}): WorkflowRow {
  return {
    id,
    nodes: [{ id: `${id}-n1`, type: "trigger.pet.event", data: { params } }],
  } as unknown as WorkflowRow
}

function event(kind: PetEvent["kind"], meta?: Record<string, unknown>): PetEvent {
  return { source: "system", kind, meta, at: 1000 }
}

let clock = 0

const desktopEvent = jest.fn().mockResolvedValue(undefined)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  desktopEvent.mockClear()
  // No Bots unless a test installs them.
  __setPortForTesting("bot-dispatch", null)
  dispatchTrigger.mockClear()
  clock = 100_000
  initPetEventTrigger({ now: () => clock })
})

afterEach(() => {
  __resetPortsForTesting()
  disposePetEventTrigger()
  _seedTriggerSubscriptionsForTest([])
})

describe("pet-event-trigger", () => {
  it("fires matching workflows with a projected payload", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    await _injectPetEventForTest(
      event("achievementUnlocked", { achievementId: "well-fed", userText: "SECRET" })
    )
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    expect(dispatchTrigger).toHaveBeenCalledWith({
      workflowId: "wf1",
      kind: "trigger.pet.event",
      triggerId: "wf1-n1",
      payload: { kind: "achievementUnlocked", at: 1000, achievementId: "well-fed" },
      originAt: 100_000,
    })
    // PII projection: unknown meta keys never cross into the payload.
    const payload = dispatchTrigger.mock.calls[0][0].payload as Record<string, unknown>
    expect(payload.userText).toBeUndefined()
  })

  it("filters by the node's kinds param", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1", { kinds: ["unwell"] })])
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    expect(dispatchTrigger).not.toHaveBeenCalled()
    await _injectPetEventForTest(event("unwell"))
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  })

  it("ignores non-lifecycle kinds entirely", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    await _injectPetEventForTest(event("fed"))
    await _injectPetEventForTest(event("thinking"))
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("applies the per-workflow cooldown (default 2000ms)", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    clock += 1000
    await _injectPetEventForTest(event("levelUp", { level: 6 }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    clock += 1500 // 2500ms since the first fire
    await _injectPetEventForTest(event("levelUp", { level: 7 }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("honors a custom cooldownMs param", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1", { cooldownMs: 0 })])
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    await _injectPetEventForTest(event("levelUp", { level: 6 }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("isolates a failing dispatch per match", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1"), workflowWithPetTrigger("wf2")])
    dispatchTrigger.mockRejectedValueOnce(new Error("boom"))
    await _injectPetEventForTest(event("evolved", { stage: "juvenile" }))
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("does nothing after dispose", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    disposePetEventTrigger()
    await _injectPetEventForTest(event("levelUp", { level: 5 }))
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })
})

describe("pet events for Bots", () => {
  beforeEach(() => {
    __setPortForTesting("bot-dispatch", {
      connectorInbound: async () => ({}),
      desktopEvent,
      workflowCompleted: async () => undefined,
      cancelConversationDeliveries: async () => 0,
      watchDesktopEventTypes: () => () => undefined,
    })
  })

  it("hands every lifecycle event to the Bots, projected, with no workflow listening", async () => {
    await _injectPetEventForTest(event("levelUp", { level: 5, userText: "SECRET" }))
    await flush()
    expect(desktopEvent).toHaveBeenCalledTimes(1)
    expect(desktopEvent).toHaveBeenCalledWith({
      type: "desktop.pet.levelUp",
      sourceRecordId: "pet:levelUp:1000:5",
      payload: { kind: "levelUp", at: 1000, level: 5 },
      occurredAt: 1000,
    })
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("hands an event to the Bots and to a matching workflow alike", async () => {
    _seedTriggerSubscriptionsForTest([workflowWithPetTrigger("wf1")])
    await _injectPetEventForTest(event("evolved", { stage: "adult" }))
    await flush()
    expect(desktopEvent).toHaveBeenCalledTimes(1)
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
  })

  it("gives achievements unlocked in one handling their own Bot events", async () => {
    await _injectPetEventForTest(event("achievementUnlocked", { achievementId: "well-fed" }))
    await _injectPetEventForTest(event("achievementUnlocked", { achievementId: "first-chat" }))
    await flush()
    const ids = desktopEvent.mock.calls.map(
      ([input]) => (input as { sourceRecordId: string }).sourceRecordId
    )
    expect(ids).toEqual([
      "pet:achievementUnlocked:1000:well-fed",
      "pet:achievementUnlocked:1000:first-chat",
    ])
  })

  it("keeps non-lifecycle kinds from the Bots too", async () => {
    await _injectPetEventForTest(event("fed"))
    await flush()
    expect(desktopEvent).not.toHaveBeenCalled()
  })
})
