/**
 * Paging for `PlatformAdapter.readRoomMembers` (ADR-0177 batch 4).
 *
 * Each platform pages its member list its own way (a page token, a cursor,
 * one call for everything). The rules for turning those pages into one
 * `RoomMemberRead` are the same everywhere, so they live here: stop once the
 * caller's limit is reached or the page budget is spent, drop repeats, honour
 * the abort signal between pages, and call the read `partial` whenever it did
 * not reach the end of the list or the platform's own total says more members
 * exist than were listed.
 */

import type {
  RoomMember,
  RoomMemberRead,
  RoomMemberReadOptions,
} from "@/types/connectors/room-members"

export interface RoomMemberPage {
  members: readonly RoomMember[]
  /** Where the next page starts; absent on the last page. */
  nextCursor?: string
  /** The platform's count of the whole room, when it reports one. */
  total?: number
}

/** Pages read before a long room is reported as `partial`. */
export const MAX_ROOM_MEMBER_PAGES = 20

export async function collectRoomMemberPages(
  fetchPage: (cursor: string | undefined) => Promise<RoomMemberPage>,
  options: RoomMemberReadOptions,
  maxPages: number = MAX_ROOM_MEMBER_PAGES
): Promise<RoomMemberRead> {
  const limit = Math.max(0, Math.floor(options.maxMembers))
  const members: RoomMember[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let total: number | undefined
  let reachedEnd = false
  for (let page = 0; page < maxPages && members.length < limit; page += 1) {
    options.signal?.throwIfAborted()
    const result = await fetchPage(cursor)
    if (typeof result.total === "number" && Number.isFinite(result.total)) total = result.total
    for (const member of result.members) {
      if (!member.remoteUserId || seen.has(member.remoteUserId)) continue
      seen.add(member.remoteUserId)
      members.push(member)
    }
    if (!result.nextCursor || result.nextCursor === cursor) {
      reachedEnd = true
      break
    }
    cursor = result.nextCursor
  }
  const kept = members.slice(0, limit)
  const known = Math.max(total ?? 0, members.length)
  if (reachedEnd && members.length <= limit && (total === undefined || total <= kept.length)) {
    return { tier: "full", members: kept }
  }
  return { tier: "partial", members: kept, ...(known > kept.length ? { memberCount: known } : {}) }
}
