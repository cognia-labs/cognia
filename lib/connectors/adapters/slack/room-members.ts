/**
 * A Slack channel's roster (ADR-0177 batch 4).
 *
 * `conversations.members` pages every member's user id. It carries no names,
 * and a `users.info` call per member would spend a rate-limited call on each
 * person in the room, so the roster lists ids: the projection takes a name
 * from that member's own messages, and a member who has not spoken reads as
 * the stable pseudonym every unnamed speaker gets.
 */

import type { RoomMemberRead, RoomMemberReadOptions } from "@/types/connectors/room-members"
import { collectRoomMemberPages } from "../_shared/room-member-pages"

export type SlackRosterRequest = (method: "GET", path: string) => Promise<unknown>

/** Slack's recommended largest page. */
const SLACK_MEMBER_PAGE_SIZE = 200

interface SlackMembersPage {
  members?: unknown
  response_metadata?: { next_cursor?: string }
}

export function readSlackRoomMembers(
  request: SlackRosterRequest,
  channelId: string,
  options: RoomMemberReadOptions
): Promise<RoomMemberRead> {
  return collectRoomMemberPages(async (cursor) => {
    const query = new URLSearchParams({
      channel: channelId,
      limit: String(Math.min(SLACK_MEMBER_PAGE_SIZE, Math.max(1, options.maxMembers))),
      ...(cursor ? { cursor } : {}),
    })
    const page = ((await request("GET", `conversations.members?${query.toString()}`)) ??
      {}) as SlackMembersPage
    const ids = Array.isArray(page.members) ? page.members : []
    const next = page.response_metadata?.next_cursor
    return {
      members: ids.flatMap((id) => (typeof id === "string" && id ? [{ remoteUserId: id }] : [])),
      ...(next ? { nextCursor: next } : {}),
    }
  }, options)
}
