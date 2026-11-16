/**
 * A Matrix room's roster (ADR-0177 batch 4).
 *
 * `joined_members` answers every joined member with its display name in one
 * response, so the read is `full` unless the room is longer than the caller
 * keeps. A power level of 50 or more is shown as an admin. Effective levels
 * depend on both `m.room.power_levels` and the room's creation event.
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
) => Promise<unknown>

/** A 10k-member room's `joined_members` is a few MB; anything past this is refused. */
export const MATRIX_ROSTER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MATRIX_ADMIN_POWER_LEVEL = 50

export async function readMatrixRoomMembers(
  request: MatrixRosterRequest,
  roomId: string,
  options: RoomMemberReadOptions
): Promise<RoomMemberRead> {
  options.signal?.throwIfAborted()
  const room = encodeURIComponent(roomId)
  const [joined, powerLevels, create] = await Promise.all([
    request("GET", `/_matrix/client/v3/rooms/${room}/joined_members`, undefined, {
      maxResponseBytes: MATRIX_ROSTER_MAX_RESPONSE_BYTES,
    }),
    request("GET", `/_matrix/client/v3/rooms/${room}/state/m.room.power_levels`).catch(
      (error: unknown) => (objectOf(error).status === 404 ? null : undefined)
    ),
    request("GET", `/_matrix/client/v3/rooms/${room}/state/m.room.create?format=event`).catch(
      () => undefined
    ),
  ])
  options.signal?.throwIfAborted()
  const createResponse = objectOf(create)
  const hasCreateEvent = createResponse.type === "m.room.create"
  const createContent = hasCreateEvent ? objectOf(createResponse.content) : createResponse
  const roomVersion =
    typeof createContent.room_version === "string" ? Number(createContent.room_version) : 1
  let creator = roomVersion < 11 ? createContent.creator : undefined
  if (roomVersion >= 11 && hasCreateEvent) creator = createResponse.sender
  if (
    roomVersion >= 11 &&
    typeof creator !== "string" &&
    (roomVersion >= 12 || powerLevels === null)
  ) {
    // Pre-v1.16 homeservers can ignore format=event and return only content.
    const state = await request("GET", `/_matrix/client/v3/rooms/${room}/state`, undefined, {
      maxResponseBytes: MATRIX_ROSTER_MAX_RESPONSE_BYTES,
    }).catch(() => undefined)
    options.signal?.throwIfAborted()
    if (Array.isArray(state)) {
      creator = objectOf(state.find((event) => objectOf(event).type === "m.room.create")).sender
    }
  }
  const additionalCreators = createContent.additional_creators
  const creators = new Set(
    roomVersion >= 12 && Array.isArray(additionalCreators) ? additionalCreators : []
  )
  const levels = objectOf(powerLevels)
  const users = objectOf(levels.users)
  const defaultLevel = readPowerLevel(levels.users_default, roomVersion) ?? 0
  const members: RoomMember[] = Object.entries(objectOf(objectOf(joined).joined)).map(
    ([userId, value]) => {
      const displayName = objectOf(value).display_name
      const level = readPowerLevel(users[userId], roomVersion) ?? defaultLevel
      const creatorIsAdmin =
        (userId === creator && (roomVersion >= 12 || powerLevels === null)) || creators.has(userId)
      return {
        remoteUserId: userId,
        ...(typeof displayName === "string" && displayName ? { displayName } : {}),
        role:
          creatorIsAdmin || level >= MATRIX_ADMIN_POWER_LEVEL
            ? ("admin" as const)
            : ("member" as const),
      }
    }
  )
  return clampRoomMemberRead({ tier: "full", members }, options.maxMembers)
}

function readPowerLevel(value: unknown, roomVersion: number): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  if (roomVersion < 10 && typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return undefined
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
