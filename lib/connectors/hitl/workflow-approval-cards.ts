/**
 * The workflow approval cards a plugin asks for in an IM conversation (the
 * plugin workflow-author API's `prepareWorkflowApproval` and
 * `prepareFanoutApproval`, ADR-0026 / ADR-0117). The API checks the trigger
 * origin against its session and asks the conversation's channel (the
 * `conversation-channel` port's `approveWorkflowRun` and
 * `approveWorkflowFanout`), which lands here.
 *
 * The card goes to the Host's live delivery target for the conversation,
 * never to a copy a plugin carries: a child session's card goes to its root's
 * conversation, through the root's live turn when one runs, and nothing is
 * posted while that turn is drafting.
 *
 *   - Run approval holds the dispatch (`workflow-run-approval.ts`) under the
 *     narrower of the session's ceiling and the conversation's own.
 *   - Fan-out approval records its two choices (`wf_fanout_approve` /
 *     `wf_fanout_cancel`) and posts the card.
 */

import { getResolvedPermissionCeiling } from "@/lib/claude/agents/dispatch-context-registry"
import { deriveExternalSessionPermission } from "@/lib/ai/agent/external/policy/permission-cascade"
import {
  WF_FANOUT_APPROVE_PREFIX,
  WF_FANOUT_CANCEL_PREFIX,
} from "@/lib/claude/hitl/callback-prefixes"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { resolveBuiltInSkillSessionBinding } from "@/lib/skills/built-in/context"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import { parseConversationKey } from "@/types/connectors/event"
import type { CallbackActorScope } from "@/types/connectors/interaction"
import type {
  ConversationWorkflowApproval,
  ConversationWorkflowOrigin,
} from "@/types/modules/ports/conversation-channel"
import { buildA2UISegment } from "../a2ui-bridge/a2ui-to-segments"
import { recordCallbackBinding } from "../adapters/_shared/a2ui-mapper"
import { enqueueGoverned } from "../delivery-gateway"
import { buildImPermissionCeiling } from "../im-permission-ceiling"
import { getImElicitationContext } from "./im-elicitation-context"
import { holdWorkflowDispatchForApproval } from "./workflow-run-approval"

type DeliverableOrigin = ConversationWorkflowOrigin & {
  conversationRef: ConversationReference
  deliveryTarget: ConversationDeliveryTarget
}

/** The origin with the Host's live delivery target for its conversation. */
async function resolveApprovalDelivery(
  origin: ConversationWorkflowOrigin
): Promise<DeliverableOrigin> {
  const { binding, rootSessionId } = await resolveBuiltInSkillSessionBinding(origin.sessionId)
  const live = getImElicitationContext(rootSessionId)
  const target = live ?? binding
  const deliveryTarget = target?.deliveryTarget
  const conversationRef = deliveryTarget?.conversationRef
  if (
    target?.adapterId !== origin.adapterId ||
    target.conversationKey !== origin.conversationKey ||
    live?.drafting ||
    !deliveryTarget?.address.containerId?.trim() ||
    deliveryTarget.address.adapterId !== origin.adapterId ||
    deliveryTarget.address.conversationKey !== origin.conversationKey ||
    conversationRef?.adapterId !== origin.adapterId ||
    conversationRef.platform !== deliveryTarget.address.platform
  )
    throw new Error("Workflow approval delivery target is unavailable or incomplete")
  // The Host's live sender and conversation are authoritative, never a plugin's copy.
  return { ...origin, conversationRef, deliveryTarget }
}

