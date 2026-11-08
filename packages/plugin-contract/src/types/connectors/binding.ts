import type { PlatformKind } from "./platform-kind"
import type { ChannelKind, ConversationDeliveryTarget, ConversationReference } from "./event"
import type { ConnectorMode, TriggerPolicy } from "./policy"

export interface PlatformBinding {
  adapterId: string
  conversationKey: string
  platform: PlatformKind
  /** Persisted alongside binding so proactive outbound has a handle. */
  conversationRef: ConversationReference
  /** Latest complete target, including topic identity and reply anchor. */
  deliveryTarget?: ConversationDeliveryTarget
  /**
   * The conversation's scope as the last inbound event reported it
   * (`event.channel.kind`): a `private` chat is a direct conversation, any
   * other scope is a room (ADR-0177, ADR-0252 §6). Absent on a binding no
   * event has refreshed since this field was added; `platformScopeOf` then
   * falls back to the delivery target and the reference.
   */
  scopeKind?: ChannelKind
}

/**
 * Host-owned IM authority on an app transcript. This is deliberately separate
 * from ChatSession.platformBinding: it grants neither connector ownership nor
 * message/history delivery. Non-indexed session metadata needs no DB migration.
 */
export interface SessionImAuthority {
  imAuthorityBinding?: PlatformBinding
}

/** Optional defaults a Character can ship per platform binding. */
export interface CharacterPlatformDefaults {
  mode?: ConnectorMode
  trigger?: Partial<TriggerPolicy>
}
