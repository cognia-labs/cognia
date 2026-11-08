/**
 * The IM card that confirms a room member's hand-off to a Squad (ADR-0177
 * batch 5, ADR-0252 §4).
 *
 * In an IM group bound to a character team, a member that calls
 * `room_handoff_to_squad` proposes; the proposal is the tool part on its
 * reply row, as in a desktop room. The desktop's hand-off card answers it
 * there, but the people in the group are not on the desktop: this posts the
 * same question into the group, and a press decides it through the same
 * `room-squad-handoff` port, as the person who pressed.
 *
 * Nothing waits on the card. The member's turn is over by the time it is
 * posted, and the pending decision lives on the proposal itself, so a press
 * hours later, or after a restart, still finds it. A proposal answered
 * elsewhere first (the desktop, a paired device) makes a later press report
 * that decision instead of making a second one.
 *
 * The card offers the Squad the proposal names (the member's pick, or the
 * conversation's own Squad); when it names none, one button per Squad up to
 * `ROOM_HANDOFF_CARD_SQUAD_CHOICES`, and the desktop card picks among the
 * rest.
 */

import {
  ROOM_HANDOFF_CONFIRM_PREFIX,
  ROOM_HANDOFF_DECLINE_PREFIX,
} from "@/lib/claude/hitl/callback-prefixes"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { ConversationDeliveryTarget, ConversationReference } from "@/types/connectors/event"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import type {
  RoomSquadHandoffDecideResult,
  RoomSquadHandoffPort,
} from "@/types/modules/ports/room-squad-handoff"
import type { ApprovalCardState } from "@/lib/connectors/hitl/approval-card-state"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { appendAudit } from "@/lib/connectors/audit"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import { newIdempotencyKey } from "@/types/connectors/outbound"

/** The most Squads a card offers as buttons when the proposal names none. */
export const ROOM_HANDOFF_CARD_SQUAD_CHOICES = 4

/** How much of the brief the card quotes. */
const BRIEF_EXCERPT_LIMIT = 600

export interface RoomHandoffSquadChoice {
  id: string
  name: string
}

export interface RoomHandoffSurfaceInput {
  bindingId: string
  /** The member who proposed, by name. */
  proposerName: string
  brief: string
  /** The Squads the card starts, one confirm button each, in button order. */
  choices: readonly RoomHandoffSquadChoice[]
  /** The proposal named its Squad: one button that confirms it. */
  named: boolean
  /** Squads exist beyond `choices`, so the card points at the desktop for them. */
  moreSquads: boolean
}

function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > BRIEF_EXCERPT_LIMIT
    ? `${trimmed.slice(0, BRIEF_EXCERPT_LIMIT)}…`
    : trimmed
}

/** The action id of the confirm button for `choices[index]`. */
export function roomHandoffConfirmActionId(bindingId: string, index: number): string {
  return `${ROOM_HANDOFF_CONFIRM_PREFIX}${bindingId}.${index}`
}

export function roomHandoffDeclineActionId(bindingId: string): string {
  return ROOM_HANDOFF_DECLINE_PREFIX + bindingId
}

/** Pure builder for the card. */
export function buildRoomHandoffSurface(input: RoomHandoffSurfaceInput): A2UISegmentContent {
  const title = "交给小队 / Hand off to a Squad"
  const named = input.named ? input.choices[0] : undefined
  const lead = named
    ? `${input.proposerName} 建议把这项工作交给小队“${named.name}”。 / ${input.proposerName} proposes handing this work to the Squad "${named.name}".`
    : `${input.proposerName} 建议把这项工作交给一个小队，请选择。 / ${input.proposerName} proposes handing this work to a Squad: pick one.`
  const notes = [
    ...(input.choices.length === 0
      ? [
          "还没有小队：请先在桌面端创建一个。 / There are no Squads yet: create one on the desktop first.",
        ]
      : []),
    ...(input.moreSquads
      ? ["其他小队请在桌面端选择。 / Pick any other Squad on the desktop."]
      : []),
  ]
  const prompt = [lead, `任务 / Brief: ${excerpt(input.brief)}`, ...notes].join("\n")
  const buttons = [
    ...input.choices.map((choice, index) => ({
      id: `confirm${index}`,
      text: named ? "确认 / Confirm" : `交给 ${choice.name} / Start ${choice.name}`,
      action: "approve",
      value: roomHandoffConfirmActionId(input.bindingId, index),
    })),
    {
      id: "decline",
      text: "拒绝 / Decline",
      action: "cancel",
      value: roomHandoffDeclineActionId(input.bindingId),
    },
  ]
  const components: Record<string, unknown> = {
    root: { component: "Card", title, children: ["prompt", "actions"] },
    prompt: { component: "Text", text: prompt },
    actions: { component: "Row", children: buttons.map((button) => button.id) },
  }
  for (const button of buttons) {
    components[button.id] = {
      component: "Button",
      text: button.text,
      action: button.action,
      value: button.value,
    }
  }
  const hint = buttons.map((button, index) => `${index + 1} ${button.text}`).join(" / ")
  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: {
      fallbackText: [
        `# ${title}`,
        prompt,
        buttons.map((button) => `[${button.text}]`).join(" "),
        `回复 / Reply: ${hint}`,
      ].join("\n"),
    },
  }
}