/** Hold the run for a person's approval and post its card. Throws when refused. */
export async function postWorkflowRunApproval(input: {
  workflowId: string
  runParams?: Record<string, unknown>
  triggeredFrom: ConversationWorkflowOrigin
}): Promise<ConversationWorkflowApproval> {
  const triggeredFrom = await resolveApprovalDelivery(input.triggeredFrom)
  const adapter = await getAdapterInstance(triggeredFrom.adapterId)
  if (!adapter) throw new Error("Workflow approval adapter not found")
  const override = (await readForResolution(triggeredFrom.conversationKey)) ?? null
  const { platform } = parseConversationKey(triggeredFrom.conversationKey)
  const currentCeiling = await buildImPermissionCeiling({
    adapter,
    override,
    platform,
    target: "workflow",
  })
  const parentCeiling = getResolvedPermissionCeiling(triggeredFrom.sessionId)
  const permissionCeiling = deriveExternalSessionPermission(parentCeiling ?? {}, currentCeiling)
  const result = await holdWorkflowDispatchForApproval({
    workflowId: input.workflowId,
    runParams: input.runParams ?? {},
    triggeredFrom,
    adapterId: adapter.id,
    conversationKey: triggeredFrom.conversationKey,
    conversationRef: triggeredFrom.conversationRef,
    deliveryTarget: triggeredFrom.deliveryTarget,
    initiatorUserId: triggeredFrom.initiator?.remoteUserId,
    permissionCeiling,
    deliverCard: true,
  })
  if (!result.held) throw new Error(result.message)
  return { surfaceId: result.surfaceId, workflowName: result.workflowName, surface: result.surface }
}

/** Record the fan-out card's two choices and post it. Throws when it cannot be queued. */
export async function postWorkflowFanoutApproval(input: {
  workflowId: string
  workflowName: string
  triggeredFrom: ConversationWorkflowOrigin
  actorScope: CallbackActorScope
}): Promise<ConversationWorkflowApproval> {
  const { workflowId, workflowName, actorScope } = input
  const triggeredFrom = await resolveApprovalDelivery(input.triggeredFrom)
  const { adapterId, conversationKey } = triggeredFrom
  const bindingId = crypto.randomUUID()
  const surfaceId = `wffanout:${bindingId}`
  const payload = {
    workflowId,
    workflowName,
    target: { adapterId, conversationKey },
    createdBy: "claude-tool",
  }
  for (const [prefix, kind, componentId] of [
    [WF_FANOUT_APPROVE_PREFIX, "wf_fanout_approve", "approve"],
    [WF_FANOUT_CANCEL_PREFIX, "wf_fanout_cancel", "cancel"],
  ] as const) {
    await recordCallbackBinding({
      adapterId,
      actionId: prefix + bindingId,
      kind,
      surfaceId,
      componentId,
      conversationKey,
      payload,
      actorScope,
      allowedActions: ["approve", "cancel"],
    })
  }
  const t = await getRuntimeTranslator("workflows.approvals")
  const title = t("fanout.title", { name: workflowName })
  const summary = t("fanout.summary")
  const approve = t("fanout.approve")
  const cancel = t("fanout.cancel")
  const surface = {
    rootId: "root",
    surfaceType: "inline" as const,
    title,
    dataModel: {},
    components: {
      root: { component: "Card", title, children: ["summary", "actions"] },
      summary: { component: "Text", text: summary },
      actions: { component: "Row", children: ["approve", "cancel"] },
      approve: {
        component: "Button",
        text: approve,
        action: "approve",
        value: WF_FANOUT_APPROVE_PREFIX + bindingId,
      },
      cancel: {
        component: "Button",
        text: cancel,
        action: "cancel",
        value: WF_FANOUT_CANCEL_PREFIX + bindingId,
      },
    },
    widget: {
      fallbackText: [`# ${title}`, summary, `[${approve}] [${cancel}]`, t("fanout.replyHint")].join(
        "\n"
      ),
    },
  }
  await enqueueGoverned({
    adapterId,
    conversationKey,
    source: "ai-run",
    authorization: { kind: "system-notice", inboundConversationKey: conversationKey },
    request: {
      conversationRef: triggeredFrom.conversationRef,
      deliveryTarget: triggeredFrom.deliveryTarget,
      ...(triggeredFrom.deliveryTarget.address.topicId
        ? { threadId: triggeredFrom.deliveryTarget.address.topicId }
        : {}),
      segments: [buildA2UISegment(surfaceId, surface)],
      metadata: { idempotencyKey: surfaceId },
    },
  })
  return { surfaceId, workflowName, surface }
}
