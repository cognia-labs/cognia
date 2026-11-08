/**
 * A built-in skill's confirmation card in an IM conversation (ADR-0026 HITL).
 *
 * The dispatcher (`lib/skills/built-in/dispatcher.ts`) decides that a skill
 * call needs a person's confirmation; when the session is bound to an IM
 * conversation it asks that conversation's channel (the `conversation-channel`
 * port's `confirmSkill`), which lands here. The card is the skill's own
 * `hitlSurface` with a confirm and a cancel button. Each button is a
 * `skill_invoke` callback binding that re-fires the skill with
 * `hitlBypass: true` (`ConnectorBus.dispatchConnectorCallback`), scoped to the
 * person allowed to answer.
 *
 * A child session's call is confirmed in its root's conversation, through the
 * root's live turn when one runs (its delivery target and signal), so a card
 * never outlives the turn that asked for it.
 */

import { SKILL_CANCEL_PREFIX, SKILL_INVOKE_PREFIX } from "@/lib/claude/hitl/callback-prefixes"
import { append as appendAudit } from "@/lib/db/connector-audit"
import { getDb } from "@/lib/db/schema"
import { resolveExecutingRun } from "@/lib/execution/acting-authority"
import {
  resolveBuiltInSkillRunScope,
  resolveBuiltInSkillSessionBinding,
  resolveBuiltInSkillTurnActors,
} from "@/lib/skills/built-in/context"
import type {
  BuiltInSkill,
  BuiltInSkillContext,
  BuiltInSkillResult,
} from "@/lib/skills/built-in/types"
import type { CallbackActorScope } from "@/types/connectors/interaction"
import { buildA2UISegment } from "../a2ui-bridge/a2ui-to-segments"
import { recordCallbackBinding } from "../adapters/_shared/a2ui-mapper"
import { enqueueGoverned } from "../delivery-gateway"
import { getImElicitationContext } from "./im-elicitation-context"

/** Default TTL for skill_invoke bindings — 7 days. Matches the existing pattern. */
const SKILL_INVOKE_TTL_MS = 7 * 24 * 3600 * 1000

export interface SkillConfirmationInput {
  ctx: BuiltInSkillContext & { imBinding: NonNullable<BuiltInSkillContext["imBinding"]> }
  skill: BuiltInSkill
  args: unknown
  now: number
}

/**
 * Actor scope for the pending skill_invoke binding (plan 2026-07-24 Phase 2):
 * the human whose message is driving the CURRENT turn — read from the
 * conversation's `running` inbound job — may confirm; otherwise only
 * configured operators. Keeps the confirm button from being clickable by
 * bystanders in a group.
 */
async function skillInvokeActorScope(
  conversationKey: string,
  adapterId: string,
  rootSessionId: string
): Promise<CallbackActorScope> {
  try {
    const { initiatorUserId: initiatorId } = await resolveBuiltInSkillTurnActors(
      conversationKey,
      adapterId,
      rootSessionId
    )
    return initiatorId
      ? { mode: "initiator", allowedUserIds: [initiatorId] }
      : { mode: "operators" }
  } catch {
    return { mode: "operators" }
  }
}

