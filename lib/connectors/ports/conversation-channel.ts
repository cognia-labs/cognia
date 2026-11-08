// The IM channel: the connectors' member of the `conversation-channel`
// collection port (`types/modules/ports/conversation-channel.ts`, ADR-0250
// §14). It claims every connector conversation (a key `parseConversationKey`
// reads) and answers from the connectors' own policy, automation controls,
// session bindings, delivery gateway and audit log. Its turns' questions,
// skill confirmations, workflow approvals and Notification Center records
// become interactive cards in the conversation, and reactions on its messages
// are mirrored through the adapter.

import { parseConversationKey } from "@/types/connectors/event"
import { resolveInboxWriteRoute } from "../inbox-writes/route"
import { newIdempotencyKey } from "@/types/connectors/outbound"
import type {
  ConversationChannel,
  ConversationChannelBinding,
} from "@/types/modules/ports/conversation-channel"

/** The adapter a binding names, or the one its conversation key carries. */
function adapterIdOf(binding: ConversationChannelBinding): string {
  return binding.adapterId ?? parseConversationKey(binding.conversationKey).adapterId
}

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

  async capabilityPrompt({ adapter, platform, promptSnapshot }) {
    const matrix = adapter.lastKnownCapabilities
    if (!matrix || Object.keys(matrix).length === 0) return null
    const { buildCapabilityPromptSection } = await import("../a2ui-bridge/capability-evaluator")
    // ADR-0026 — the cached built-in skill capabilities join the matrix, so
    // the prompt declares which skill families this channel can serve.
    return buildCapabilityPromptSection(
      platform,
      matrix,
      adapter.lastKnownSkillCapabilities,
      promptSnapshot
    )
  },

  async channelCapabilities({ platform, adapter }) {
    // Instance-level, from the stored row: a Slack grant without
    // `files:write` serves no upload skill. Without the row the platform's
    // own table answers.
    const { capabilityFingerprint, effectiveCapabilities, effectiveCapabilitiesForRow } =
      await import("../effective-capabilities")
    if (!adapter)
      return { capabilities: effectiveCapabilities({ platform }).capabilities, fingerprint: null }
    return {
      capabilities: effectiveCapabilitiesForRow(adapter).capabilities,
      fingerprint: capabilityFingerprint({
        platform: adapter.type,
        settings: adapter.settings,
        implMetadata: adapter.implMetadata,
        transportMode: adapter.transportMode,
      }),
    }
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

  async askUser({ sessionId, toolUseId, args, signal }) {
    // A connector turn registers its elicitation context for the capture's
    // lifetime (`runtime.ts`, `scheduled-outbound.ts`); any other session is
    // not this channel's to answer.
    const { getImElicitationContext } = await import("../hitl/im-elicitation-context")
    const ctx = getImElicitationContext(sessionId)
    if (!ctx) return null
    const { runImAskUser } = await import("../hitl/ask-user-question")
    // The caller's signal is combined with the context's own run-lifetime
    // signal inside runImAskUser.
    return { result: await runImAskUser({ ctx, toolUseId, args, ...(signal ? { signal } : {}) }) }
  },

  async confirmSkill(input) {
    const { postSkillConfirmation } = await import("../hitl/skill-confirmation")
    return postSkillConfirmation(input)
  },

  async approveWorkflowRun(input) {
    const { postWorkflowRunApproval } = await import("../hitl/workflow-approval-cards")
    return postWorkflowRunApproval(input)
  },

  async approveWorkflowFanout(input) {
    const { postWorkflowFanoutApproval } = await import("../hitl/workflow-approval-cards")
    return postWorkflowFanoutApproval(input)
  },

  async recordCallbackBinding(binding) {
    // A binding in a conversation is this channel's when the conversation is;
    // one without a conversation is when its adapter is one of ours.
    if (binding.conversationKey !== undefined) {
      if (!isConnectorConversation({ conversationKey: binding.conversationKey })) return false
    } else {
      const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
      if (!(await getAdapterInstance(binding.adapterId))) return false
    }
    const { recordCallbackBinding } = await import("../adapters/_shared/a2ui-mapper")
    await recordCallbackBinding(binding)
    return true
  },

  async injectionProtection(binding) {
    const { connectorInjectionProtection } = await import("../content-safety")
    return connectorInjectionProtection(adapterIdOf(binding))
  },

  writeRoute() {
    // Inbox replies, drafts and reactions all execute where the connector
    // runtime does (ADR-0131), whichever conversation they belong to.
    return resolveInboxWriteRoute()
  },

  async addReaction({ binding, platformMessageId, emoji }) {
    const { getBus } = await import("../bus")
    const result = await getBus().addReactionOutbound(
      adapterIdOf(binding),
      platformMessageId,
      emoji
    )
    if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? "unsupported")
    return result.reactionId
  },

  async removeReaction({ binding, platformMessageId, reactionId, emoji }) {
    const { getBus } = await import("../bus")
    // Adapters that hand back no reaction id key removal by the emoji itself.
    const result = await getBus().removeReactionOutbound(
      adapterIdOf(binding),
      platformMessageId,
      reactionId ?? emoji
    )
    if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? "unsupported")
  },

  async deliverNotification(input) {
    const { deliverNotificationToConversation } = await import("../notifications/im-deliver")
    return deliverNotificationToConversation(input)
  },

  async appendAudit(entry) {
    const { appendAudit } = await import("../audit")
    await appendAudit({ ...entry, at: Date.now() }).catch(() => undefined)
  },
}
