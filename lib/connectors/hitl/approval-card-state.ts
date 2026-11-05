import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { waitForOutboundTerminal } from "@/lib/db/outbound-jobs"
import { appendAudit } from "@/lib/connectors/audit"
import { connectorVendor } from "@/lib/connectors/vendor-contribution"
import type { ConversationReference } from "@/types/connectors/event"

export type ApprovalCardState =
  "approved" | "denied" | "expired" | "processed" | "failed" | "answered" | "skipped" | "cancelled"

/**
 * Edit through the durable, governed queue so transient platform errors retry.
 * Only a platform whose vendor draws a closed card settles one; elsewhere the
 * card stays as sent and the decision still stands.
 */
export async function settleApprovalCard(input: {
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  surfaceId: string
  state: ApprovalCardState
  messageId?: string
  jobId?: string
  /** Optional echo rendered above the closed notice (e.g. the given answer). */
  detail?: string
}): Promise<void> {
  const closedSegment = connectorVendor(input.conversationRef.platform)?.closedApprovalSegment
  if (!closedSegment) return
  try {
    const delivery =
      !input.messageId && input.jobId ? await waitForOutboundTerminal(input.jobId, 5000) : undefined
    const messageId = input.messageId ?? delivery?.platformMessageId
    if (!messageId) return
    await enqueueGoverned({
      adapterId: delivery?.adapterId ?? input.adapterId,
      conversationKey: delivery?.conversationKey ?? input.conversationKey,
      request: {
        conversationRef: delivery?.request.conversationRef ?? input.conversationRef,
        ...(delivery?.request.deliveryTarget
          ? { deliveryTarget: delivery.request.deliveryTarget }
          : {}),
        editTargetMessageId: messageId,
        segments: [await closedSegment(input.state, input.detail)],
        metadata: { idempotencyKey: `approval-state:${input.surfaceId}:${input.state}` },
      },
      source: "ai-run",
      authorization: { kind: "system-notice", inboundConversationKey: input.conversationKey },
    })
  } catch {
    // Presentation failure must never reverse an already applied decision.
    await appendAudit({
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      kind: "adapter.error",
      at: Date.now(),
      reason: "approval_card_update_failed",
    }).catch(() => undefined)
  }
}
