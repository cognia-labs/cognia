/**
 * An IM room's reply mode IS its conversation's activation policy (ADR-0177
 * batch 4, ADR-0252 P7).
 *
 * Batch 3 gave an IM room two knobs that could disagree: the session's
 * `roomSettings.replyMode` and the override row's `inboundActivationPolicy`.
 * Admission read both and the stricter won, so the Inbox showed "always"
 * while the room said "asleep". The override row is now the only store for
 * an IM room, and this module is the one place the two vocabularies meet:
 *
 * | reply mode     | policy written | policies read as this mode                        |
 * | -------------- | -------------- | ------------------------------------------------- |
 * | `asleep`       | `off`          | `off`, `direct_only` (a group then answers nobody) |
 * | `mention_only` | `mention_each` | `mention_each`; `mention_activates` outside a thread |
 * | `auto`         | see below      | `always`; `mention_activates` in a thread          |
 *
 * `mention_activates` only opens follow-ups inside a thread
 * (`evaluateAdmissionPolicy`), so in a plain group it behaves as, and reads
 * as, mention-only.
 *
 * Choosing `auto` keeps a finer policy the conversation already has when that
 * policy is itself `auto` for this scope, clears the override when the
 * adapter's own policy is, and otherwise writes `always`. The finer choices
 * (`always` against `mention_activates`, Lark's delivery check) stay in the
 * Inbox's conversation settings, and the room never flattens them.
 *
 * Team and shared rooms keep `roomSettings.replyMode`.
 */

import type { RoomReplyMode } from "@/lib/chat/room/types"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ChannelKind } from "@/types/connectors/event"
import type { InboundActivationPolicy } from "@/types/connectors/policy"
import { resolveInboundActivationPolicy } from "./conversation-admission"

/** The reply mode a conversation under `policy` behaves as, in a `scope` conversation. */
export function replyModeOfActivationPolicy(
  policy: InboundActivationPolicy,
  scope: ChannelKind | undefined
): RoomReplyMode {
  switch (policy) {
    case "off":
    case "direct_only":
      return "asleep"
    case "mention_each":
      return "mention_only"
    case "mention_activates":
      return scope === "thread" ? "auto" : "mention_only"
    case "always":
      return "auto"
  }
}

export interface ImRoomPolicyInput {
  adapter: Pick<AdapterInstanceRow, "atResponseStrategy" | "inboundActivationPolicy">
  override: Pick<ConversationOverrideRow, "inboundActivationPolicy"> | null | undefined
  scope: ChannelKind | undefined
}

/** The IM room's reply mode, read off the policy admission actually applies. */
export function imRoomReplyMode(input: ImRoomPolicyInput): RoomReplyMode {
  return replyModeOfActivationPolicy(
    resolveInboundActivationPolicy(input.adapter, input.override ?? undefined),
    input.scope
  )
}

/**
 * The override value that makes the room behave as `mode`, or `undefined` to
 * clear the conversation's own policy and follow the adapter's.
 */
export function activationPolicyForReplyMode(
  mode: RoomReplyMode,
  input: ImRoomPolicyInput
): InboundActivationPolicy | undefined {
  if (mode === "asleep") return "off"
  if (mode === "mention_only") return "mention_each"
  const current = input.override?.inboundActivationPolicy
  if (current && replyModeOfActivationPolicy(current, input.scope) === "auto") return current
  const inherited = resolveInboundActivationPolicy(input.adapter, undefined)
  if (replyModeOfActivationPolicy(inherited, input.scope) === "auto") return undefined
  return "always"
}