export interface PostRoomHandoffCardInput {
  roomId: string
  /** The proposal: the member's tool call id. */
  toolUseId: string
  proposerId: string
  proposerName: string
  brief: string
  /** The Squad the proposal names, when it names one. */
  squadId?: string
  /** Every Squad this host can start. */
  squads: readonly RoomHandoffSquadChoice[]
  adapterId: string
  conversationKey: string
  conversationRef: ConversationReference
  deliveryTarget?: ConversationDeliveryTarget
  /** remoteUserId of the person whose message the room answered. */
  initiatorUserId?: string
  now?: number
  // Injectable for tests.
  enqueue?: typeof enqueueOutbound
  recordBinding?: typeof recordCallbackBinding
  audit?: typeof appendAudit
}

/** The Squads the card offers, and whether the proposal names one. */
export function roomHandoffCardChoices(
  squads: readonly RoomHandoffSquadChoice[],
  squadId: string | undefined
): { choices: RoomHandoffSquadChoice[]; named: boolean; moreSquads: boolean } {
  const proposed = squadId ? squads.find((squad) => squad.id === squadId) : undefined
  if (proposed) return { choices: [proposed], named: true, moreSquads: false }
  return {
    choices: squads.slice(0, ROOM_HANDOFF_CARD_SQUAD_CHOICES),
    named: false,
    moreSquads: squads.length > ROOM_HANDOFF_CARD_SQUAD_CHOICES,
  }
}

/** Record one binding per button and deliver the card. Throws when either fails. */
export async function postRoomHandoffCard(
  input: PostRoomHandoffCardInput
): Promise<{ surfaceId: string }> {
  const enqueue = input.enqueue ?? enqueueOutbound
  const recordBinding = input.recordBinding ?? recordCallbackBinding
  const audit = input.audit ?? appendAudit
  const bindingId = newIdempotencyKey().slice(0, 8)
  const surfaceId = `room_handoff:${input.conversationKey}:${bindingId}`
  const { choices, named, moreSquads } = roomHandoffCardChoices(input.squads, input.squadId)
  const surface = buildRoomHandoffSurface({
    bindingId,
    proposerName: input.proposerName,
    brief: input.brief,
    choices,
    named,
    moreSquads,
  })
  // The person the room answered decides, as on the tool and plan cards; a
  // configured operator when the platform gave no stable user id.
  const actorScope = input.initiatorUserId
    ? { mode: "initiator" as const, allowedUserIds: [input.initiatorUserId] }
    : { mode: "operators" as const }
  const base = { roomId: input.roomId, toolUseId: input.toolUseId }
  const buttons = [
    ...choices.map((choice, index) => ({
      actionId: roomHandoffConfirmActionId(bindingId, index),
      componentId: `confirm${index}`,
      payload: { ...base, decision: "confirm", squadId: choice.id },
      allowedActions: ["approve"],
    })),
    {
      actionId: roomHandoffDeclineActionId(bindingId),
      componentId: "decline",
      payload: { ...base, decision: "decline" },
      allowedActions: ["cancel"],
    },
  ]
  await Promise.all(
    buttons.map((button) =>
      recordBinding({
        adapterId: input.adapterId,
        actionId: button.actionId,
        surfaceId,
        componentId: button.componentId,
        conversationKey: input.conversationKey,
        kind: "room_handoff",
        payload: button.payload,
        actorScope,
        allowedActions: button.allowedActions,
      })
    )
  )
  await enqueue({
    adapterId: input.adapterId,
    conversationKey: input.conversationKey,
    request: {
      conversationRef: input.conversationRef,
      ...(input.deliveryTarget ? { deliveryTarget: input.deliveryTarget } : {}),
      segments: [buildA2UISegment(surfaceId, surface)],
      metadata: { idempotencyKey: `room-handoff-card:${input.roomId}:${input.toolUseId}` },
    },
    source: "ai-run",
    authorization: { kind: "system-notice", inboundConversationKey: input.conversationKey },
  })
  await audit({
    adapterId: input.adapterId,
    kind: "room.handoff_requested",
    at: input.now ?? Date.now(),
    conversationKey: input.conversationKey,
    fields: {
      roomId: input.roomId,
      toolUseId: input.toolUseId,
      proposerId: input.proposerId,
      choices: choices.map((choice) => choice.id),
    },
  })
  return { surfaceId }
}

