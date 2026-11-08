/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

const dispatchConnectorInboundToBots = jest.fn()
const dispatchDesktopEventToBots = jest.fn(async (_input: unknown) => ({
  enqueued: [],
  rejected: [],
  unresolved: [],
}))
const dispatchWorkflowCompletedToBots = jest.fn(async (_input: unknown) => ({
  enqueued: [],
  rejected: [],
  unresolved: [],
}))
const cancelAcceptedBotDeliveries = jest.fn(async () => 1)

jest.mock("../sources/connector-inbound", () => ({
  dispatchConnectorInboundToBots: (input: unknown) => dispatchConnectorInboundToBots(input),
}))
jest.mock("../sources/desktop-event", () => ({
  dispatchDesktopEventToBots: (input: unknown) => dispatchDesktopEventToBots(input),
}))
jest.mock("../sources/workflow-completed", () => ({
  dispatchWorkflowCompletedToBots: (input: unknown) => dispatchWorkflowCompletedToBots(input),
}))
jest.mock("../runtime/run", () => ({
  cancelAcceptedBotDeliveries: (...args: unknown[]) => cancelAcceptedBotDeliveries(...(args as [])),
}))

import { port } from "./bot-dispatch"

beforeEach(() => {
  __resetDbForTesting()
  jest.clearAllMocks()
})

describe("bot-dispatch", () => {
  it("routes an inbound message and reports only a deferred transfer", async () => {
    const event = { adapterId: "a", messageId: "m" } as never
    dispatchConnectorInboundToBots.mockResolvedValueOnce({
      enqueued: [],
      rejected: [],
      unresolved: [],
    })
    await expect(port.connectorInbound({ event, acceptedAt: 5 })).resolves.toEqual({})
    expect(dispatchConnectorInboundToBots).toHaveBeenCalledWith({ event, acceptedAt: 5 })
    dispatchConnectorInboundToBots.mockResolvedValueOnce({
      deferred: true,
      enqueued: [],
      rejected: [],
      unresolved: [],
    })
    await expect(port.connectorInbound({ event })).resolves.toEqual({ deferred: true })
  })

  it("routes desktop events and finished runs to their sources", async () => {
    const desktop = { type: "desktop.uia", sourceRecordId: "uia:1", payload: { kind: "focus" } }
    await port.desktopEvent(desktop)
    expect(dispatchDesktopEventToBots).toHaveBeenCalledWith(desktop)
    const run = { workflowId: "w", workflowName: "W", runId: "r", status: "succeeded" as const }
    await port.workflowCompleted(run)
    expect(dispatchWorkflowCompletedToBots).toHaveBeenCalledWith(run)
  })

  it("cancels a conversation's own accepted deliveries up to the cutoff", async () => {
    const db = getDb()
    const delivery = (id: string, extra: Record<string, unknown>) =>
      ({
        id,
        installationId: `inst-${id}`,
        receivedAt: 10,
        envelope: { binding: { adapterId: "a", conversationKey: "one" } },
        ...extra,
      }) as never
    await db.botEventDeliveries.bulkPut([
      delivery("match", {}),
      delivery("late", { receivedAt: 30 }),
      delivery("mirror", { syncedFromHost: true }),
      delivery("other", { envelope: { binding: { adapterId: "a", conversationKey: "two" } } }),
      delivery("envelope-time", {
        receivedAt: 50,
        envelope: { receivedAt: 15, binding: { adapterId: "a", conversationKey: "one" } },
      }),
    ])
    await expect(
      port.cancelConversationDeliveries({ adapterId: "a", conversationKey: "one", cutoff: 20 })
    ).resolves.toBe(2)
    expect(
      cancelAcceptedBotDeliveries.mock.calls.map((call) => (call as unknown[])[1]).sort()
    ).toEqual(["envelope-time", "match"])
  })

  it("cancels nothing, without loading the runtime, when no delivery matches", async () => {
    await expect(
      port.cancelConversationDeliveries({ adapterId: "a", conversationKey: "none", cutoff: 20 })
    ).resolves.toBe(0)
    expect(cancelAcceptedBotDeliveries).not.toHaveBeenCalled()
  })
})
