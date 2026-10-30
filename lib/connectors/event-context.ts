/** Capture verified system-event delivery context before workflows observe it. */
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import { deliveryTargetFromEvent, isConnectorSystemEventKind } from "@/types/connectors/event"
import type { AuditKind } from "@/types/connectors/audit"
import { appendAudit } from "./audit"
import { getDb } from "@/lib/db/schema"
import {
  getConnectorConversationState,
  refreshConnectorConversationDeliveryTarget,
} from "@/lib/db/connector-conversation-state"
import { isInboundRecorded, recordInbound } from "@/lib/db/inbound-ledger"
import { recordOutboundDeliveryStatus } from "@/lib/db/outbound-jobs"

/** One projection for atomic interaction capture and ordinary system audit. */
export function systemEventAuditFields(
  event: NormalizedInboundEvent,
  targetDeliveredByUs?: boolean
): Record<string, unknown> {
  const targetMessageId = event.replacesMessageId ?? event.replyTo?.messageId
  const emoji = event.segments.find((segment) => segment.type === "emoji")
  const raw = event.raw as { header?: { event_type?: unknown }; t?: unknown } | undefined
  const rawType = raw?.header?.event_type ?? raw?.t
  return {
    systemKind: event.systemKind,
    actorOpenId: event.sender.remoteUserId,
    ...(event.referral ? { referral: event.referral } : {}),
    ...(event.interaction ? { interaction: event.interaction } : {}),
    ...(event.deliveryStatus ? { deliveryStatus: event.deliveryStatus } : {}),
    ...(targetMessageId ? { targetMessageId } : {}),
    ...(targetDeliveredByUs !== undefined ? { targetDeliveredByUs } : {}),
    ...(emoji?.type === "emoji" ? { emoji: emoji.code } : {}),
    ...(typeof rawType === "string" ? { rawType } : {}),
  }
}
export function capturedSystemAuditKind(event: NormalizedInboundEvent): AuditKind | undefined {
  return event.originEventId && event.interaction && isConnectorSystemEventKind(event.systemKind)
    ? `inbound.${event.systemKind}`
    : undefined
}

export async function captureSystemDeliveryContext(
  event: NormalizedInboundEvent,
  options?: { onDeliveryConfirmed?: (conversationKey: string) => void }
): Promise<boolean> {
  // Reconciliation is durable/idempotent independently of best-effort observers.
  // Apply before occurrence dedup so a prior downstream failure cannot lose evidence.
  const confirmed = event.deliveryStatus
    ? await recordOutboundDeliveryStatus({
        adapterId: event.adapterId,
        conversationKey: event.conversationKey,
        timestamp: event.timestamp,
        update: event.deliveryStatus,
      })
    : undefined
  if (confirmed?.status === "sent") {
    try {
      options?.onDeliveryConfirmed?.(confirmed.conversationKey)
    } catch {
      /* observational callback */
    }
  }
  if (!event.originEventId) return true
  if (!Number.isFinite(event.timestamp) || event.timestamp > Date.now() + 60_000) return false
  const db = getDb(),
    dedup = `system:${event.originEventId}`
  return db.transaction(
    "rw",
    db.connectorConversationStates,
    db.inboundLedger,
    db.connectorAudit,
    async () => {
      if (await isInboundRecorded(event.adapterId, dedup, "inbound", event.conversationKey))
        return false
      const kind = capturedSystemAuditKind(event)
      if (kind) {
        const target = event.replacesMessageId ?? event.replyTo?.messageId
        const reaction =
          event.systemKind === "reaction_added" || event.systemKind === "reaction_removed"
        const delivered =
          reaction && target
            ? await isInboundRecorded(event.adapterId, target, "outbound", event.conversationKey)
            : undefined
        await appendAudit({
          adapterId: event.adapterId,
          conversationKey: event.conversationKey,
          kind,
          at: Date.now(),
          fields: systemEventAuditFields(event, delivered),
        })
      }
      const current = await getConnectorConversationState(event.conversationKey)
      if (
        (event.passiveEvent || event.deliveryPermissionChange) &&
        (!current?.deliveryTarget || current.deliveryTarget.refreshedAt <= event.timestamp)
      )
        await refreshConnectorConversationDeliveryTarget(deliveryTargetFromEvent(event))
      if (
        event.deliveryPermissionChange &&
        (!current?.deliveryPermissions || current.deliveryPermissions.updatedAt <= event.timestamp)
      )
        await db.connectorConversationStates.update(event.conversationKey, {
          deliveryPermissions: {
            proactive: event.deliveryPermissionChange.proactive,
            updatedAt: event.timestamp,
          },
        })
      await recordInbound(event.adapterId, dedup, "inbound", event.conversationKey)
      return true
    }
  )
}