/** What a press asks for, read off its binding. `null` for a binding that is no such press. */
export function roomHandoffPressOf(binding: Pick<ConnectorCallbackBindingRow, "payload">): {
  roomId: string
  toolUseId: string
  decision: "confirm" | "decline"
  squadId?: string
} | null {
  const payload = binding.payload ?? {}
  const roomId = typeof payload.roomId === "string" ? payload.roomId : ""
  const toolUseId = typeof payload.toolUseId === "string" ? payload.toolUseId : ""
  const decision = payload.decision
  if (!roomId || !toolUseId || (decision !== "confirm" && decision !== "decline")) return null
  const squadId =
    typeof payload.squadId === "string" && payload.squadId ? payload.squadId : undefined
  return { roomId, toolUseId, decision, ...(squadId ? { squadId } : {}) }
}

export interface HandleRoomHandoffCallbackInput {
  binding: Pick<ConnectorCallbackBindingRow, "payload">
  /** The press was a decline (its binding, or a dismissed card). */
  cancelled: boolean
  adapterId: string
  conversationKey?: string
  /** The person who pressed, as the platform names them. */
  remoteUserId?: string
  now?: number
  // Injectable for tests.
  loadDecider?: () => Promise<RoomSquadHandoffPort | null>
  audit?: typeof appendAudit
}

export interface RoomHandoffCallbackOutcome {
  result: RoomSquadHandoffDecideResult
  /** How the card closes, and the line it shows. */
  state: ApprovalCardState
  detail: string
}

async function loadRoomSquadHandoff(): Promise<RoomSquadHandoffPort | null> {
  const { loadPort } = await import("@/lib/modules/ports")
  return loadPort("room-squad-handoff")
}

const REFUSAL_TEXT: Record<Extract<RoomSquadHandoffDecideResult, { ok: false }>["reason"], string> =
  {
    room_not_found: "这个群不再由本 Host 运行。 / This group is not run on this Host any more.",
    proposal_not_found: "找不到这条提议。 / This proposal is gone.",
    squad_required: "请先选择一个小队。 / Pick a Squad first.",
    squad_not_found: "这个小队已不存在。 / That Squad no longer exists.",
    write_failed: "记录决定失败，请重试。 / The decision could not be saved; try again.",
  }

/** The card's closing state and line for a decision, or a refusal. */
export function roomHandoffCardOutcome(result: RoomSquadHandoffDecideResult): {
  state: ApprovalCardState
  detail: string
} {
  if (!result.ok) return { state: "failed", detail: REFUSAL_TEXT[result.reason] }
  const { decision } = result
  const already = result.already ? "（此前已决定 / decided earlier）" : ""
  switch (decision.status) {
    case "declined":
      return { state: "denied", detail: `已拒绝 / Declined${already}` }
    case "failed":
      return {
        state: "failed",
        detail: `小队未能启动 / The Squad run did not start: ${decision.reason}${already}`,
      }
    case "started":
      return {
        state: "approved",
        detail: `已交给 ${decision.squadName}，完成后会回到群里。 / Handed to ${decision.squadName}; its result comes back to this group.${already}`,
      }
  }
}

/** Decide one press. Never throws: a refusal closes the card as failed. */
export async function handleRoomHandoffCallback(
  input: HandleRoomHandoffCallbackInput
): Promise<RoomHandoffCallbackOutcome> {
  const audit = input.audit ?? appendAudit
  const press = roomHandoffPressOf(input.binding)
  let result: RoomSquadHandoffDecideResult
  if (!press) {
    result = { ok: false, reason: "proposal_not_found" }
  } else {
    const port = await (input.loadDecider ?? loadRoomSquadHandoff)().catch(() => null)
    const decision = input.cancelled ? "decline" : press.decision
    result = port
      ? await port
          .decide(
            {
              roomId: press.roomId,
              toolUseId: press.toolUseId,
              decision,
              ...(decision === "confirm" && press.squadId ? { squadId: press.squadId } : {}),
            },
            {
              kind: "im",
              adapterId: input.adapterId,
              ...(input.remoteUserId ? { remoteUserId: input.remoteUserId } : {}),
            }
          )
          .catch((): RoomSquadHandoffDecideResult => ({ ok: false, reason: "write_failed" }))
      : { ok: false, reason: "room_not_found" }
  }
  await audit({
    adapterId: input.adapterId,
    kind: "room.handoff_decided",
    at: input.now ?? Date.now(),
    ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}),
    fields: {
      ...(press ? { roomId: press.roomId, toolUseId: press.toolUseId } : {}),
      decision: input.cancelled ? "decline" : (press?.decision ?? "unknown"),
      outcome: result.ok ? result.decision.status : result.reason,
      ...(result.ok && result.already ? { already: true } : {}),
    },
  }).catch(() => undefined)
  return { result, ...roomHandoffCardOutcome(result) }
}
