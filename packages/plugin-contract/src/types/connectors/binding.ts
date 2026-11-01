import type { PlatformKind } from "./platform-kind"
import type { ConversationDeliveryTarget, ConversationReference } from "./event"
import type { ConnectorMode, TriggerPolicy } from "./policy"

export interface PlatformBinding {
  adapterId: string
  conversationKey: string
  platform: PlatformKind
  /** Persisted alongside binding so proactive outbound has a handle. */
  conversationRef: ConversationReference
  /** Latest complete target, including topic identity and reply anchor. */
  deliveryTarget?: ConversationDeliveryTarget
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
