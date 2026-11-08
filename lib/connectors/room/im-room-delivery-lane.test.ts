/** @jest-environment node */
import type { ChatSession } from "@cognia/agent-config-types"
import { createImRoomDeliveryLane, installImRoomDelivery } from "./im-room-delivery-lane"

const group = {
  id: "s_room",
  platformBinding: {
    platform: "lark",
    adapterId: "a1",
    conversationKey: "lark:a1:oc_1",
    conversationRef: { platform: "lark", adapterId: "a1" },
    scopeKind: "group",
  },
} as unknown as ChatSession
const dm = {
  ...group,
  id: "s_dm",
  platformBinding: { ...group.platformBinding!, scopeKind: "private" },
} as ChatSession

function fakeBus() {
  let idleListener: ((key: string) => void) | undefined
  return {
    getAdapter: jest.fn((id: string) => (id === "a1" ? ({} as never) : undefined)),
    isConversationTurnIdle: jest.fn(() => true),
    enqueueAutomatedRoomTurn: jest.fn(async () => true),
    onConversationTurnsIdle: jest.fn((listener: (key: string) => void) => {
      idleListener = listener
      return () => {
        idleListener = undefined
      }
    }),
    idle: (key: string) => idleListener?.(key),
  }
}

const sessions = new Map([group, dm].map((session) => [session.id, session]))
const getSession = async (id: string) => sessions.get(id)

describe("the IM room delivery lane", () => {
  it("reaches a group whose adapter runs here, and waits while its turns run", async () => {
    const bus = fakeBus()
    const lane = createImRoomDeliveryLane({ bus: () => bus, getSession, consumerId: () => "c" })
    await expect(lane.isReachable("s_room")).resolves.toBe(true)
    await expect(lane.isReachable("s_dm")).resolves.toBe(false)
    await expect(lane.isReachable("s_gone")).resolves.toBe(false)
    bus.getAdapter.mockReturnValueOnce(undefined)
    await expect(lane.isReachable("s_room")).resolves.toBe(false)
    await expect(lane.isIdle("s_room")).resolves.toBe(true)
    bus.isConversationTurnIdle.mockReturnValueOnce(false)
    await expect(lane.isIdle("s_room")).resolves.toBe(false)
    expect(bus.isConversationTurnIdle).toHaveBeenCalledWith("lark:a1:oc_1")
    expect(lane.consumerId()).toBe("c")
  })

  it("sends the framed result as the group's turn, to the members it is owed to", async () => {
    const bus = fakeBus()
    const lane = createImRoomDeliveryLane({ bus: () => bus, getSession, consumerId: () => "c" })
    await expect(
      lane.send("<results>", "s_room", "d-1", [], { memberIds: ["c_ana"] })
    ).resolves.toBe(true)
    expect(bus.enqueueAutomatedRoomTurn).toHaveBeenCalledWith({
      binding: group.platformBinding,
      text: "<results>",
      deliveryId: "d-1",
      producer: "background-result",
      targetMemberIds: ["c_ana"],
    })
    await expect(lane.send("x", "s_dm", "d-2", [])).resolves.toBe(false)
    bus.enqueueAutomatedRoomTurn.mockRejectedValueOnce(new Error("db"))
    await expect(lane.send("x", "s_room", "d-3", [])).resolves.toBe(false)
  })
})

describe("installImRoomDelivery", () => {
  it("registers the lane, drains at the bus's turn boundary, delivers what was owed, and tears down", async () => {
    const bus = fakeBus()
    const unregister = jest.fn()
    const delivery = {
      registerImRoomDeliveryLane: jest.fn(() => unregister),
      maybeDrainBackgroundResults: jest.fn(),
      attemptBackgroundResultDelivery: jest.fn(async (_sessionId: string) => undefined),
    }
    const stop = installImRoomDelivery({
      bus,
      getSession,
      sessionsOf: async (key) => (key === "lark:a1:oc_1" ? ["s_room"] : []),
      owedSessions: async () => ["s_room", "s_other"],
      consumerId: () => "c",
      delivery,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delivery.registerImRoomDeliveryLane).toHaveBeenCalledTimes(1)
    expect(delivery.attemptBackgroundResultDelivery.mock.calls.map((args) => args[0])).toEqual([
      "s_room",
      "s_other",
    ])
    bus.idle("lark:a1:oc_1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delivery.maybeDrainBackgroundResults).toHaveBeenCalledWith("s_room", {
      turnSettled: true,
    })
    stop()
    expect(unregister).toHaveBeenCalled()
    bus.idle("lark:a1:oc_1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delivery.maybeDrainBackgroundResults).toHaveBeenCalledTimes(1)
  })

  it("leaves no lane and no listener behind when torn down at once", async () => {
    const bus = fakeBus()
    const unregister = jest.fn()
    const delivery = {
      registerImRoomDeliveryLane: jest.fn(() => unregister),
      maybeDrainBackgroundResults: jest.fn(),
      attemptBackgroundResultDelivery: jest.fn(async (_sessionId: string) => undefined),
    }
    const stop = installImRoomDelivery({
      bus,
      owedSessions: async () => ["s_room"],
      delivery,
    })
    stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delivery.registerImRoomDeliveryLane.mock.calls.length).toBe(unregister.mock.calls.length)
    expect(delivery.attemptBackgroundResultDelivery).not.toHaveBeenCalled()
    bus.idle("lark:a1:oc_1")
    expect(delivery.maybeDrainBackgroundResults).not.toHaveBeenCalled()
  })
})