/** Post the confirmation card and record its two choices. Never throws. */
export async function postSkillConfirmation(
  input: SkillConfirmationInput
): Promise<BuiltInSkillResult> {
  const { ctx, skill, args, now } = input
  if (!skill.hitlSurface) {
    return {
      status: "error",
      message: `Skill "${skill.id}" requires HITL but defines no hitlSurface.`,
    }
  }
  let resolved: Awaited<ReturnType<typeof resolveBuiltInSkillSessionBinding>>
  try {
    resolved = await resolveBuiltInSkillSessionBinding(ctx.sessionId)
  } catch {
    return { status: "error", message: "Confirmation session binding could not be resolved" }
  }
  const { binding: stored, rootSessionId } = resolved
  const live = getImElicitationContext(rootSessionId)
  const signal =
    ctx.signal && live?.signal
      ? AbortSignal.any([ctx.signal, live.signal])
      : (ctx.signal ?? live?.signal)
  const target = live ?? stored
  if (
    !target ||
    target.adapterId !== ctx.imBinding.adapterId ||
    target.conversationKey !== ctx.imBinding.conversationKey ||
    (live && (live.drafting || live.signal?.aborted))
  )
    return { status: "error", message: "No active delivery target for this confirmation" }
  const conversationRef = target.deliveryTarget?.conversationRef ?? target.conversationRef
  if (!conversationRef)
    return { status: "error", message: "Confirmation delivery target is unavailable" }
  const surface = skill.hitlSurface(args as never)
  // Persist the binding so the inbound callback can re-fire the skill
  // with `hitlBypass: true`.
  const actionId = `${SKILL_INVOKE_PREFIX}${skill.id}:${cryptoRandomId()}`
  const cancelId = `${SKILL_CANCEL_PREFIX}${skill.id}:${cryptoRandomId()}`
  const scope =
    live?.actorScope ??
    (live?.initiatorUserId
      ? { mode: "initiator" as const, allowedUserIds: [live.initiatorUserId] }
      : await skillInvokeActorScope(
          ctx.imBinding.conversationKey,
          ctx.imBinding.adapterId,
          rootSessionId
        ))
  for (const [componentId, value, action] of [
    ["btn_confirm", actionId, "approve"],
    ["btn_cancel", cancelId, "cancel"],
  ] as const) {
    const node = surface.components[componentId]
    surface.components[componentId] = {
      ...(node && typeof node === "object" ? node : {}),
      component: "Button",
      text:
        node && typeof node === "object" && "text" in node
          ? node.text
          : action === "approve"
            ? "Confirm"
            : "Cancel",
      action,
      value,
    }
  }
  try {
    if (signal?.aborted) throw new Error("Confirmation request was cancelled")
    const runScope = resolveBuiltInSkillRunScope(ctx)
    const originalRun = await resolveExecutingRun(runScope.sessionId, runScope.runId)
    for (const [value, componentId, action] of [
      [actionId, "btn_confirm", "approve"],
      [cancelId, "btn_cancel", "cancel"],
    ] as const)
      await recordCallbackBinding({
        adapterId: ctx.imBinding.adapterId,
        actionId: value,
        componentId,
        kind: "skill_invoke",
        surfaceId: surface.rootId,
        conversationKey: ctx.imBinding.conversationKey,
        createdAt: now,
        expiresAt: now + SKILL_INVOKE_TTL_MS,
        payload: {
          skillId: skill.id,
          args: args as never,
          sessionId: rootSessionId,
          executionContext: {
            sessionId: ctx.sessionId,
            ...(originalRun ? { originRunId: originalRun.id } : {}),
            ...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}),
            ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
            ...(ctx.characterId ? { characterId: ctx.characterId } : {}),
          },
        },
        skillConfirmationNonce: value.slice(value.lastIndexOf(":") + 1),
        actorScope: scope,
        allowedActions: [action],
      })
    if (signal?.aborted || live?.drafting) throw new Error("Confirmation request was cancelled")
    await enqueueGoverned(
      {
        adapterId: ctx.imBinding.adapterId,
        conversationKey: ctx.imBinding.conversationKey,
        source: "skill",
        authorization: {
          kind: "system-notice",
          inboundConversationKey: ctx.imBinding.conversationKey,
        },
        request: {
          conversationRef,
          ...(target.deliveryTarget ? { deliveryTarget: target.deliveryTarget } : {}),
          segments: [buildA2UISegment(surface.rootId, surface)],
          metadata: { idempotencyKey: actionId },
        },
      },
      {
        ...(signal ? { signal } : {}),
        executionContext: {
          sessionId: runScope.sessionId,
          executionRunId: originalRun?.id ?? "",
        },
      }
    )
  } catch (error) {
    await getDb().connectorCallbackBindings.bulkDelete([
      `${ctx.imBinding.adapterId}:${actionId}`,
      `${ctx.imBinding.adapterId}:${cancelId}`,
    ])
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Confirmation card could not be queued",
    }
  }
  try {
    await appendAudit({
      adapterId: ctx.imBinding.adapterId,
      kind: "builtin_skill_hitl_pending",
      at: now,
      conversationKey: ctx.imBinding.conversationKey,
      reason: "hitl_required",
      message: `Awaiting user confirmation for ${skill.id}`,
      fields: { skillId: skill.id, mutation: skill.mutation, bindingActionId: actionId },
    })
  } catch {
    // Audit is best-effort — Dexie unavailability shouldn't break the skill.
  }
  return {
    status: "pending_hitl",
    bindingId: `${ctx.imBinding.adapterId}:${actionId}`,
    surfaceId: surface.rootId,
  }
}

function cryptoRandomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
