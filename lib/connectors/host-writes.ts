/**
 * The paired-device write commands the connectors answer on the host
 * (ADR-0250 §14 `hostWriteCommands`): the Inbox relay's reply, draft approval
 * and rejection (ADR-0131), a relayed bot policy, a whole adapter instance or
 * a change to one (ADR-0224 migration), and a per-conversation override. The
 * host's write dispatcher (`lib/companion/desktop-write-source.ts`) routes
 * each here before its own arms; payload checks and error messages are part
 * of the wire contract with paired clients and stay as they were.
 */

import type { ModuleHostWriteCommandsModule } from "@/lib/modules/manifest-types"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import {
  upsertByConversationKey,
  type ConversationOverrideInput,
} from "@/lib/db/conversation-overrides"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import { parseAdapterPolicyRelay } from "./adapter-policy-relay"
import { isConnectorRuntimeOwnedHere } from "./bootstrap/install-connector-runtime"

/**
 * ADR-0131 §2.7 — refuse a relayed Inbox write when THIS process does not own
 * the connector runtime. During a desktop ⇄ headless-brain handoff the bridge
 * can route a phone's reply to the side that just released the lease; running
 * it there would enqueue an outbound job no runner picks up (or, worse, a
 * second one once the owner also handles the retry).
 *
 * The thrown message is deliberately free of the words `lib/queue/retry-policy.ts`
 * treats as terminal (`not found`, `bad request`, `validation`, `401/403/404`,
 * …), so the phone's durable queue RETRIES: 5 attempts of exponential backoff
 * ≈ 31 s, which covers a normal lease handoff. `install-connector-runtime.ts`
 * pins the classification in its tests.
 */
function requireConnectorRuntimeOwnership(command: string): void {
  if (isConnectorRuntimeOwnedHere()) return
  throw new Error(
    `connector_runtime_not_owner: ${command} reached a process that does not own the connector runtime; retry`
  )
}

/**
 * Apply one bot's policy relayed from a paired client.
 *
 * `parseAdapterPolicyRelay` owns the wire vocabulary and the absent-vs-null
 * distinction; this arm owns only the writing. Each section lands through
 * `updateAdapterConfigSection`, so a change made from a phone leaves the same
 * `adapter.config_changed` breadcrumb as the desktop card that owns those
 * fields — attributed to `"mobile"`, the source this queue has always been
 * spelled with (it covers every paired client, phone or not).
 *
 * Sections are applied in order and each is its own transaction. A malformed
 * field throws before any of them run, so a rejected request never leaves half
 * a policy behind; a failure *between* sections is reported to the caller with
 * the earlier sections already committed, which is the same granularity the
 * desktop cards have — they are separate saves there too.
 */
async function adapterUpdatePolicy(payload: Record<string, unknown>): Promise<null> {
  const { id, sections } = parseAdapterPolicyRelay(payload)
  for (const { section, patch } of sections) {
    await updateAdapterConfigSection(id, section, patch, "mobile")
  }
  return null
}

/**
 * ADR-0131 cross-shell inbox relay — the real "send this reply to the
 * platform" arm. Runs the SAME `sendManualReplyLocally` the desktop composer
 * runs (`lib/connectors/inbox-writes/local.ts`), so a phone reply and a
 * desktop reply produce byte-identical `outboundQueue` + `messages` rows.
 *
 * Idempotent by construction: the client mints `request.metadata.idempotencyKey`
 * ONCE and replays it on every retry, and `sendManualReplyLocally` returns the
 * existing job instead of enqueuing a second one. The durable queue therefore
 * cannot double-send across a dropped connection.
 */
async function connectorEnqueueOutbound(
  payload: Record<string, unknown>
): Promise<{ jobId: string; messageId: string; reused: boolean }> {
  requireConnectorRuntimeOwnership("connector_enqueue_outbound")
  const adapterId = payload.adapterId as string | undefined
  const conversationKey = payload.conversationKey as string | undefined
  const sessionId = payload.sessionId as string | undefined
  const request = payload.request as OutboundRequest | undefined
  if (!adapterId) throw new Error("connector_enqueue_outbound.adapterId is required")
  if (!conversationKey) throw new Error("connector_enqueue_outbound.conversationKey is required")
  if (!sessionId) throw new Error("connector_enqueue_outbound.sessionId is required")
  if (!request || typeof request !== "object") {
    throw new Error("connector_enqueue_outbound.request is required")
  }
  if (!Array.isArray(request.segments)) {
    throw new Error("connector_enqueue_outbound.request.segments must be an array")
  }
  const idempotencyKey = request.metadata?.idempotencyKey
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new Error("connector_enqueue_outbound.request.metadata.idempotencyKey is required")
  }
  const { sendManualReplyLocally, parseManualReplyMessageMetadata } =
    await import("./inbox-writes/local")
  return sendManualReplyLocally({
    adapterId,
    conversationKey,
    sessionId,
    conversationRef: request.conversationRef,
    segments: request.segments,
    idempotencyKey,
    clientMessageId: payload.clientMessageId as string | undefined,
    replyTo: request.replyTo,
    threadId: request.threadId,
    messageMetadata: parseManualReplyMessageMetadata(payload.messageMetadata),
  })
}

