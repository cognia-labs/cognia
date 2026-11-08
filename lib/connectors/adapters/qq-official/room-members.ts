/**
 * A QQ group's roster (ADR-0177 batch 4), read through the members
 * management family the adapter already exposes (`members.list`).
 *
 * The management client spaces every group call 2.1 s apart, so the read is
 * held to a few pages: a long group lands as a `partial` list well inside the
 * roster's read timeout instead of being abandoned with nothing stored.
 */

import type { ConnectorManagement } from "@/types/connectors/management"
import type { RoomMemberRead, RoomMemberReadOptions } from "@/types/connectors/room-members"
import { collectRoomMemberPages } from "../_shared/room-member-pages"

/** Pages read per roster refresh; five spaced calls finish in about 10.5 s. */
export const QQ_ROSTER_MAX_PAGES = 5

export function readQQRoomMembers(
  management: Pick<ConnectorManagement, "execute">,
  groupOpenId: string,
  options: RoomMemberReadOptions
): Promise<RoomMemberRead> {
  return collectRoomMemberPages(
    async (cursor) => {
      const result = await management.execute({
        operation: "members.list",
        input: { chatId: groupOpenId, ...(cursor ? { cursor } : {}) },
      })
      return {
        members: (result.items ?? []).flatMap((item) => {
          const id = item.member_openid
          if (typeof id !== "string" || !id) return []
          const role = item.member_role
          return [
            {
              remoteUserId: id,
              ...(typeof item.username === "string" && item.username
                ? { displayName: item.username }
                : {}),
              ...(role === "owner" || role === "admin" || role === "member" ? { role } : {}),
              ...(item.bot === true ? { isBot: true } : {}),
            },
          ]
        }),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        ...(typeof result.total === "number" ? { total: result.total } : {}),
      }
    },
    options,
    QQ_ROSTER_MAX_PAGES
  )
}
