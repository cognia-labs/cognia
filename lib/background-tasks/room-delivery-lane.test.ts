/** @jest-environment node */
import type { ChatSession } from "@cognia/agent-config-types"
import type { RoomSendOptions } from "@/lib/chat/room/runner"
import { createRoomDeliveryLane } from "./room-delivery-lane"

function lane(send: (text: string, opts: RoomSendOptions) => Promise<void>) {
  const runner = { isIdle: jest.fn(() => true), send: jest.fn(send) }
  const rooms: Record<string, Partial<ChatSession>> = {
    "room-1": { id: "room-1", kind: "team", teamId: "team-1" },
    "shared-1": { id: "shared-1", kind: "team", teamId: "team-1", collaboration: {} as never },
    "chat-1": { id: "chat-1", kind: "chat" } as never,
  }
  return {
    runner,
    lane: createRoomDeliveryLane({
      runner: () => runner,
      getSession: async (id) => rooms[id] as ChatSession | undefined,
      consumerId: () => "room:db",
    }),
  }
}

describe("createRoomDeliveryLane", () => {
  it("reaches only rooms this host runs, and is idle as the runner says", async () => {
    const { lane: subject, runner } = lane(async () => undefined)
    await expect(subject.isReachable("room-1")).resolves.toBe(true)
    await expect(subject.isReachable("shared-1")).resolves.toBe(false)
    await expect(subject.isReachable("chat-1")).resolves.toBe(false)
    await expect(subject.isReachable("gone")).resolves.toBe(false)
    runner.isIdle.mockReturnValue(false)
    expect(subject.isIdle("room-1")).toBe(false)
    expect(subject.consumerId()).toBe("room:db")
  })

  it("sends an automated turn under the delivery id to the members owed it, accepted once the room takes it", async () => {
    let finish: () => void = () => undefined
    const { lane: subject, runner } = lane(
      (_text, opts) =>
        new Promise<void>((resolve) => {
          opts.onAccepted?.()
          finish = resolve
        })
    )
    // Resolves on acceptance, while the turn is still running.
    await expect(
      subject.send("[background task update] done", "room-1", "delivery-1", [], {
        memberIds: ["ava"],
      })
    ).resolves.toBe(true)
    expect(runner.send).toHaveBeenCalledWith(
      "[background task update] done",
      expect.objectContaining({
        sessionId: "room-1",
        automatedTurn: { producer: "background-result", messageId: "delivery-1" },
        targetMemberIds: ["ava"],
      })
    )
    finish()
  })

  it("is refused when the room turns the turn away, never takes it, or fails", async () => {
    const refused = lane(async (_text, opts) => opts.onRefused?.("teamSessionMissing"))
    await expect(refused.lane.send("x", "room-1", "d")).resolves.toBe(false)
    expect(refused.runner.send.mock.calls[0]![1]).not.toHaveProperty("targetMemberIds")
    await expect(lane(async () => undefined).lane.send("x", "room-1", "d")).resolves.toBe(false)
    const busy = lane(async () => {
      throw Object.assign(new Error("ROOM_BUSY"), { code: "ROOM_BUSY" })
    })
    await expect(busy.lane.send("x", "room-1", "d")).resolves.toBe(false)
  })
})
