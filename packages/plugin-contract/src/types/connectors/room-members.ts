/**
 * Who is in an IM conversation, as the platform can tell (ADR-0177 batch 4,
 * ADR-0252 §6). The return shape of the OPTIONAL `PlatformAdapter` method
 * `readRoomMembers`, paired with the `chat.members.read` capability.
 *
 * A roster the UI cannot vouch for is worse than none, so every read says how
 * much it knows:
 *   - `full`: the platform listed every member.
 *   - `partial`: the platform gave only a member count and/or its admins
 *     (Telegram, Discord), or the list was longer than the caller's limit and
 *     was cut. `members` is what is known; `memberCount`, when present, is the
 *     whole room.
 * A platform with no member API does not implement the method at all, and its
 * rooms stay `observed` (only whoever has spoken is listed).
 */

/** One member of an IM conversation as its platform lists it. */
export interface RoomMember {
  /** The platform's own user id, the same one inbound events carry. */
  remoteUserId: string
  displayName?: string
  role?: RoomMemberRole
  isBot?: boolean
}

export type RoomMemberRole = "owner" | "admin" | "member"

export type RoomMemberRead =
  | { tier: "full"; members: RoomMember[] }
  | { tier: "partial"; members: RoomMember[]; memberCount?: number }

export interface RoomMemberReadOptions {
  /**
   * The most members the caller keeps. An adapter stops paging once it has
   * read this many and reports the read as `partial`.
   */
  maxMembers: number
  signal?: AbortSignal
}

/**
 * Hold a read to the caller's limit: a `full` list longer than `maxMembers`
 * becomes a `partial` one of that length with the true count, so no adapter
 * has to repeat the rule and no caller can be handed more than it asked for.
 */
export function clampRoomMemberRead(read: RoomMemberRead, maxMembers: number): RoomMemberRead {
  const limit = Math.max(0, Math.floor(maxMembers))
  if (read.members.length <= limit) return read
  const memberCount =
    read.tier === "partial" && read.memberCount !== undefined
      ? Math.max(read.memberCount, read.members.length)
      : read.members.length
  return { tier: "partial", members: read.members.slice(0, limit), memberCount }
}
