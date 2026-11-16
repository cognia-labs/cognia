/**
 * The member list of an IM room, read from its platform (ADR-0177 batch 4,
 * ADR-0252 §6).
 *
 * An inbound message in a group, channel or thread asks the host to refresh
 * the conversation's roster when it is stale. The read goes through the
 * adapter's optional `readRoomMembers` (paired with `chat.members.read`), is
 * held to {@link ROOM_ROSTER_MAX_MEMBERS}, and lands on the conversation's
 * override row, which syncs to paired devices. The participants projection
 * then reads it: `full` and `partial` lists are declared members, and a room
 * whose platform cannot list anyone stays `observed`.
 *
 * Never on the reply path: the runtime fires it and does not wait, a failure
 * leaves the last roster in place, and the attempt is stamped before the call
 * so a platform that keeps failing is asked at most once per
 * {@link ROOM_ROSTER_RETRY_MS}.
 */

import type { ConversationOverrideRow, ConversationRoomRoster } from "@/lib/db/connector-types"
import { hasCapability } from "@/types/connectors/capability"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import { clampRoomMemberRead } from "@/types/connectors/room-members"

/** A roster younger than this is not read again. */
export const ROOM_ROSTER_TTL_MS = 6 * 60 * 60 * 1000
/** How long after an attempt (failed or not) the platform is not asked again. */
export const ROOM_ROSTER_RETRY_MS = 30 * 60 * 1000
/** The most members kept; a longer room is stored as `partial` with its count. */
export const ROOM_ROSTER_MAX_MEMBERS = 500
/** A read that has not answered by then is abandoned. */
export const ROOM_ROSTER_READ_TIMEOUT_MS = 15_000
/** Roster reads with channel-scoped counts, Lark bots, and effective Matrix roles. */
export const ROOM_ROSTER_REVISION = 1

export type RoomRosterRefreshOutcome = "skipped" | "read" | "failed"

export interface RoomRosterDeps {
  write(
    conversationKey: string,
    sessionId: string,
    fields: Pick<ConversationOverrideRow, "roomRoster" | "roomRosterAttemptAt">
  ): Promise<void>
  now(): number
}

const defaultDeps: RoomRosterDeps = {
  write: async (conversationKey, sessionId, fields) => {
    const { writeRoomRosterFields } = await import("@/lib/db/conversation-overrides")
    await writeRoomRosterFields(conversationKey, sessionId, fields)
  },
  now: () => Date.now(),
}

let deps = defaultDeps

/** @internal Test seam: replace the writer and the clock. */
export function __setRoomRosterDepsForTesting(next: Partial<RoomRosterDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps
  inflight.clear()
}

const inflight = new Map<string, Promise<RoomRosterRefreshOutcome>>()

function usesLegacyRoster(platform: string | undefined, roster: ConversationRoomRoster): boolean {
  return (
    (roster.revision ?? 0) < ROOM_ROSTER_REVISION &&
    (platform === "discord" || platform === "lark" || platform === "matrix")
  )
}

/** Old snapshots still contain useful names, but their completeness or totals can be wrong. */
export function roomRosterForDisplay(
  platform: string | undefined,
  roster: ConversationRoomRoster | undefined
): ConversationRoomRoster | undefined {
  if (!roster || !usesLegacyRoster(platform, roster)) return roster
  if (platform === "discord" || platform === "lark") {
    // Discord counted the entire guild. Lark counted only human members.
    return { tier: "partial", members: roster.members, readAt: roster.readAt }
  }
  return roster
}

/** Whether the roster on this row is due for a read at `now`. */
export function roomRosterReadDue(
  override: Pick<ConversationOverrideRow, "roomRoster" | "roomRosterAttemptAt"> | null | undefined,
  now: number,
  platform?: string
): boolean {
  const roster = override?.roomRoster
  if (roster && !usesLegacyRoster(platform, roster) && now - roster.readAt < ROOM_ROSTER_TTL_MS)
    return false
  const attemptAt = override?.roomRosterAttemptAt
  if (attemptAt !== undefined && now - attemptAt < ROOM_ROSTER_RETRY_MS) return false
  return true
}

/** Whether this adapter can list a conversation's members at all. */
export function canReadRoomMembers(
  adapter: PlatformAdapter | undefined
): adapter is PlatformAdapter & Required<Pick<PlatformAdapter, "readRoomMembers">> {
  return (
    typeof adapter?.readRoomMembers === "function" &&
    hasCapability(adapter.meta.capabilities, "chat.members.read")
  )
}

export interface RefreshRoomRosterInput {
  adapter: PlatformAdapter | undefined
  conversationKey: string
  /** Links a first override row to its session; the row's schema needs one. */
  sessionId: string
  target: ConversationDeliveryTarget
  override: Pick<ConversationOverrideRow, "roomRoster" | "roomRosterAttemptAt"> | null | undefined
}

/**
 * Read the room's members when they are stale, once per conversation at a
 * time. Never throws: the outcome says what happened.
 */
export function refreshRoomRoster(
  input: RefreshRoomRosterInput
): Promise<RoomRosterRefreshOutcome> {
  const { adapter, conversationKey, target } = input
  if (target.address.scopeKind === "private") return Promise.resolve("skipped")
  if (!canReadRoomMembers(adapter)) return Promise.resolve("skipped")
  const running = inflight.get(conversationKey)
  if (running) return running
  const now = deps.now()
  if (!roomRosterReadDue(input.override, now, target.address.platform))
    return Promise.resolve("skipped")
  const job = readAndStore(adapter, input, now).finally(() => inflight.delete(conversationKey))
  inflight.set(conversationKey, job)
  return job
}

async function readAndStore(
  adapter: PlatformAdapter & Required<Pick<PlatformAdapter, "readRoomMembers">>,
  input: RefreshRoomRosterInput,
  now: number
): Promise<RoomRosterRefreshOutcome> {
  try {
    // Stamped before the call, so a read that hangs or kills the process is
    // not retried on every following message.
    await deps.write(input.conversationKey, input.sessionId, { roomRosterAttemptAt: now })
    const signal = AbortSignal.timeout(ROOM_ROSTER_READ_TIMEOUT_MS)
    const read = clampRoomMemberRead(
      await adapter.readRoomMembers(input.target, {
        maxMembers: ROOM_ROSTER_MAX_MEMBERS,
        signal,
      }),
      ROOM_ROSTER_MAX_MEMBERS
    )
    await deps.write(input.conversationKey, input.sessionId, {
      roomRoster: {
        tier: read.tier,
        members: read.members,
        ...(read.tier === "partial" && read.memberCount !== undefined
          ? { memberCount: read.memberCount }
          : {}),
        readAt: deps.now(),
        revision: ROOM_ROSTER_REVISION,
      },
      roomRosterAttemptAt: now,
    })
    return "read"
  } catch {
    return "failed"
  }
}
