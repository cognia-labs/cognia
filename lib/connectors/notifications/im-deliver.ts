/**
 * IM proactive-push delivery (control-plane notifications), the IM channel's
 * answer to the `conversation-channel` port's `deliverNotification`.
 *
 * The Notification Center fans a record to its `"im"` channel, and the kernel
 * (`lib/notifications/im-deliver.ts`) resolves which conversation the record
 * belongs in. This posts it there:
 *
 *   1. the conversation's bound ChatSession gives the `platformBinding`
 *      (adapterId + opaque conversationRef + delivery target);
 *   2. the per-conversation opt-in (`ConversationOverrideRow.proactivePush`)
 *      is enforced, fail-closed default OFF: customer-facing IM must not get
 *      surprise pushes;
 *   3. everything the message would carry is PII-gated (the same fail-closed
 *      gate auto-mode replies use), dropping the IM push, never the durable
 *      center record, on a hit;
 *   4. it is enqueued through the durable queue, idempotency-keyed on the
 *      record id so a coalesce bump never double-sends: an A2UI card when the
 *      record carries actions, plain text when it does not.
 *
 * ## Why the card path exists
 *
 * A record can carry one to three inline actions, and this channel used to
 * drop them, so "Plan awaiting approval / Approve / Discard" arrived in a
 * group chat as one sentence with no way to answer it. The buttons carry a
 * `notification_action` binding, which `ConnectorBus.dispatchConnectorCallback`
 * short-circuits into `./action-callback.ts` without a model turn, exactly as
 * it does for `issue_action`.
 *
 * Static-export safe: only Dexie writes + the outbound EventTarget wake bus,
 * zero Tauri IPC, identical to the inbound path.
 */

import type { NotificationRecord } from "@/types/notifications"
import type { ConversationNotificationOutcome } from "@/types/modules/ports/conversation-channel"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { buildNotificationCardSurface } from "@/lib/notifications/im-card"
import { hasNoLeakingPii } from "@cognia/redact"
import { buildA2UISegment } from "../a2ui-bridge/a2ui-to-segments"
import { appendAudit } from "../audit"
import { enqueueAuthorized } from "../delivery-gateway"
import { findSessionByConversationKey } from "../session-bindings"

export interface NotificationDeliveryDeps {
  findSession?: typeof findSessionByConversationKey
  readOverride?: typeof readForResolution
  enqueue?: typeof enqueueAuthorized
  audit?: typeof appendAudit
  /** PII gate (defaults to `hasNoLeakingPii`). Returns true when SAFE to send. */
  isPiiSafe?: (text: string) => boolean
}

function bodyText(rec: NotificationRecord): string {
  return [rec.title, rec.body ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
}

/**
 * Everything the outbound message will actually contain.
 *
 * The gate used to see the title and body, which was the whole message while
 * this channel sent plain text. A card also renders each action's label and
 * the deep link, and an action can be registered by a PLUGIN
 * (`lib/notifications/plugin-bridge.ts`), so its label is not necessarily
 * product-authored text. Gating less than the card renders would let the
 * buttons carry out what the body was blocked for.
 */
function gatedText(rec: NotificationRecord): string {
  return [bodyText(rec), ...(rec.actions ?? []).map((a) => a.label), rec.href ?? ""]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
}

/**
 * Post one center record to `conversationKey`. Returns the structured
 * outcome; never throws: every skip / block path audits and returns, so a
 * failed IM push can't break the notification persist or the other channels.
 */
export async function deliverNotificationToConversation(
  input: { record: NotificationRecord; conversationKey: string },
  deps: NotificationDeliveryDeps = {}
): Promise<ConversationNotificationOutcome> {
  const { record: rec, conversationKey } = input
  const findSession = deps.findSession ?? findSessionByConversationKey
  const readOverride = deps.readOverride ?? readForResolution
  const enqueue = deps.enqueue ?? enqueueAuthorized
  const audit = deps.audit ?? appendAudit
  const isPiiSafe = deps.isPiiSafe ?? hasNoLeakingPii

  try {
    const session = await findSession(conversationKey)
    const binding = session?.platformBinding
    if (!binding) {
      // No bound session → we can't reliably target the platform; skip
      // silently (no adapterId to audit against).
      return { status: "skipped", reason: "no-session", conversationKey }
    }
    if (!binding.deliveryTarget) {
      await audit({
        adapterId: binding.adapterId,
        kind: "notify.im_skipped",
        at: Date.now(),
        conversationKey,
        reason: "delivery_target_missing",
        fields: { notificationId: rec.id },
      })
      return { status: "skipped", reason: "delivery-target-missing", conversationKey }
    }

    const override = await readOverride(conversationKey).catch(() => undefined)
    if (override?.proactivePush !== true) {
      await audit({
        adapterId: binding.adapterId,
        kind: "notify.im_skipped",
        at: Date.now(),
        conversationKey,
        reason: "opt_in_off",
        fields: { notificationId: rec.id },
      })
      return { status: "skipped", reason: "opt-in-off", conversationKey }
    }

    const text = bodyText(rec)
    if (!isPiiSafe(gatedText(rec))) {
      await audit({
        adapterId: binding.adapterId,
        kind: "notify.im_pii_blocked",
        at: Date.now(),
        conversationKey,
        reason: "pii_blocked",
        fields: { notificationId: rec.id },
      })
      return { status: "skipped", reason: "pii-blocked", conversationKey }
    }

    // A record with actions is a question, and a question needs its answers
    // attached. One without is a statement, and the plain-text path renders
    // it better on every platform, so the card is not forced on it.
    const segment =
      (rec.actions?.length ?? 0) > 0
        ? buildA2UISegment(`notification:${rec.id}`, buildNotificationCardSurface({ record: rec }))
        : { type: "text" as const, text: text || rec.title }

    const delivered = await enqueue({
      adapterId: binding.adapterId,
      conversationKey,
      request: {
        conversationRef: binding.conversationRef,
        deliveryTarget: binding.deliveryTarget,
        segments: [segment],
        // Idempotency keyed on the record id → a coalesce bump re-delivering
        // the same record is deduped by the outbound runner.
        metadata: { idempotencyKey: `notify:${rec.id}` },
      },
      source: "ai-run",
      // The conversation is the one the record's session is bound to, so it is
      // that session's origin thread; a fence on it still holds (ADR-0239).
      authorization: {
        kind: "unattended",
        ownerRef: `notification:${rec.id}`,
        ...(session?.id ? { sessionId: session.id } : {}),
      },
    })
    if (delivered.kind === "drafted") {
      return { status: "skipped", reason: "held-as-draft", conversationKey }
    }
    await audit({
      adapterId: binding.adapterId,
      kind: "notify.im_pushed",
      at: Date.now(),
      conversationKey,
      fields: { notificationId: rec.id, level: rec.level },
    })
    return { status: "pushed", conversationKey }
  } catch {
    // Fail-closed: a delivery error must never propagate into notify()'s
    // persist / other channels.
    return { status: "error" }
  }
}
