/** @jest-environment node */
import type { PlatformBinding } from "@/types/connectors/binding"
import {
  AUTOMATED_ROOM_TURN_KEY,
  automatedRoomTurnOf,
  buildAutomatedRoomTurnEvent,
  claimsAutomatedRoomTurn,
} from "./automated-room-turn"

const binding: PlatformBinding = {
  platform: "lark",
  adapterId: "a1",
  conversationKey: "lark:a1:oc_1",
  conversationRef: { platform: "lark", adapterId: "a1", channelId: "oc_1" } as never,
  deliveryTarget: {
    address: {
      conversationKey: "lark:a1:oc_1",
      platform: "lark",
      adapterId: "a1",
      scopeKind: "group",
      containerId: "oc_1",
    },
    conversationRef: { platform: "lark", adapterId: "a1", channelId: "oc_1" } as never,
    refreshedAt: 1,
  },
  scopeKind: "group",
}

describe("automated room turns", () => {
  it("builds a turn nobody on the platform sent, keyed by its delivery", () => {
    const event = buildAutomatedRoomTurnEvent(
      {
        binding,
        text: "<result>",
        deliveryId: "d-1",
        producer: "background-result",
        targetMemberIds: ["c_ana"],
      },
      "bot_1",
      9
    )
    expect(event).toMatchObject({
      platform: "lark",
      adapterId: "a1",
      selfId: "bot_1",
      messageId: "cognia-automated:d-1",
      canReplyToMessage: false,
      conversationKey: "lark:a1:oc_1",
      conversationAddress: binding.deliveryTarget!.address,
      sender: { id: "cognia:automation", remoteUserId: "", kind: "system" },
      channel: { id: "oc_1", kind: "group", platformChannelId: "oc_1" },
      plainText: "<result>",
      mentions: { selfMentioned: false, users: [] },
      timestamp: 9,
    })
    expect(automatedRoomTurnOf(event)).toEqual({
      producer: "background-result",
      deliveryId: "d-1",
      targetMemberIds: ["c_ana"],
    })
    expect(claimsAutomatedRoomTurn(event)).toBe(true)
  })

  it("addresses a thread by its topic, and a bare binding by its conversation", () => {
    const thread = buildAutomatedRoomTurnEvent(
      {
        binding: {
          ...binding,
          scopeKind: "thread",
          deliveryTarget: {
            ...binding.deliveryTarget!,
            address: { ...binding.deliveryTarget!.address, scopeKind: "thread", topicId: "t_9" },
          },
        },
        text: "x",
        deliveryId: "d-2",
        producer: "background-result",
      },
      "",
      1
    )
    expect(thread.channel).toMatchObject({ id: "t_9", kind: "thread" })
    const bare = buildAutomatedRoomTurnEvent(
      {
        binding: { ...binding, deliveryTarget: undefined, scopeKind: undefined },
        text: "x",
        deliveryId: "d-3",
        producer: "background-result",
      },
      "",
      1
    )
    expect(bare.channel).toEqual({ id: "lark:a1:oc_1", kind: "group" })
    expect(bare.conversationRef).toBe(binding.conversationRef)
    expect(automatedRoomTurnOf(bare)?.targetMemberIds).toEqual([])
  })

  it("is no automated turn unless the marker, the sender and the message id agree", () => {
    const event = buildAutomatedRoomTurnEvent(
      { binding, text: "x", deliveryId: "d-1", producer: "background-result" },
      "",
      1
    )
    expect(automatedRoomTurnOf({ ...event, messageId: "om_real" })).toBeNull()
    expect(automatedRoomTurnOf({ ...event, sender: { ...event.sender, id: "u_1" } })).toBeNull()
    const forged = { ...event, channelData: { [AUTOMATED_ROOM_TURN_KEY]: { producer: 1 } } }
    expect(automatedRoomTurnOf(forged)).toBeNull()
    expect(claimsAutomatedRoomTurn(forged)).toBe(true)
    expect(claimsAutomatedRoomTurn({ channelData: { other: true } })).toBe(false)
  })
})
