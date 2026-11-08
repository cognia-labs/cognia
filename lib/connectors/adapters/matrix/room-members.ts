/**
 * A Matrix room's roster (ADR-0177 batch 4).
 *
 * `joined_members` answers every joined member with its display name in one
 * response, so the read is `full` unless the room is longer than the caller
 * keeps. Matrix has no owner; a power level of 50 or more (the moderator and
 * admin defaults) is shown as an admin, read from `m.room.power_levels` when
 * the bot can see it.
 */

import type {
  RoomMember,
  RoomMemberRead,
  RoomMemberReadOptions,
} from "@/types/connectors/room-members"
import { clampRoomMemberRead } from "@/types/connectors/room-members"

export type MatrixRosterRequest = (
  method: "GET",
  path: string,
  payload?: undefined,
  options?: { maxResponseBytes: number }
) => Promise<Record<string, unknown>>

/** A 10k-member room's `joined_members` is a few MB; anything past this is refused. */
export const MATRIX_ROSTER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MATRIX_ADMIN_POWER_LEVEL = 50

export async function readMatrixRoomMembers(
  request: MatrixRosterRequest,
  roomId: string,
  options: RoomMemberReadOptions
): Promise<RoomMemberRead> {
  const room = encodeURIComponent(roomId)
  const [joined, powerLevels] = await Promise.all([
    request("GET", `/_matrix/client/v3/rooms/${room}/joined_members`, undefined, {
      maxResponseBytes: MATRIX_ROSTER_MAX_RESPONSE_BYTES,
    }),
    request("GET", `/_matrix/client/v3/rooms/${room}/state/m.room.power_levels`).catch(
      () => undefined
    ),
  ])
  options.signal?.throwIfAborted()
  const users = objectOf(powerLevels?.users)
  const members: RoomMember[] = Object.entries(objectOf(joined.joined)).map(([userId, value]) => {
    const displayName = objectOf(value).display_name
    const level = users[userId]
    return {
      remoteUserId: userId,
      ...(typeof displayName === "string" && displayName ? { displayName } : {}),
      role:
        typeof level === "number" && level >= MATRIX_ADMIN_POWER_LEVEL
          ? ("admin" as const)
          : ("member" as const),
    }
  })
  return clampRoomMemberRead({ tier: "full", members }, options.maxMembers)
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
