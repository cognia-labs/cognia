/**
 * @jest-environment jsdom
 *
 * Coverage for the trigger.desktop.event fan-out: backend subscription
 * lifecycle, kind matching, the PII gate on element names, both loop guards
 * (cooldown + in-flight), and the Bots' own subscription through
 * `bot-dispatch`.
 */

let workflowRows: unknown[] = []
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ workflows: { toArray: async () => workflowRows } }),
}))

const dispatchTriggerMock = jest.fn()
jest.mock("./trigger-bridge", () => ({
  dispatchTrigger: (...args: unknown[]) => dispatchTriggerMock(...args),
}))

const hasNoLeakingPiiMock = jest.fn<boolean, [string]>(() => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (text: string) => hasNoLeakingPiiMock(text),
}))

const automationSubscribeMock = jest.fn(async (_filter: unknown) => 41)
const automationUnsubscribeMock = jest.fn(async (_id: number) => undefined)
const automationListenMock = jest.fn(async (_handler: unknown) => jest.fn())
jest.mock("@/lib/automation/client", () => ({
  desktop: {
    subscribeEvents: (filter: unknown) => automationSubscribeMock(filter),
    unsubscribeEvents: (id: number) => automationUnsubscribeMock(id),
  },
  listenUiaEvents: (handler: unknown) => automationListenMock(handler),
}))

import {
  initDesktopEventTrigger,
  disposeDesktopEventTrigger,
  _injectUiaEventForTest,
  botEventKinds,
} from "./desktop-event-trigger"
import { __resetPortsForTesting, __setPortForTesting } from "@/lib/modules/ports"
import type { BotDispatchPort } from "@/types/modules/ports/bot-dispatch"
import {
  _seedTriggerSubscriptionsForTest,
  disposeTriggerSubscriptions,
} from "./trigger-subscriptions"
import type { WorkflowRow } from "@/types/workflow/visual"

function wf(id: string, params: Record<string, unknown>): WorkflowRow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: `${id}-n1`,
        type: "trigger.desktop.event",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { params },
      },
    ] as WorkflowRow["nodes"],
    edges: [],
    settings: {} as WorkflowRow["settings"],
  }
}