/** Approve a pending connector draft so the connector outbound runner can
 *  pick it up for the real platform send. `segments` (ADR-0131) carries what
 *  the operator actually approved after editing it on the phone; without it
 *  the draft's own segments are sent. */
async function connectorApproveDraft(
  payload: Record<string, unknown>
): Promise<{ draftId: string; jobId?: string; alreadyApproved: boolean }> {
  requireConnectorRuntimeOwnership("connector_approve_draft")
  const draftId = payload.draftId as string | undefined
  if (!draftId) throw new Error("connector_approve_draft.draftId is required")
  const segments = payload.segments as MessageSegment[] | undefined
  if (segments !== undefined && !Array.isArray(segments)) {
    throw new Error("connector_approve_draft.segments must be an array when present")
  }
  const { approveDraftLocally } = await import("./inbox-writes/local")
  return approveDraftLocally(draftId, { segments })
}

/** Reject a pending connector draft. */
async function connectorRejectDraft(payload: Record<string, unknown>): Promise<null> {
  requireConnectorRuntimeOwnership("connector_reject_draft")
  const draftId = payload.draftId as string | undefined
  if (!draftId) throw new Error("connector_reject_draft.draftId is required")
  const { rejectDraftLocally } = await import("./inbox-writes/local")
  await rejectDraftLocally(draftId)
  return null
}

/**
 * Two payload shapes:
 *
 *  - legacy `{ input }` — a plain upsert, the pre-ADR-0131 mobile settings
 *    form's only move. Kept because an older phone build still sends it.
 *  - `{ mutation }` (ADR-0131) — one {@link ConversationOverrideMutation}
 *    applied with FULL host semantics: audit rows, the assignment trail, and
 *    assignment ↔ routing sync all behave exactly as if the operator had made
 *    the change on this desktop. `via` is stamped from the authenticated
 *    caller device (injected by the Rust layer, never trusted from the raw
 *    payload) so a phone-originated change is attributable.
 */
async function conversationOverridesUpdate(
  payload: Record<string, unknown>
): Promise<{ override: unknown }> {
  const mutation = payload.mutation
  if (mutation !== undefined) {
    const { applyConversationOverrideMutation, isConversationOverrideMutation } =
      await import("./inbox-writes/override-mutation")
    if (!isConversationOverrideMutation(mutation)) {
      throw new Error("conversation_overrides_update.mutation is malformed")
    }
    const deviceId = payload.callerDeviceId as string | undefined
    const override = await applyConversationOverrideMutation(mutation, {
      via: deviceId ? `device:${deviceId}` : undefined,
    })
    return { override: override ?? null }
  }
  const input = payload.input as ConversationOverrideInput | undefined
  if (!input || typeof input !== "object") {
    throw new Error("conversation_overrides_update requires `mutation` or legacy `input`")
  }
  const override = await upsertByConversationKey(input)
  return { override }
}

/**
 * A whole connector instance from another device of the account (ADR-0224
 * migration), or a configuration change to one this host runs. Interactive
 * approval: the RPC layer has already checked the admin lease.
 */
async function adapterInstanceMutate(payload: Record<string, unknown>): Promise<unknown> {
  const { mutateAdapterInstanceOnHost } = await import("./instance-transfer")
  return mutateAdapterInstanceOnHost(payload)
}

export const hostWriteCommands: ModuleHostWriteCommandsModule["hostWriteCommands"] = {
  adapter_update_policy: adapterUpdatePolicy,
  adapter_instance_mutate: adapterInstanceMutate,
  connector_enqueue_outbound: connectorEnqueueOutbound,
  connector_approve_draft: connectorApproveDraft,
  connector_reject_draft: connectorRejectDraft,
  conversation_overrides_update: conversationOverridesUpdate,
}
