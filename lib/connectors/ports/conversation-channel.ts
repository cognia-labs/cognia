// The IM channel: the connectors' member of the `conversation-channel`
// collection port (`types/modules/ports/conversation-channel.ts`, ADR-0250
// §14). It claims every connector conversation (a key `parseConversationKey`
// reads) and answers from the connectors' own policy, automation controls,
// session bindings, delivery gateway and audit log.

import { parseConversationKey } from "@/types/connectors/event"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import type {
  ConversationChannel,
  ConversationChannelBinding,
} from "@/types/modules/ports/conversation-channel"

function isConnectorConversation(binding: ConversationChannelBinding): boolean {
  try {
    parseConversationKey(binding.conversationKey)
    return true
  } catch {
    return false
  }
}

export const port: ConversationChannel = {
  claimsBinding: isConnectorConversation,

  async hostCapabilities(input) {
    const [{ resolveImHostCapabilities }, { readForResolution }, { getAdapterInstance }] =
      await Promise.all([
        import("../permission-resolve"),
        import("@/lib/db/conversation-overrides"),
        import("@/lib/db/adapter-instances"),
      ])
    const adapterId =
      input.binding.adapterId ?? parseConversationKey(input.binding.conversationKey).adapterId
    const [override, adapter] = await Promise.all([
      "override" in input ? input.override : readForResolution(input.binding.conversationKey),
      "adapter" in input ? input.adapter : getAdapterInstance(adapterId),
    ])
    return resolveImHostCapabilities({
      adapter,
      override,
      characterComputerUseEnabled: input.characterComputerUseEnabled,
    })
  },

  async waitForAutomation(binding, acceptedAt, options) {
    const { waitForConversationAutomation } = await import("../automation-control")
    return waitForConversationAutomation(binding.conversationKey, acceptedAt, options)
  },

  async listSiblingConversations(binding) {
    const { listSiblingConversations } = await import("../session-bindings")
    return listSiblingConversations(binding.conversationKey)
  },

  async postText(input) {
    // The `im.broadcast` enqueue path: the durable outbound queue with a fresh
    // idempotency key, so the adapter's rate limit, circuit breaker and quiet
    // hours apply downstream.
    const [bindings, { enqueueAuthorized }] = await Promise.all([
      import("../session-bindings"),
      import("../delivery-gateway"),
    ])
    const { adapterId, conversationKey } = input.binding
    const parsed = parseConversationKey(conversationKey)
    const session = await bindings.findSessionByConversationKey(conversationKey)
    const conversationRef = session?.platformBinding?.conversationRef ?? {
      platform: parsed.platform,
      adapterId,
      channelId: parsed.remoteChatId,
    }
    const result = await enqueueAuthorized({
      adapterId,
      conversationKey,
      request: {
        conversationRef,
        segments: [{ type: "text", text: input.text }],
        metadata: { idempotencyKey: newIdempotencyKey() },
      },
      source: "skill",
      authorization: input.authorization,
    })
    return result.kind
  },

  async appendAudit(entry) {
    const { appendAudit } = await import("../audit")
    await appendAudit({ ...entry, at: Date.now() }).catch(() => undefined)
  },
}