function makeDeps() {
  const subscribe = jest.fn(async () => 7)
  const unsubscribe = jest.fn(async () => undefined)
  const listen = jest.fn(async (_handler: (p: never) => void) => jest.fn())
  let nowValue = 100_000
  return {
    subscribe,
    unsubscribe,
    listen,
    now: () => nowValue,
    advance: (ms: number) => {
      nowValue += ms
    },
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

// No Bots unless a test installs them: the runner then subscribes for the
// workflows alone, as on a deployment without the bot module.
beforeEach(() => {
  __setPortForTesting("bot-dispatch", null)
})

afterEach(() => {
  __resetPortsForTesting()
  disposeDesktopEventTrigger()
  disposeTriggerSubscriptions()
  workflowRows = []
  dispatchTriggerMock.mockReset().mockResolvedValue(undefined)
  hasNoLeakingPiiMock.mockReset().mockReturnValue(true)
  automationSubscribeMock.mockClear()
  automationUnsubscribeMock.mockClear()
  automationListenMock.mockClear()
})

describe("initDesktopEventTrigger", () => {
  it("subscribes the backend once while a node exists and releases on dispose", async () => {
    workflowRows = [wf("wf1", {})]
    const deps = makeDeps()
    initDesktopEventTrigger(deps)
    await flush()
    expect(deps.subscribe).toHaveBeenCalledTimes(1)
    expect(deps.subscribe).toHaveBeenCalledWith({
      kinds: ["focus-changed", "property-changed", "structure-changed"],
    })
    expect(deps.listen).toHaveBeenCalledTimes(1)

    disposeDesktopEventTrigger()
    await flush()
    expect(deps.unsubscribe).toHaveBeenCalledWith(7)
  })

  it("does not subscribe when no workflow carries the node", async () => {
    workflowRows = []
    const deps = makeDeps()
    initDesktopEventTrigger(deps)
    await flush()
    expect(deps.subscribe).not.toHaveBeenCalled()
  })

  it("uses the automation client defaults when no dependencies are injected", async () => {
    workflowRows = [wf("wf1", { kinds: ["property-changed"] })]
    initDesktopEventTrigger()
    await flush()
    await flush()

    expect(automationSubscribeMock).toHaveBeenCalledWith({ kinds: ["property-changed"] })
    expect(automationListenMock).toHaveBeenCalledTimes(1)

    disposeDesktopEventTrigger()
    await flush()
    expect(automationUnsubscribeMock).toHaveBeenCalledWith(41)
  })
})

describe("desktop-event fan-out", () => {
  function seedAndInit(params: Record<string, unknown>, deps = makeDeps()) {
    const row = wf("wf1", params)
    workflowRows = [row]
    _seedTriggerSubscriptionsForTest([row])
    initDesktopEventTrigger(deps)
    return deps
  }

  it("dispatches matching workflows with the PII-gated payload", async () => {
    seedAndInit({})
    await _injectUiaEventForTest({ kind: "focus-changed", name: "Untitled - Notepad", at: 5 })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    expect(dispatchTriggerMock.mock.calls[0][0]).toMatchObject({
      workflowId: "wf1",
      kind: "trigger.desktop.event",
      payload: { kind: "focus-changed", name: "Untitled - Notepad", at: 5 },
    })
  })

  it("omits the element name when it fails the PII gate", async () => {
    seedAndInit({})
    hasNoLeakingPiiMock.mockReturnValue(false)
    await _injectUiaEventForTest({ kind: "focus-changed", name: "alice@example.com", at: 5 })
    const payload = (dispatchTriggerMock.mock.calls[0][0] as { payload: Record<string, unknown> })
      .payload
    expect(payload.name).toBeUndefined()
    expect(payload.kind).toBe("focus-changed")
  })

  it("respects the node's kinds filter", async () => {
    seedAndInit({ kinds: ["structure-changed"] })
    await _injectUiaEventForTest({ kind: "focus-changed", at: 5 })
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("routes distinct kind/scope subscriptions back to only their owning trigger nodes", async () => {
    // `["scope-a"]` is how a scope was persisted while `elementRef()` wrapped
    // it in a tuple. Such a node still resolves, and the backend is sent the
    // bare string the Rust `ElementRef(String)` newtype actually deserializes.
    const focus = wf("wf_focus", { kinds: ["focus-changed"], scope: ["scope-a"] })
    const structure = wf("wf_structure", {
      kinds: ["structure-changed"],
      scope: "scope-b",
      cooldownMs: 0,
    })
    workflowRows = [focus, structure]
    _seedTriggerSubscriptionsForTest([focus, structure])
    const deps = makeDeps()
    let nextSubscriptionId = 10
    deps.subscribe.mockImplementation(async () => nextSubscriptionId++)
    initDesktopEventTrigger(deps)
    await flush()
    await flush()

    expect(deps.subscribe).toHaveBeenCalledTimes(2)
    expect(deps.subscribe).toHaveBeenNthCalledWith(1, {
      kinds: ["focus-changed"],
      scope: "scope-a",
    })
    expect(deps.subscribe).toHaveBeenNthCalledWith(2, {
      kinds: ["structure-changed"],
      scope: "scope-b",
    })

    await _injectUiaEventForTest({
      subscriptionId: 11,
      kind: "structure-changed",
      name: "Dialog",
      controlType: "Window",
      processId: 42,
      structureChangeType: "ChildAdded",
      runtimeId: [1, 2, 3],
      at: 5,
    })

    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    expect(dispatchTriggerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf_structure",
        triggerId: "wf_structure-n1",
        payload: expect.objectContaining({
          kind: "structure-changed",
          controlType: "Window",
          processId: 42,
          structureChangeType: "ChildAdded",
          runtimeId: [1, 2, 3],
        }),
      })
    )
  })

  it("applies the per-workflow cooldown loop guard", async () => {
    const deps = seedAndInit({ cooldownMs: 2000 })
    await _injectUiaEventForTest({ kind: "focus-changed", at: 1 })
    await _injectUiaEventForTest({ kind: "focus-changed", at: 2 })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)

    deps.advance(2001)
    await _injectUiaEventForTest({ kind: "focus-changed", at: 3 })
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
  })

  it("skips a workflow while its trigger-started run is still in flight", async () => {
    const deps = seedAndInit({ cooldownMs: 0 })
    const pendingRuns: Array<() => void> = []
    dispatchTriggerMock.mockImplementation(
      () => new Promise<void>((resolve) => pendingRuns.push(resolve))
    )
    const first = _injectUiaEventForTest({ kind: "focus-changed", at: 1 })
    await flush()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)

    deps.advance(10)
    const second = _injectUiaEventForTest({ kind: "focus-changed", at: 2 })
    await flush()
    // In-flight guard: still exactly one dispatch while the first run hangs.
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)

    pendingRuns.forEach((resolve) => resolve())
    await Promise.all([first, second])

    deps.advance(10)
    const third = _injectUiaEventForTest({ kind: "focus-changed", at: 3 })
    await flush()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(2)
    pendingRuns.forEach((resolve) => resolve())
    await third
  })
})

