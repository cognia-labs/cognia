/**
 * Message reactions (ADR-0177, batch 2).
 *
 * One entry point for "the local user toggled an emoji on a message". The row
 * is the record (`metadata.reactions`, written through `setMessageReaction`
 * so a concurrent inbound reaction is never lost), and when the message came
 * over an IM connector the same toggle is mirrored to the platform through the
 * adapter's `addReaction` / `removeReaction`, so the person on Telegram sees
 * the thumbs-up too.
 *
 * # Where the mirror runs
 *
 * The mirror runs through the channel the conversation is bound to (the
 * `conversation-channel` port), which says where its writes run from this
 * shell: `local` mirrors through it, `unavailable` (a standalone tab with no
 * host at all, or a conversation no channel serves) writes the row and has
 * nothing to mirror to, and `remote` (a paired phone or web companion) writes
 * nothing, because its `messages` rows are a mirror of the host's and the
 * host would overwrite the reaction on the next sync. The picker says so
 * instead of hiding (see `components/chat/message-reactions.tsx`).
 */

import type { UIMessage } from "ai"
import {
  hasReacted,
  LOCAL_REACTOR_ID,
  type MessageReaction,
  type ReactionChange,
} from "@cognia/agent-config-types"

import { REACTION_EMOJIS } from "@/lib/canvas/constants"
import { setMessageReaction } from "@/lib/db/messages"
import type { WritePlaneRoute } from "@/lib/runtime/write-plane-route"
import type {
  ConversationChannel,
  ConversationChannelBinding,
} from "@/types/modules/ports/conversation-channel"
import { conversationChannelFor } from "./conversation-channel"
import { reflectMessageReactions } from "./reactions-store"

/** The picker's palette, shared with canvas comments so the two read alike. */
export const MESSAGE_REACTION_EMOJIS: readonly string[] = REACTION_EMOJIS

/** The reactions on a message, or an empty list. */
export function readReactions(message: { metadata?: unknown }): MessageReaction[] {
  const meta = message.metadata
  if (!meta || typeof meta !== "object") return []
  const value = (meta as { reactions?: unknown }).reactions
  return Array.isArray(value) ? (value as MessageReaction[]) : []
}

/** The IM address of a message that arrived over a connector, if it did. */
export function platformAddressOf(message: {
  metadata?: unknown
}): { adapterId: string; platformMessageId: string; conversationKey?: string } | null {
  const meta = message.metadata
  if (!meta || typeof meta !== "object") return null
  const pm = (meta as { platformMessage?: unknown }).platformMessage
  if (!pm || typeof pm !== "object") return null
  const { adapterId, messageId, conversationKey } = pm as {
    adapterId?: unknown
    messageId?: unknown
    conversationKey?: unknown
  }
  if (typeof adapterId !== "string" || !adapterId) return null
  if (typeof messageId !== "string" || !messageId) return null
  return {
    adapterId,
    platformMessageId: messageId,
    ...(typeof conversationKey === "string" && conversationKey ? { conversationKey } : {}),
  }
}

/**
 * Whether the reaction affordance applies to this row at all.
 *
 * A reaction is a signal to other people. In a solo chat with the assistant
 * there is nobody to receive it: the emoji would land in local metadata that
 * no one else can ever read, and the mirror would be skipped for want of a
 * platform address. So the picker is offered only where the row is genuinely
 * multi-party — it came over an IM connector (`metadata.platformMessage`), or
 * it already carries reactions somebody put there. That is "the feature does
 * not exist here", which is a different answer from "it exists and this shell
 * may not write it" (see `reactionAbilityFor`), and the two must not collapse
 * into one blank space: the second still renders, disabled, with its reason.
 */
export function messageAllowsReactions(message: { metadata?: unknown }): boolean {
  return platformAddressOf(message) !== null || readReactions(message).length > 0
}

