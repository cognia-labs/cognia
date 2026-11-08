/**
 * A Discord channel's roster (ADR-0177 batch 4).
 *
 * Listing a guild's members needs the privileged `GUILD_MEMBERS` intent, and
 * a guild's members are not a channel's anyway: who can read a channel is
 * decided by its permission overwrites. What a bot can always read is the
 * guild's owner and its approximate size, so the read is `partial`: the owner
 * and the count, never a list that pretends to be the channel.
 */

import type { RoomMemberRead, RoomMemberReadOptions } from "@/types/connectors/room-members"

export type DiscordRosterRequest = (method: "GET", path: string) => Promise<unknown>

interface DiscordGuildWithCounts {
  owner_id?: string
  approximate_member_count?: number
}

export async function readDiscordRoomMembers(
  request: DiscordRosterRequest,
  guildId: string | undefined,
  options: RoomMemberReadOptions
): Promise<RoomMemberRead> {
  if (!guildId) throw new Error("Discord roster read needs the conversation's guild id")
  const guild = ((await request(
    "GET",
    `/guilds/${encodeURIComponent(guildId)}?with_counts=true`
  )) ?? {}) as DiscordGuildWithCounts
  options.signal?.throwIfAborted()
  const count = guild.approximate_member_count
  return {
    tier: "partial",
    members:
      guild.owner_id && options.maxMembers >= 1
        ? [{ remoteUserId: guild.owner_id, role: "owner" }]
        : [],
    ...(typeof count === "number" && Number.isFinite(count) ? { memberCount: count } : {}),
  }
}
