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
  const { members, failures } = await loadPortCollection("conversation-channel")
  for (const failure of failures)
    loggers.chat.error("conversation channel failed to load", {
      module: failure.module,
      error: String(failure.error),
    })
  const claiming = members.filter((member) => member.port.claimsBinding(binding))
  if (claiming.length > 1)
    loggers.chat.error("several conversation channels claim one binding", {
      conversationKey: binding.conversationKey,
      modules: claiming.map((member) => member.module),
    })
  return claiming[0]?.port ?? null
}
