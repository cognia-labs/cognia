/**
 * The plugin contract's share of `lib/connectors/conversation-admission.ts`, which re-exports these.
 */
export type ConversationAdmissionReason =
  | "at_mention_required"
  | "at_direct_only"
  | "delivery_unverified"
  | "topic_activation_required"
  | "topic_activation_expired"
  /**
   * The conversation's activation policy is `off`, the IM room's `asleep`
   * reply mode (ADR-0177 batches 3 and 4).
   */
  | "room_asleep"