/** What a shell may do with reactions, from the same route the Inbox writes use. */
export type ReactionAbility = "write-and-mirror" | "write-only" | "host-only"

export function reactionAbilityFor(route: WritePlaneRoute): ReactionAbility {
  if (route === "local") return "write-and-mirror"
  if (route === "remote") return "host-only"
  return "write-only"
}

/**
 * The conversation a reaction belongs to: the one the message names, else the
 * one its session is bound to (rows stored before messages named theirs).
 */
async function conversationOf(
  sessionId: string,
  address: ReturnType<typeof platformAddressOf>
): Promise<ConversationChannelBinding | null> {
  if (address?.conversationKey)
    return { conversationKey: address.conversationKey, adapterId: address.adapterId }
  const { getSession } = await import("@/lib/db/sessions")
  const binding = (await getSession(sessionId))?.platformBinding
  if (!binding?.conversationKey) return null
  return {
    conversationKey: binding.conversationKey,
    adapterId: address?.adapterId ?? binding.adapterId,
  }
}

export interface ToggleReactionInput {
  sessionId: string
  message: Pick<UIMessage, "id"> & { metadata?: unknown }
  emoji: string
  actorId?: string
  /** Test seam. Production resolves the conversation and asks its channel. */
  deps?: {
    conversation?: () => Promise<ConversationChannelBinding | null>
    channelFor?: typeof conversationChannelFor
  }
}

export interface ToggleReactionResult {
  reactions: MessageReaction[] | null
  added: boolean
  /** `"skipped"` when there was nothing to mirror to, `"failed"` carries the reason. */
  mirror: "done" | "skipped" | { failed: string }
}

/**
 * Toggle `emoji` for `actorId` on the message and mirror the change to the
 * platform when this shell can. Throws when the shell must not write at all.
 */
export async function toggleMessageReaction(
  input: ToggleReactionInput
): Promise<ToggleReactionResult> {
  const actorId = input.actorId ?? LOCAL_REACTOR_ID
  const address = platformAddressOf(input.message)
  const binding = await (
    input.deps?.conversation ?? (() => conversationOf(input.sessionId, address))
  )()
  const channel: ConversationChannel | null = binding
    ? await (input.deps?.channelFor ?? conversationChannelFor)(binding)
    : null
  const ability = reactionAbilityFor(
    channel && binding ? channel.writeRoute(binding) : "unavailable"
  )
  if (ability === "host-only") throw new ReactionNeedsHostError()

  const current = readReactions(input.message)
  const add = !hasReacted(current, input.emoji, actorId)
  const change: ReactionChange = { emoji: input.emoji, actorId, add }

  let mirror: ToggleReactionResult["mirror"] = "skipped"
  if (ability === "write-and-mirror" && address && channel && binding) {
    try {
      if (add) {
        const reactionId = await channel.addReaction({
          binding,
          platformMessageId: address.platformMessageId,
          emoji: input.emoji,
        })
        if (reactionId) change.platformReactionId = reactionId
      } else {
        const reactionId = current.find((reaction) => reaction.emoji === input.emoji)
          ?.platformReactionIds?.[actorId]
        await channel.removeReaction({
          binding,
          platformMessageId: address.platformMessageId,
          ...(reactionId ? { reactionId } : {}),
          emoji: input.emoji,
        })
      }
      mirror = "done"
    } catch (error) {
      // The local record still changes: the user did react, and the row is
      // what the room and the transcript read. The caller says the platform
      // did not get it.
      mirror = { failed: error instanceof Error ? error.message : String(error) }
    }
  }

  const reactions = await setMessageReaction(input.sessionId, input.message.id, change)
  if (reactions) reflectMessageReactions(input.sessionId, input.message.id, reactions)
  return { reactions, added: add, mirror }
}

export class ReactionNeedsHostError extends Error {
  constructor() {
    super("reactions are written by the host that owns this conversation")
    this.name = "ReactionNeedsHostError"
  }
}
