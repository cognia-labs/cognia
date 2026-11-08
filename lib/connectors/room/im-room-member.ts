/**
 * What one member of an IM group's character team is given, and what its
 * reply leaves behind (ADR-0177 batch 4).
 *
 * A member runs fresh each step, as `RoomRunner`'s members do: nothing of
 * the IM session's native conversation is resumed, because that conversation
 * belongs to whoever answered the group before, and a persona must not
 * continue another persona's thread as its own. The room's history reaches
 * the member as the team transcript instead, the same renderer the chat
 * plane uses, which already names group members as speakers.
 *
 * That transcript is built from what people wrote in the group, so each line
 * passes the gates the connector's group-context block applies: the
 * injection inspection for external text, then redaction, then the PII
 * check. A line that fails is withheld rather than dropped, so the member
 * still sees that somebody spoke.
 */

import type { Character, Team, TeamMember } from "@cognia/agent-config-types"
import { hasNoLeakingPii, redactText } from "@cognia/redact"
import type { StoredMessage } from "@cognia/agent-config-types"
import { buildRoomInstructionsSection } from "@/lib/chat/room/settings"
import { buildTeamTranscript, type TeamTranscriptMessage } from "@/lib/chat/team-transcript"
import { stripInboundDisplayMarkers } from "@/lib/db/inbound-stored-parts"
import { inspectConnectorText } from "@/lib/connectors/content-safety"
import type { ImRoomStep } from "./im-room-turn"

/** What a withheld line reads as. Phrased for the model, like the media marker. */
export const IM_ROOM_WITHHELD_LINE = "[message withheld: it could not be shared with the model]"

/** The metadata a member's reply row carries so a replay can find it. */
export interface ImRoomReplyMetadata {
  senderId: string
  imRoomTurn: {
    sourceMessageId: string
    stepKey: string
    kind: ImRoomStep["kind"]
    /**
     * What the member wrote, room protocol included (`<dispatch>`, the stop
     * token), when that differs from the stored text. A replay feeds this to
     * the planner, which decides the next steps from the protocol.
     */
    protocolText?: string
  }
}

export interface ImRoomMemberSectionInput {
  step: Pick<ImRoomStep, "character" | "promptAddendum">
  team: Pick<Team, "members" | "maxAutoRounds">
  characters: readonly Character[]
  /** The room session's rows, oldest first. */
  messages: readonly StoredMessage[]
  scratchpad?: string | undefined
  /** `roomSettings.instructions`, already resolved. */
  instructions: string
  /** The adapter's prompt-injection protection (`connectorInjectionProtection`). */
  protection: boolean
}

/**
 * The system-prompt section one member step adds: the step's own addendum
 * (the supervisor's roster, a synthesis), the room's instructions, then the
 * transcript. Joined the way `RoomRunner` joins them.
 */
export function buildImRoomMemberSection(input: ImRoomMemberSectionInput): string {
  const { step, team, characters } = input
  const slots = new Map<string, TeamMember>(team.members.map((slot) => [slot.characterId, slot]))
  const members = team.members.flatMap((slot) => {
    const character = characters.find((candidate) => candidate.id === slot.characterId)
    return character ? [{ id: character.id, name: character.name, role: slot.role }] : []
  })
  const handoffTargets = slots.get(step.character.id)?.handoffTargets
  const transcript = buildTeamTranscript({
    messages: sanitizeRoomMessages(input.messages, input.protection),
    respondingCharacterId: step.character.id,
    members,
    scratchpad: input.scratchpad,
    handoffEnabled: (team.maxAutoRounds ?? 0) > 0,
    handoffTargetNames: handoffTargets
      ? handoffTargets.flatMap((id) => {
          const target = members.find((member) => member.id === id)
          return target ? [target.name] : []
        })
      : undefined,
  })
  return [step.promptAddendum, buildRoomInstructionsSection(input.instructions), transcript]
    .filter((part) => part && part.trim())
    .join("\n\n---\n\n")
}

/**
 * The room's rows as the transcript may show them. A deleted row is left
 * out; every other row keeps its speaker and loses whatever the gates refuse.
 */
export function sanitizeRoomMessages(
  messages: readonly StoredMessage[],
  protection: boolean
): TeamTranscriptMessage[] {
  const out: TeamTranscriptMessage[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue
    const metadata = (message.metadata ?? {}) as Record<string, unknown>
    if (metadata.deletedAt !== undefined) continue
    // People wrote the user rows; the members' own replies are ours, so they
    // are redacted but not inspected as external content.
    const source = message.role === "user" ? "external" : null
    const text = safeText(plainTextOf(message.parts), protection, source)
    const replyTo = metadata.replyTo as { preview?: unknown } | undefined
    const preview =
      replyTo && typeof replyTo.preview === "string"
        ? safeText(replyTo.preview, protection, source)
        : undefined
    const { replyTo: _replyTo, ...rest } = metadata
    out.push({
      role: message.role,
      parts: [{ type: "text", text: text ?? IM_ROOM_WITHHELD_LINE }],
      metadata: {
        ...rest,
        ...(replyTo ? { replyTo: { ...replyTo, preview: preview ?? IM_ROOM_WITHHELD_LINE } } : {}),
      },
    } as TeamTranscriptMessage)
  }
  return out
}

function plainTextOf(parts: StoredMessage["parts"]): string {
  return parts
    .flatMap((part) =>
      part.type === "text" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : []
    )
    .join("\n")
}

/** The gated text, or `null` when it may not reach the model. Empty stays empty. */
function safeText(text: string, protection: boolean, source: "external" | null): string | null {
  const flat = stripInboundDisplayMarkers(text).trim()
  if (!flat) return ""
  if (source && inspectConnectorText(flat, protection, source).action !== "allow") return null
  const redacted = redactText(flat).redacted
  return redacted && hasNoLeakingPii(redacted) ? redacted : null
}

/**
 * A member's reply as the group reads it. Every reply leaves through the
 * same bot, so the member's name leads it; the bold is the markdown every
 * adapter already renders for model output.
 */
export function signImRoomReply(name: string, text: string): string {
  const label = name.trim()
  if (!label) return text
  return text.trim() ? `**${label}**\n\n${text}` : `**${label}**`
}

/**
 * The reply a step already left in the room, if a replay of the same inbound
 * message reaches it again: same message, same step, same member.
 */
export function deliveredImRoomStep(
  messages: readonly StoredMessage[],
  sourceMessageId: string,
  step: Pick<ImRoomStep, "stepKey" | "character">
): StoredMessage | undefined {
  return messages.find((message) => {
    if (message.role !== "assistant") return false
    const metadata = message.metadata as Partial<ImRoomReplyMetadata> | undefined
    return (
      metadata?.imRoomTurn?.sourceMessageId === sourceMessageId &&
      metadata.imRoomTurn.stepKey === step.stepKey &&
      metadata.senderId === step.character.id
    )
  })
}

/** What a stored member reply said, protocol included, for feeding a replayed step back to the planner. */
export function storedReplyText(message: StoredMessage): string {
  const protocolText = (message.metadata as Partial<ImRoomReplyMetadata> | undefined)?.imRoomTurn
    ?.protocolText
  return typeof protocolText === "string" ? protocolText : plainTextOf(message.parts)
}
