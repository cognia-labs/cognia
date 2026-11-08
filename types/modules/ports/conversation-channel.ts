// The `conversation-channel` collection port (ADR-0250 §14): the channel a
// conversation or run is bound to, answering what only that channel knows.
// Which host capabilities the conversation allows, whether its automation is
// paused, which sibling conversations it has, how a message reaches it, what
// it can render and serve, and who answers the agent's questions and
// confirmations while a turn runs there.
//
// It is a collection port: every channel that binds conversations is its own
// member, and each member says which bindings it claims. The connectors module
// provides the IM channel (`lib/connectors/ports/conversation-channel.ts`);
// other channels (a bot's topics, a paired browser, a paired device) add
// theirs the same way. The one reader is `lib/chat/conversation-channel.ts`,
// so neither the kernel nor another module imports a channel's code.

import type { ImHostCapabilityId } from "@/lib/db/connector-types"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import type { OutboundAuthorization } from "@/lib/policy/action-review/plan-delivery"
import type { PromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import type {
  BuiltInSkill,
  BuiltInSkillContext,
  BuiltInSkillResult,
} from "@/lib/skills/built-in/types"
import type { AuditKind } from "@/types/connectors/audit"
import type { Capability } from "@/types/connectors/capability"
import type {
  CallbackActorScope,
  ConnectorCallbackBindingKind,
} from "@/types/connectors/interaction"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

/** A conversation as a run or session names it. */
export interface ConversationChannelBinding {
  conversationKey: string
  adapterId?: string
}

/** A conversation on the same remote chat, reached through another binding. */
export interface ConversationChannelSibling {
  adapterId: string
  conversationKey: string
  sessionId: string
}

/**
 * A workflow trigger origin the caller has checked against the session it
 * names (`resolveWorkflowTriggerOrigin`): an IM origin with every field a
 * channel needs to find the conversation.
 */
export type ConversationWorkflowOrigin = WorkflowTriggeredFrom & {
  source: "im"
  sessionId: string
  adapterId: string
  conversationKey: string
}

/** A workflow approval card the channel posted. */
export interface ConversationWorkflowApproval {
  surfaceId: string
  workflowName: string
  surface: A2UISegmentContent
}

/** One choice on a card a plugin drew, routed back when a person picks it. */
export interface ConversationCallbackBinding {
  adapterId: string
  actionId: string
  kind: ConnectorCallbackBindingKind
  surfaceId: string
  componentId?: string
  conversationKey?: string
  payload: Record<string, unknown>
  actorScope: CallbackActorScope
  allowedActions?: string[]
}

export interface ConversationChannel {
  /** Whether this channel binds the conversation. Synchronous and deterministic. */
  claimsBinding(binding: ConversationChannelBinding): boolean
  /**
   * The host capabilities the conversation allows. A row the caller already
   * read may be passed; a member reads what it is not given.
   */
  hostCapabilities(input: {
    binding: ConversationChannelBinding
    adapter?: AdapterInstanceRow | null
    override?: ConversationOverrideRow | null
    characterComputerUseEnabled?: boolean
  }): Promise<Record<ImHostCapabilityId, boolean>>
  /**
   * The system-prompt section telling the model what the conversation can
   * render (interactive surfaces, built-in skill families), worded through
   * the turn's Prompt Center snapshot. `null` while the channel has not
   * learned it yet. Deterministic for one adapter row and snapshot, so a
   * caller may cache it by both.
   */
  capabilityPrompt(input: {
    binding: ConversationChannelBinding
    adapter: AdapterInstanceRow
    platform: PlatformKind
    promptSnapshot?: PromptOverrideSnapshot | null
  }): Promise<string | null>
  /**
   * What the conversation can actually serve, for filtering the skills a turn
   * is offered, and a fingerprint of it for caches (`null` without an adapter
   * row, when the platform's own table answers).
   */
  channelCapabilities(input: {
    binding: ConversationChannelBinding
    platform: PlatformKind
    adapter?: AdapterInstanceRow | null
  }): Promise<{ capabilities: readonly Capability[]; fingerprint: string | null }>
  /**
   * Wait while the conversation's automation is paused. `false` when work
   * accepted at `acceptedAt` was cancelled meanwhile (it must not start).
   */
  waitForAutomation(
    binding: ConversationChannelBinding,
    acceptedAt: number,
    options?: { signal?: AbortSignal; runId?: string }
  ): Promise<boolean>
  /** Sibling conversations of the binding (same remote chat, other bindings). */
  listSiblingConversations(
    binding: ConversationChannelBinding
  ): Promise<readonly ConversationChannelSibling[]>
  /**
   * Post one text message to the conversation through the channel's durable
   * delivery. `drafted`: the outbound policy (ADR-0239) held it for a person.
   */
  postText(input: {
    binding: ConversationChannelBinding & { adapterId: string }
    text: string
    authorization: OutboundAuthorization
  }): Promise<"queued" | "drafted">
  /**
   * Answer an `ask_user` call when a turn this channel runs owns the session:
   * the question goes to the conversation and the call waits for the answer.
   * `null` when the session is not one of this channel's live turns (the
   * caller asks the next channel, then the desktop dialog).
   */
  askUser(input: {
    sessionId: string
    toolUseId: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<{ result: unknown } | null>
  /**
   * Ask the conversation to confirm a built-in skill call (ADR-0026 HITL):
   * post the skill's confirmation surface with its confirm and cancel
   * choices, which re-fire the skill when a person picks one. Called for a
   * context whose `imBinding` this channel claims; returns `pending_hitl`, or
   * `error` when the confirmation cannot reach anyone.
   */
  confirmSkill(input: {
    ctx: BuiltInSkillContext & { imBinding: NonNullable<BuiltInSkillContext["imBinding"]> }
    skill: BuiltInSkill
    args: unknown
    now: number
  }): Promise<BuiltInSkillResult>
  /**
   * Ask the conversation to approve running a workflow before it starts: post
   * the Approve / Cancel card for the published version the run will execute,
   * under the conversation's permission ceiling, and hold the dispatch until a
   * person answers. Throws when the card cannot reach the conversation (no
   * live delivery target, the adapter is gone, the hold was refused).
   */
  approveWorkflowRun(input: {
    workflowId: string
    runParams?: Record<string, unknown>
    triggeredFrom: ConversationWorkflowOrigin
  }): Promise<ConversationWorkflowApproval>
  /**
   * Ask the conversation to approve fanning a workflow's output out to the
   * conversation: post the Approve / Cancel card, answerable by `actorScope`.
   * Throws when the card cannot reach the conversation.
   */
  approveWorkflowFanout(input: {
    workflowId: string
    workflowName: string
    triggeredFrom: ConversationWorkflowOrigin
    actorScope: CallbackActorScope
  }): Promise<ConversationWorkflowApproval>
  /**
   * Record a choice on a card a plugin drew in one of this channel's
   * conversations, so a person's pick reaches its handler. `false` when the
   * binding is not this channel's (its conversation, or without one its
   * adapter, belongs to no conversation the channel serves).
   */
  recordCallbackBinding(binding: ConversationCallbackBinding): Promise<boolean>
  /** Append a row to the channel's audit log. Best-effort: never throws. */
  appendAudit(entry: {
    adapterId: string
    kind: AuditKind
    conversationKey?: string
    reason?: string
    fields?: Record<string, unknown>
  }): Promise<void>
}

declare module "@/lib/modules/ports" {
  interface PortCollectionMap {
    "conversation-channel": ConversationChannel
  }
}
