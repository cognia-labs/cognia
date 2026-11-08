/**
 * The roster projection: who is in a room, read from whichever membership
 * source the room's kind keeps, merged with whoever has actually spoken.
 *
 * # Why a projection and not a table
 *
 * Team rooms already have `Team.members`, shared rooms already mirror the
 * server's `collabChatMemberships`, and an IM group keeps the member list its
 * platform last reported on the conversation's override row (batch 4,
 * `lib/connectors/room-roster.ts`). A fourth table would be a second writer
 * for all three. Deriving the list keeps every plane's own store
 * authoritative and gives the chip, the prompt roster and the composer's `@`
 * completion one answer.
 *
 * # An IM member is matched by the platform's user id
 *
 * A message's speaker id is the local platform identity row (`pid_…`), while
 * the platform lists members by its own user id. The projection reads each
 * observed sender's `remoteUserId` and gives a listed member who has spoken
 * that sender's id, so one person is one row whichever side saw them first. A
 * listed member who has not spoken keeps an id built from the platform's.
 *
 * # Completeness is part of the answer
 *
 * A roster the UI cannot vouch for is worse than none: a Telegram group
 * whose only known members are the ones who have spoken must not render as a
 * three-person room. Every projection therefore says how it knows.
 */

import type { Character, TeamMember } from "@cognia/agent-config-types"
import type { SessionMembership } from "@cognia/agent-config-types/collaboration"
import {
  collectRoomParticipants,
  mergeRoomParticipants,
  type RoomParticipant,
} from "@/lib/chat/room-roster"
import { makeSpeaker, type SpeakerContext, type SpeakerSource } from "@/lib/chat/speaker"
import type { RoomMember } from "@/types/connectors/room-members"
import type { RoomKind, RoomRosterCompleteness } from "./types"

export type { RoomRosterCompleteness } from "./types"

export type { RoomParticipant } from "@/lib/chat/room-roster"

export interface RoomRosterProjection {
  participants: RoomParticipant[]
  completeness: RoomRosterCompleteness
  /** Ids the declared source named, whether or not they have spoken. */
  declaredIds: ReadonlySet<string>
  /**
   * The whole room's size when the platform reported one larger than what it
   * listed (a `partial` IM roster). Absent when `participants` is the room.
   */
  memberCount?: number
}

/** An IM room's roster as the conversation's override row keeps it. */
export interface ImRoomRosterInput {
  tier: "full" | "partial"
  members: readonly RoomMember[]
  memberCount?: number
}

export interface ProjectRoomParticipantsInput {
  kind: RoomKind | null
  /** Team rooms: the resolved characters, in the team's reply order. */
  characters?: readonly Pick<Character, "id" | "name">[]
  /** Team rooms: the member slots, for the role label. */
  members?: readonly Pick<TeamMember, "characterId" | "role">[]
  /** Shared rooms: the server's membership rows. */
  memberships?: readonly Pick<SessionMembership, "userId" | "role" | "guest" | "displayName">[]
  /** IM rooms: the member list the platform last reported, when it can list one. */
  imRoster?: ImRoomRosterInput | null
  /** Every message in the room, oldest first. */
  messages?: readonly SpeakerSource[]
  /** The participant this projection is built for (marks `isSelf`). */
  selfId?: string
  ctx?: SpeakerContext
}

export function projectRoomParticipants(input: ProjectRoomParticipantsInput): RoomRosterProjection {
  const declared = declaredParticipants(input)
  const observed = collectRoomParticipants(input.messages ?? [], input.ctx)
  const merged = mergeRoomParticipants(declared, observed).map((participant) =>
    input.selfId && participant.speaker.id === input.selfId
      ? { ...participant, isSelf: true }
      : participant
  )
  const completeness = completenessFor(input.kind, declared.length, input.imRoster?.tier)
  const memberCount =
    completeness === "partial" && input.imRoster?.memberCount !== undefined
      ? input.imRoster.memberCount
      : undefined
  return {
    participants: merged,
    completeness,
    declaredIds: new Set(declared.map((participant) => participant.speaker.id)),
    ...(memberCount !== undefined && memberCount > merged.length ? { memberCount } : {}),
  }
}

