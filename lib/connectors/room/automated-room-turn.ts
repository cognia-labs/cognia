/**
 * A turn this host starts in an IM room itself (ADR-0249, ADR-0177 batch 5).
 *
 * When a Squad that a room member handed work to finishes, its result is owed
 * to that member, in the group the work came from. Nobody in the group typed
 * it, so it is not a platform message: it is an automated turn, the IM
 * room's counterpart of the room runner's `automatedTurn` send. The bus runs
 * it on the conversation's own turn queue (`ConnectorBus.enqueueAutomatedRoomTurn`),
 * after whatever the group said before it, and the runtime answers it as a
 * room turn addressed to the members it is owed to.
 *
 * The event is built here, never by an adapter: the bus refuses one that
 * arrives from a transport, and only runs one whose durable job it wrote.
 */

import type { AutomatedTurnProducer } from "@cognia/agent-config-types/automated-turn"
import type { PlatformBinding } from "@/types/connectors/binding"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/** The `channelData` key that carries the turn's marker. */
export const AUTOMATED_ROOM_TURN_KEY = "cogniaAutomatedTurn"

/** The sender an automated turn names: nobody on the platform. */
export const AUTOMATED_ROOM_TURN_SENDER_ID = "cognia:automation"

/** The message id prefix: an automated turn's id is its delivery's, never a platform message's. */
export const AUTOMATED_ROOM_TURN_MESSAGE_PREFIX = "cognia-automated:"

export interface AutomatedRoomTurnMarker {
  producer: AutomatedTurnProducer
  /** The delivery the turn answers: one turn per delivery, however often it is sent. */
  deliveryId: string
  /** The members the turn is owed to; empty lets the room route it. */
  targetMemberIds: string[]
}

export interface AutomatedRoomTurnInput {
  binding: PlatformBinding
  text: string
  deliveryId: string
  producer: AutomatedTurnProducer
  targetMemberIds?: readonly string[]
}

/**
 * The turn as an inbound event the route handler can run. `selfId` is the
 * bot's own id as the conversation's last inbound event named it.
 */
export function buildAutomatedRoomTurnEvent(
  input: AutomatedRoomTurnInput,
  selfId: string,
  now: number
): NormalizedInboundEvent {
  const { binding } = input
  const address = binding.deliveryTarget?.address
  const scopeKind = binding.scopeKind ?? address?.scopeKind ?? "group"
  const channelId =
    scopeKind === "thread" && address?.topicId
      ? address.topicId
      : (address?.containerId ?? binding.conversationKey)
  const marker: AutomatedRoomTurnMarker = {
    producer: input.producer,
    deliveryId: input.deliveryId,
    targetMemberIds: [...(input.targetMemberIds ?? [])],
  }
  return {
    platform: binding.platform,
    adapterId: binding.adapterId,
    selfId,
    messageId: AUTOMATED_ROOM_TURN_MESSAGE_PREFIX + input.deliveryId,
    // Not a platform message: nothing to quote, nothing to react to.
    canReplyToMessage: false,
    // A binding always holds a reference; a row written before it did still
    // names its platform and adapter, which is what delivery resolves from.
    conversationRef: binding.deliveryTarget?.conversationRef ??
      binding.conversationRef ?? { platform: binding.platform, adapterId: binding.adapterId },
    conversationKey: binding.conversationKey,
    ...(address ? { conversationAddress: address } : {}),
    sender: {
      id: AUTOMATED_ROOM_TURN_SENDER_ID,
      platform: binding.platform,
      adapterId: binding.adapterId,
      remoteUserId: "",
      kind: "system",
    },
    channel: {
      id: channelId,
      kind: scopeKind,
      ...(address?.containerId ? { platformChannelId: address.containerId } : {}),
    },
    segments: [{ type: "text", text: input.text }],
    plainText: input.text,
    mentions: { selfMentioned: false, users: [] },
    timestamp: now,
    raw: null,
    channelData: { [AUTOMATED_ROOM_TURN_KEY]: marker },
  }
}

/**
 * The turn's marker, when `event` is an automated room turn this host built:
 * the marker, the sender and the message id must all agree. `null` for every
 * platform message.
 */
export function automatedRoomTurnOf(
  event: Pick<NormalizedInboundEvent, "channelData" | "sender" | "messageId">
): AutomatedRoomTurnMarker | null {
  const marker = event.channelData?.[AUTOMATED_ROOM_TURN_KEY]
  if (!marker || typeof marker !== "object") return null
  const { producer, deliveryId, targetMemberIds } = marker as Partial<AutomatedRoomTurnMarker>
  if (
    typeof producer !== "string" ||
    typeof deliveryId !== "string" ||
    !deliveryId ||
    !Array.isArray(targetMemberIds) ||
    event.sender.id !== AUTOMATED_ROOM_TURN_SENDER_ID ||
    event.messageId !== AUTOMATED_ROOM_TURN_MESSAGE_PREFIX + deliveryId
  ) {
    return null
  }
  return {
    producer: producer as AutomatedTurnProducer,
    deliveryId,
    targetMemberIds: targetMemberIds.filter((id): id is string => typeof id === "string"),
  }
}

/** Whether an event carries the marker at all, well-formed or not. */
export function claimsAutomatedRoomTurn(
  event: Pick<NormalizedInboundEvent, "channelData">
): boolean {
  return event.channelData?.[AUTOMATED_ROOM_TURN_KEY] !== undefined
}
