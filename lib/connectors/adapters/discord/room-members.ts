/**
 * A Discord channel's roster (ADR-0177 batch 4).
 *
 * Listing a guild's members needs the privileged `GUILD_MEMBERS` intent, and
 * a guild's members are not a channel's anyway: who can read a channel is
 * decided by its permission overwrites. The guild owner can access the
 * channel, but the API does not provide a channel membership count.
 */

import type { RoomMemberRead, RoomMemberReadOptions } from "@/types/connectors/room-members"

export type DiscordRosterRequest = (method: "GET", path: string) => Promise<unknown>

interface DiscordGuild {
  owner_id?: string
}

export async function readDiscordRoomMembers(
  request: DiscordRosterRequest,
  guildId: string | undefined,
  options: RoomMemberReadOptions
): Promise<RoomMemberRead> {
  if (!guildId) throw new Error("Discord roster read needs the conversation's guild id")
  const guild = ((await request("GET", `/guilds/${encodeURIComponent(guildId)}`)) ??
    {}) as DiscordGuild
  options.signal?.throwIfAborted()
  return {
    tier: "partial",
    members:
      guild.owner_id && options.maxMembers >= 1
        ? [{ remoteUserId: guild.owner_id, role: "owner" }]
        : [],
  }
}