describe("Bot desktop events", () => {
  let botListener: ((types: ReadonlySet<string>) => void) | undefined
  const stopBotWatch = jest.fn()
  const desktopEvent = jest.fn<Promise<void>, Parameters<BotDispatchPort["desktopEvent"]>>(
    async () => undefined
  )

  beforeEach(() => {
    botListener = undefined
    stopBotWatch.mockClear()
    desktopEvent.mockClear()
    __setPortForTesting("bot-dispatch", {
      connectorInbound: async () => ({}),
      desktopEvent,
      workflowCompleted: async () => undefined,
      cancelConversationDeliveries: async () => 0,
      watchDesktopEventTypes: (listener) => {
        botListener = listener
        return stopBotWatch
      },
    })
  })

  async function botsWant(types: string[]) {
    botListener?.(new Set(types))
    await flush()
    await flush()
  }

  it("maps Bot types onto UI automation kinds and ignores the pet's", () => {
    expect(
      botEventKinds(new Set(["desktop.focus-changed", "desktop.pet.levelUp", "desktop.bogus"]))
    ).toEqual(["focus-changed"])
  })

  it("subscribes for the Bots with no workflow and hands them its events", async () => {
    const deps = makeDeps()
    initDesktopEventTrigger(deps)
    await flush()
    expect(deps.subscribe).not.toHaveBeenCalled()

    await botsWant(["desktop.focus-changed", "desktop.pet.levelUp"])
    expect(deps.subscribe).toHaveBeenCalledTimes(1)
    expect(deps.subscribe).toHaveBeenCalledWith({ kinds: ["focus-changed"] })
    expect(deps.listen).toHaveBeenCalledTimes(1)

    await _injectUiaEventForTest({ subscriptionId: 7, kind: "focus-changed", name: "Inbox", at: 1 })
    await flush()
    expect(desktopEvent).toHaveBeenCalledTimes(1)
    expect(desktopEvent).toHaveBeenCalledWith({
      type: "desktop.focus-changed",
      sourceRecordId: "uia:focus-changed:100000",
      payload: { kind: "focus-changed", name: "Inbox" },
      occurredAt: 100_000,
    })
    expect(dispatchTriggerMock).not.toHaveBeenCalled()
  })

  it("hands the Bots the redacted name only", async () => {
    initDesktopEventTrigger(makeDeps())
    await flush()
    await botsWant(["desktop.focus-changed"])
    hasNoLeakingPiiMock.mockReturnValue(false)

    await _injectUiaEventForTest({
      subscriptionId: 7,
      kind: "focus-changed",
      name: "alice@example.com",
      at: 1,
    })
    await flush()
    expect(desktopEvent.mock.calls[0][0].payload).toEqual({ kind: "focus-changed" })
  })

  it("shares a workflow group with the same filter and hands each event to both once", async () => {
    const row = wf("wf1", {})
    workflowRows = [row]
    _seedTriggerSubscriptionsForTest([row])
    const deps = makeDeps()
    initDesktopEventTrigger(deps)
    await flush()
    await botsWant([
      "desktop.focus-changed",
      "desktop.property-changed",
      "desktop.structure-changed",
    ])

    expect(deps.subscribe).toHaveBeenCalledTimes(1)
    await _injectUiaEventForTest({ subscriptionId: 7, kind: "focus-changed", at: 1 })
    await flush()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    expect(desktopEvent).toHaveBeenCalledTimes(1)
  })

  it("keeps a workflow's scoped events from the Bots", async () => {
    const row = wf("wf1", { kinds: ["focus-changed"], scope: "scope-a" })
    workflowRows = [row]
    _seedTriggerSubscriptionsForTest([row])
    const deps = makeDeps()
    let nextSubscriptionId = 10
    deps.subscribe.mockImplementation(async () => nextSubscriptionId++)
    initDesktopEventTrigger(deps)
    await flush()
    await botsWant(["desktop.focus-changed"])

    expect(deps.subscribe).toHaveBeenCalledTimes(2)
    expect(deps.subscribe).toHaveBeenNthCalledWith(2, { kinds: ["focus-changed"] })
    await _injectUiaEventForTest({ subscriptionId: 10, kind: "focus-changed", at: 1 })
    await flush()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    expect(desktopEvent).not.toHaveBeenCalled()

    await _injectUiaEventForTest({ subscriptionId: 11, kind: "focus-changed", at: 2 })
    await flush()
    expect(dispatchTriggerMock).toHaveBeenCalledTimes(1)
    expect(desktopEvent).toHaveBeenCalledTimes(1)
  })

  it("releases the Bots' subscription when they stop listening and stops watching on dispose", async () => {
    const deps = makeDeps()
    initDesktopEventTrigger(deps)
    await flush()
    await botsWant(["desktop.focus-changed"])
    expect(deps.subscribe).toHaveBeenCalledTimes(1)

    await botsWant([])
    expect(deps.unsubscribe).toHaveBeenCalledWith(7)

    disposeDesktopEventTrigger()
    expect(stopBotWatch).toHaveBeenCalledTimes(1)
  })
})