function declaredParticipants(input: ProjectRoomParticipantsInput): RoomParticipant[] {
  switch (input.kind) {
    case "team": {
      const roleById = new Map(
        (input.members ?? []).flatMap((slot) =>
          slot.role?.trim() ? [[slot.characterId, slot.role.trim()] as const] : []
        )
      )
      return (input.characters ?? []).map((character) => ({
        speaker: makeSpeaker("agent", character.id, character.name),
        ...(roleById.has(character.id) ? { role: roleById.get(character.id) } : {}),
      }))
    }
    case "shared":
      return (input.memberships ?? []).map((membership) => ({
        speaker: makeSpeaker(
          membership.guest ? "guest" : "human",
          membership.userId,
          membership.displayName
        ),
        role: membership.role,
      }))
    case "im":
      return imDeclaredParticipants(input.imRoster, input.messages ?? [])
    case null:
    default:
      return []
  }
}

/** The id a listed IM member who has not spoken yet goes by. */
export function imRosterMemberId(remoteUserId: string): string {
  return `im-member:${remoteUserId}`
}

function imDeclaredParticipants(
  roster: ImRoomRosterInput | null | undefined,
  messages: readonly SpeakerSource[]
): RoomParticipant[] {
  if (!roster || roster.members.length === 0) return []
  const spoken = observedSendersByRemoteId(messages)
  const seen = new Set<string>()
  const participants: RoomParticipant[] = []
  for (const member of roster.members) {
    if (!member.remoteUserId || seen.has(member.remoteUserId)) continue
    seen.add(member.remoteUserId)
    const sender = spoken.get(member.remoteUserId)
    const kind = member.isBot ? "app" : "human"
    participants.push({
      speaker: makeSpeaker(
        kind,
        sender?.id ?? imRosterMemberId(member.remoteUserId),
        member.displayName ?? sender?.displayName
      ),
      ...(member.role === "owner" || member.role === "admin" ? { role: member.role } : {}),
    })
  }
  return participants
}

/** Each IM sender in `messages`, keyed by the platform's own user id; the newest name wins. */
function observedSendersByRemoteId(
  messages: readonly SpeakerSource[]
): Map<string, { id: string; displayName?: string }> {
  const byRemoteId = new Map<string, { id: string; displayName?: string }>()
  for (const message of messages) {
    const platformMessage = message.metadata?.platformMessage
    if (!platformMessage || typeof platformMessage !== "object") continue
    const sender = (platformMessage as { sender?: unknown }).sender
    if (!sender || typeof sender !== "object") continue
    const { id, remoteUserId, displayName } = sender as Record<string, unknown>
    if (typeof id !== "string" || !id || typeof remoteUserId !== "string" || !remoteUserId) continue
    byRemoteId.set(remoteUserId, {
      id,
      ...(typeof displayName === "string" && displayName ? { displayName } : {}),
    })
  }
  return byRemoteId
}

/**
 * Team and shared rosters are declared in full by their own store. An IM
 * group is as complete as its platform's last read said (`chat.members.read`:
 * `full` lists everyone, `partial` only a count and the admins, or a list
 * that was cut), and observed when the platform cannot list members or has
 * not been read yet. A `full` IM read that listed nobody is no roster.
 */
export function completenessFor(
  kind: RoomKind | null,
  declaredCount: number,
  imTier?: "full" | "partial"
): RoomRosterCompleteness {
  if (kind === "team" || kind === "shared") return declaredCount > 0 ? "full" : "observed"
  if (kind === "im" && imTier === "partial") return "partial"
  if (kind === "im" && imTier === "full" && declaredCount > 0) return "full"
  return "observed"
}
