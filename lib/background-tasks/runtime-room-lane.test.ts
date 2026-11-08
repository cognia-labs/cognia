/** @jest-environment node */
const registerRoomDeliveryLane = jest.fn((_lane: unknown) => unregister)
const unregister = jest.fn()
const maybeDrainBackgroundResults = jest.fn()
const attemptBackgroundResultDelivery = jest.fn(async (_sessionId: string) => undefined)
const listeners: Array<(roomId: string) => void> = []
const unsubscribe = jest.fn()
const runner = {
  isIdle: () => true,
  send: async () => undefined,
  onTurnSettled: (listener: (roomId: string) => void) => {
    listeners.push(listener)
    return unsubscribe
  },
}
const listBackgroundTaskRecords = jest.fn(async (_filter: unknown): Promise<unknown[]> => [])

jest.mock("./result-delivery", () => ({
  registerRoomDeliveryLane: (lane: unknown) => registerRoomDeliveryLane(lane),
  maybeDrainBackgroundResults: (...args: unknown[]) => maybeDrainBackgroundResults(...args),
  attemptBackgroundResultDelivery: (id: string) => attemptBackgroundResultDelivery(id),
}))
jest.mock("@/lib/chat/room/runner-host", () => ({ getHostRoomRunner: () => runner }))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: "account-db" }) }))
jest.mock("@/lib/db/background-tasks", () => ({
  listBackgroundTaskRecords: (filter: unknown) => listBackgroundTaskRecords(filter),
}))

import { start } from "./runtime-room-lane"

beforeEach(() => {
  jest.clearAllMocks()
  listeners.length = 0
})

describe("the room result-delivery runtime", () => {
  it("registers the room lane, drains at each room turn's end, and stops cleanly", async () => {
    const stop = await start()
    const lane = registerRoomDeliveryLane.mock.calls[0]![0] as { consumerId: () => string }
    expect(lane.consumerId()).toBe("room:account-db")
    listeners[0]!("room-1")
    expect(maybeDrainBackgroundResults).toHaveBeenCalledWith("room-1", { turnSettled: true })
    stop()
    expect(unsubscribe).toHaveBeenCalled()
    expect(unregister).toHaveBeenCalled()
  })

  it("delivers what a previous run left owed to rooms, once per room", async () => {
    listBackgroundTaskRecords.mockResolvedValueOnce([
      { kind: "squad-handoff", deliveryState: "pending", sessionId: "room-1" },
      { kind: "squad-handoff", deliveryState: "pending", sessionId: "room-1" },
      { kind: "squad-handoff", deliveryState: "delivered", sessionId: "room-2" },
      { kind: "subagent", deliveryState: "pending", sessionId: "chat-1" },
    ])
    await start()
    expect(listBackgroundTaskRecords).toHaveBeenCalledWith({ host: "renderer" })
    expect(attemptBackgroundResultDelivery.mock.calls).toEqual([["room-1"]])
  })
})
