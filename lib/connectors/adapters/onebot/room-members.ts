/**
 * A OneBot group's roster (ADR-0177 batch 4).
 *
 * `get_group_member_list` is a standard action in both v11 and v12 and
 * answers the whole group in one response, so the read is `full` unless the
 * group is longer than the caller keeps. v11 names the owner and admins; v12
 * defines no role field.
 */

import type {
  RoomMember,
  RoomMemberRead,
  RoomMemberReadOptions,
} from "@/types/connectors/room-members"
import { clampRoomMemberRead } from "@/types/connectors/room-members"
import type { SerializedOneBotCall } from "./serialize"
import { assertOneBotSuccess, type OneBotTransport } from "./transport"

/** A member list of a 3000-person group still answers well inside this. */
const ONEBOT_ROSTER_TIMEOUT_MS = 12_000

export interface OneBotRosterInput {
  send: OneBotTransport["send"]
  variant: "v11" | "v12"
  /** The v12 account selector, for a connection that carries several bots. */
  self?: SerializedOneBotCall["self"]
  adapterId: string
  groupId: string
}

export async function readOneBotRoomMembers(
  input: OneBotRosterInput,
  options: RoomMemberReadOptions
): Promise<RoomMemberRead> {
  const v11 = input.variant === "v11"
  const groupId = v11 ? Number(input.groupId) : input.groupId
  if (v11 && !Number.isSafeInteger(groupId)) {
    throw new Error(`OneBot group id must be numeric (got "${input.groupId}")`)
  }
  const call: SerializedOneBotCall = {
    action: "get_group_member_list",
    params: { group_id: groupId },
    echo: `${input.adapterId}:roster:${Date.now()}`,
    ...(!v11 && input.self ? { self: input.self } : {}),
  }
  const response = await input.send(call, ONEBOT_ROSTER_TIMEOUT_MS)
  assertOneBotSuccess(response, call.action)
  options.signal?.throwIfAborted()
  const rows = Array.isArray(response.data) ? response.data : []
  const members = rows.flatMap((row): RoomMember[] => {
    if (!row || typeof row !== "object") return []
    const entry = row as Record<string, unknown>
    const userId = entry.user_id
    if ((typeof userId !== "number" && typeof userId !== "string") || userId === "") return []
    const name = v11
      ? firstText(entry.card, entry.nickname)
      : firstText(entry.user_displayname, entry.user_name)
    const role = entry.role
    return [
      {
        remoteUserId: String(userId),
        ...(name ? { displayName: name } : {}),
        ...(role === "owner" || role === "admin" || role === "member" ? { role } : {}),
        // NapCat and LLOneBot flag the group's bots; the standard does not.
        ...(entry.is_robot === true ? { isBot: true } : {}),
      },
    ]
  })
  return clampRoomMemberRead({ tier: "full", members }, options.maxMembers)
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}
