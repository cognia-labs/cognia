// The one reader of the `conversation-channel` collection port
// (`types/modules/ports/conversation-channel.ts`, ADR-0250 §14). The kernel
// and modules ask it for the channel a conversation is bound to and never
// import a channel's code.

import { loggers } from "@cognia/logging"
import { loadPortCollection } from "@/lib/modules/ports"
import type {
  ConversationChannel,
  ConversationChannelBinding,
} from "@/types/modules/ports/conversation-channel"

/**
 * The channel that claims `binding`, or `null` when no active channel does
 * (the module that provides it is off, or the binding is nobody's). Members
 * whose file fails to load are logged and left out; a binding claimed by
 * more than one channel is logged and goes to the first in module order.
 */
export async function conversationChannelFor(
  binding: ConversationChannelBinding
): Promise<ConversationChannel | null> {
  const members = await loadChannels()
  const claiming = members.filter((member) => member.port.claimsBinding(binding))
  if (claiming.length > 1)
    loggers.chat.error("several conversation channels claim one binding", {
      conversationKey: binding.conversationKey,
      modules: claiming.map((member) => member.module),
    })
  return claiming[0]?.port ?? null
}

/**
 * Ask the channel whose live turn owns `sessionId` to answer an `ask_user`
 * call. Channels are asked in module order and the first that owns the
 * session answers; `null` when none does (a desktop turn: the caller shows
 * the ask-user dialog).
 */
export async function askUserInConversation(
  input: Parameters<ConversationChannel["askUser"]>[0]
): Promise<{ result: unknown } | null> {
  for (const member of await loadChannels()) {
    const answer = await member.port.askUser(input)
    if (answer) return answer
  }
  return null
}

/**
 * Record a choice on a card a plugin drew with the channel it belongs to.
 * Channels are asked in module order and the first that serves the binding
 * records it; `false` when none does.
 */
export async function recordConversationCallbackBinding(
  binding: Parameters<ConversationChannel["recordCallbackBinding"]>[0]
): Promise<boolean> {
  for (const member of await loadChannels())
    if (await member.port.recordCallbackBinding(binding)) return true
  return false
}

async function loadChannels() {
  const { members, failures } = await loadPortCollection("conversation-channel")
  for (const failure of failures)
    loggers.chat.error("conversation channel failed to load", {
      module: failure.module,
      error: String(failure.error),
    })
  return members
}
