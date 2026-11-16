/**
 * Team sub-session id codec.
 *
 * A team turn drives each member through the sidecar under a distinct
 * sub-session id derived from the team ChatSession id. The chat store, the
 * desktop/mobile shells, and `useTeamChat` all partition the event stream and
 * approval routing on this shape, so the codec lives here (pure, no React)
 * rather than inside the hook.
 */

export const SUB_SEPARATOR = "::char::"

/**
 * Build a sub-session id from the team session and character. A turnId suffix
 * keeps successive turns (e.g. regenerates) from colliding with stale resolver
 * entries inside the in-flight orchestrator loop.
 */
export function subSessionId(teamSessionId: string, characterId: string, turnId: string): string {
  return `${teamSessionId}${SUB_SEPARATOR}${characterId}::${turnId}`
}

/**
 * Decode a sub-session id into its team-session + character pair, or null if
 * the id isn't a team sub-session. The optional `::turnId` suffix is stripped.
 */
export function decodeSubSession(
  id: string
): { teamSessionId: string; characterId: string } | null {
  const idx = id.indexOf(SUB_SEPARATOR)
  if (idx < 0) return null
  const tail = id.slice(idx + SUB_SEPARATOR.length)
  const sep = tail.indexOf("::")
  return {
    teamSessionId: id.slice(0, idx),
    characterId: sep < 0 ? tail : tail.slice(0, sep),
  }
}

/** True when `id` is a team sub-session id (`…::char::…`). */
export function isSubSessionId(id: string): boolean {
  return id.includes(SUB_SEPARATOR)
}

/**
 * The turn segment of an IM room member's sub-session (ADR-0177 batch 4).
 *
 * The connector runtime runs each member of an IM group's character team
 * under a sub-session of the IM session, so everything that maps a member's
 * session back to its room (skill context, the hand-off tool's caller, the
 * workspace owner) already works. What differs is who owns the run: the
 * connector runtime answers its approvals in the group and writes its reply,
 * so `RoomRunner`, which owns every other sub-session, leaves these alone.
 */
export const IM_ROOM_RUN_PREFIX = "im."

/** The sub-session one IM room member's step runs under. */
export function imRoomMemberSessionId(
  roomSessionId: string,
  characterId: string,
  runKey: string
): string {
  return subSessionId(roomSessionId, characterId, `${IM_ROOM_RUN_PREFIX}${runKey}`)
}

/** True when `id` is a sub-session the connector runtime runs for an IM room member. */
export function isImRoomMemberSessionId(id: string): boolean {
  const idx = id.indexOf(SUB_SEPARATOR)
  if (idx < 0) return false
  const tail = id.slice(idx + SUB_SEPARATOR.length)
  const sep = tail.indexOf("::")
  return sep >= 0 && tail.slice(sep + 2).startsWith(IM_ROOM_RUN_PREFIX)
}
