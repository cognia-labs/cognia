/** QQ interaction envelopes are actions, never synthetic incoming chat messages. */
import type {
  ConnectorCallbackDecision,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import { buildConversationKey } from "@/types/connectors/event"
import { resolveCallbackBinding } from "../_shared/a2ui-mapper"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import type { QQKeyboardReceipt } from "./a2ui-mapper"

export interface QQInteraction {
  id: string
  scene: "group" | "c2c"
  sceneId: string
  actorId: string
  buttonData: string
  buttonId?: string
  messageId?: string
  timestamp: number
}

function id(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0020\u007f]/.test(value)
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function qqInteractionAckId(dispatch: unknown): string | undefined {
  const envelope = record(dispatch)
  if (envelope?.t !== "INTERACTION_CREATE") return undefined
  const d = record(envelope.d)
  const type = d?.type ?? record(d?.data)?.type
  return (type === 11 || type === 12) && id(d?.id) && !d.id.startsWith("INTERACTION_CREATE:")
    ? d.id
    : undefined
}

export function parseQQInteraction(dispatch: unknown): QQInteraction | null {
  const interactionId = qqInteractionAckId(dispatch)
  const d = record(record(dispatch)?.d)
  const data = record(d?.data)
  if (
    !d ||
    !interactionId ||
    (d.type ?? data?.type) !== 11 ||
    (d.type !== undefined && data?.type !== undefined && d.type !== data.type)
  )
    return null
  const scene = d.scene ?? (d.chat_type === 1 ? "group" : d.chat_type === 2 ? "c2c" : undefined)
  if (scene !== "group" && scene !== "c2c") return null
  if (d.chat_type !== undefined && d.chat_type !== (scene === "group" ? 1 : 2)) return null
  const sceneId = scene === "group" ? d.group_openid : d.user_openid
  const actorId = scene === "group" ? d.group_member_openid : d.user_openid
  const resolved = record(data?.resolved)
  const timestamp = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN
  if (
    !id(sceneId) ||
    !id(actorId) ||
    !resolved ||
    !id(resolved.button_data, 4096) ||
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60_000
  )
    return null
  if (resolved.button_id !== undefined && !id(resolved.button_id, 64)) return null
  if (resolved.message_id !== undefined && !id(resolved.message_id, 1024)) return null
  return {
    id: interactionId,
    scene,
    sceneId,
    actorId,
    buttonData: resolved.button_data,
    buttonId: resolved.button_id as string | undefined,
    messageId: resolved.message_id as string | undefined,
    timestamp,
  }
}

/** Receipt presence is mandatory, even when the shared callback guard runs in audit mode. */

export async function resolveQQInteraction(
  adapterId: string,
  selfId: string,
  interaction: QQInteraction
): Promise<ConnectorCallbackEvent | null> {
  if (Date.now() - interaction.timestamp > 5 * 60_000) return null
  const receiptBinding = await resolveCallbackBinding(adapterId, interaction.buttonData)
  const receipt = receiptBinding?.payload?.qqKeyboard as QQKeyboardReceipt | undefined
  const conversationKey = buildConversationKey("qq-official", adapterId, interaction.sceneId)
  if (
    !receiptBinding ||
    !receipt ||
    !id(receipt.messageId, 1024) ||
    !id(receipt.bindingActionId, 4096) ||
    typeof receipt.action !== "string" ||
    receiptBinding.conversationKey !== conversationKey ||
    receipt.scene !== interaction.scene ||
    receipt.sceneId !== interaction.sceneId ||
    (interaction.buttonId !== undefined && interaction.buttonId !== receipt.buttonId) ||
    (interaction.messageId !== undefined && interaction.messageId !== receipt.messageId)
  )
    return null
  const binding =
    receipt.bindingActionId === receiptBinding.actionId
      ? receiptBinding
      : await resolveCallbackBinding(adapterId, receipt.bindingActionId)
  if (
    !binding ||
    binding.conversationKey !== conversationKey ||
    binding.surfaceId !== receiptBinding.surfaceId ||
    binding.consumedAt !== undefined
  )
    return null
  if (binding.allowedActions?.length && !binding.allowedActions.includes(receipt.action))
    return null
  const scope = binding.actorScope
  if (scope?.mode === "initiator" || scope?.mode === "operators") {
    const adapter = await getAdapterInstance(adapterId)
    const operators = adapter?.settings.runOperatorUserIds
    if (
      !scope.allowedUserIds?.includes(interaction.actorId) &&
      !(Array.isArray(operators) && operators.includes(interaction.actorId))
    )
      return null
  }
  const conversationRef = {
    platform: "qq-official" as const,
    adapterId,
    scene: interaction.scene,
    sceneId: interaction.sceneId,
    eventId: interaction.id,
    receivedAt: interaction.timestamp,
  }
  return {
    platform: "qq-official",
    adapterId,
    selfId,
    triggerId: interaction.id,
    bindingActionId: binding.actionId,
    surfaceId: binding.surfaceId,
    componentId: binding.componentId,
    actionType: "button",
    value: receipt.action,
    conversationKey,
    originatingMessageId: interaction.messageId,
    user: {
      id: `qq:${interaction.sceneId}:${interaction.actorId}`,
      platform: "qq-official",
      adapterId,
      remoteUserId: interaction.actorId,
      remoteIdType: `${interaction.scene}_openid`,
    },
    timestamp: interaction.timestamp,
    deliveryTarget: {
      address: {
        conversationKey,
        platform: "qq-official",
        adapterId,
        scopeKind: interaction.scene === "group" ? "group" : "private",
        containerId: interaction.sceneId,
      },
      conversationRef,
      refreshedAt: interaction.timestamp,
    },
    // Audit only the reviewed fields; callback payloads cannot inject model/run commands.
    raw: { t: "INTERACTION_CREATE", d: { id: interaction.id, scene: interaction.scene, type: 11 } },
  }
}

export function qqInteractionResultCode(decision: ConnectorCallbackDecision): number {
  switch (decision.status) {
    case "accepted":
      return 0
    case "deduped":
      return 3
    case "in_flight":
      return 2
    case "denied":
      return 4
    default:
      return 1
  }
}
