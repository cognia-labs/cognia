/** @jest-environment node */
import type { PlatformAdapter } from "@/types/connectors/adapter"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import type { RoomMemberRead } from "@/types/connectors/room-members"
import {
  ROOM_ROSTER_MAX_MEMBERS,
  ROOM_ROSTER_RETRY_MS,
  ROOM_ROSTER_REVISION,
  ROOM_ROSTER_TTL_MS,
  __setRoomRosterDepsForTesting,
  canReadRoomMembers,
  refreshRoomRoster,
  roomRosterForDisplay,
  roomRosterReadDue,
} from "./room-roster"

const NOW = 1_000_000_000

const target = (scopeKind: "group" | "private" = "group") =>
  ({
    address: {
      conversationKey: "lark:a1:oc_1",
      platform: "lark",
      adapterId: "a1",
      scopeKind,
      containerId: "oc_1",
    },
    conversationRef: { platform: "lark", adapterId: "a1" },
    refreshedAt: 1,
  }) as unknown as ConversationDeliveryTarget

function adapter(
  read: () => Promise<RoomMemberRead>,
  capabilities: string[] = ["chat.members.read"]
): PlatformAdapter {
  return { meta: { capabilities }, readRoomMembers: jest.fn(read) } as unknown as PlatformAdapter
}

function world() {
  const writes: Array<{ key: string; session: string; fields: Record<string, unknown> }> = []
  let clock = NOW
  __setRoomRosterDepsForTesting({
    write: async (key, session, fields) => {
      writes.push({ key, session, fields })
    },
    now: () => clock,
  })
  return { writes, tick: (ms: number) => (clock += ms) }
}

afterEach(() => __setRoomRosterDepsForTesting(null))

const input = (a: PlatformAdapter | undefined, override?: Record<string, unknown> | null) => ({
  adapter: a,
  conversationKey: "lark:a1:oc_1",
  sessionId: "s1",
  target: target(),
  override: override ?? null,
})

describe("roomRosterReadDue", () => {
  it("waits out a fresh roster and a recent attempt", () => {
    expect(roomRosterReadDue(null, NOW)).toBe(true)
    expect(
      roomRosterReadDue(
        {
          roomRoster: {
            tier: "full",
            members: [],
            readAt: NOW - 1,
            revision: ROOM_ROSTER_REVISION,
          },
        },
        NOW,
        "lark"
      )
    ).toBe(false)
    expect(
      roomRosterReadDue(
        { roomRoster: { tier: "full", members: [], readAt: NOW - ROOM_ROSTER_TTL_MS } },
        NOW
      )
    ).toBe(true)
    expect(roomRosterReadDue({ roomRosterAttemptAt: NOW - 1 }, NOW)).toBe(false)
    expect(roomRosterReadDue({ roomRosterAttemptAt: NOW - ROOM_ROSTER_RETRY_MS }, NOW)).toBe(true)
  })

  it.each(["discord", "lark", "matrix"])(
    "refreshes stale semantics for %s without bypassing retry backoff",
    (platform) => {
      const roomRoster = { tier: "full" as const, members: [], readAt: NOW - 1 }
      expect(roomRosterReadDue({ roomRoster }, NOW, platform)).toBe(true)
      expect(roomRosterReadDue({ roomRoster, roomRosterAttemptAt: NOW - 1 }, NOW, platform)).toBe(
        false
      )
      expect(roomRosterReadDue({ roomRoster }, NOW, "telegram")).toBe(false)
    }
  )
})

describe("roomRosterForDisplay", () => {
  it.each(["discord", "lark"])(
    "keeps %s legacy members without asserting a room total",
    (platform) => {
      const roster = {
        tier: "partial" as const,
        members: [{ remoteUserId: "1" }],
        memberCount: 10_000,
        readAt: NOW,
      }
      expect(roomRosterForDisplay(platform, roster)).toEqual({
        tier: "partial",
        members: roster.members,
        readAt: NOW,
      })
      expect(roomRosterForDisplay("telegram", roster)).toBe(roster)
    }
  )

  it("downgrades a legacy Lark full list and preserves a refreshed list", () => {
    const roster = { tier: "full" as const, members: [{ remoteUserId: "1" }], readAt: NOW }
    expect(roomRosterForDisplay("lark", roster)?.tier).toBe("partial")
    const refreshed = { ...roster, revision: ROOM_ROSTER_REVISION }
    expect(roomRosterForDisplay("lark", refreshed)).toBe(refreshed)
  })
})

describe("refreshRoomRoster", () => {
  it("reads a group's members and stores them with the attempt stamped first", async () => {
    const w = world()
    const a = adapter(async () => ({
      tier: "full",
      members: [{ remoteUserId: "ou_1", displayName: "Ann", role: "owner" }],
    }))
    await expect(refreshRoomRoster(input(a))).resolves.toBe("read")
    expect(a.readRoomMembers).toHaveBeenCalledWith(target(), {
      maxMembers: ROOM_ROSTER_MAX_MEMBERS,
      signal: expect.any(AbortSignal),
    })
    expect(w.writes).toEqual([
      { key: "lark:a1:oc_1", session: "s1", fields: { roomRosterAttemptAt: NOW } },
      {
        key: "lark:a1:oc_1",
        session: "s1",
        fields: {
          roomRoster: {
            tier: "full",
            members: [{ remoteUserId: "ou_1", displayName: "Ann", role: "owner" }],
            readAt: NOW,
            revision: ROOM_ROSTER_REVISION,
          },
          roomRosterAttemptAt: NOW,
        },
      },
    ])
  })

  it("stores a count-only read as partial, and a list past the limit as partial with its size", async () => {
    const w = world()
    await refreshRoomRoster(
      input(adapter(async () => ({ tier: "partial", members: [], memberCount: 42 })))
    )
    expect(w.writes[1]!.fields.roomRoster).toEqual({
      tier: "partial",
      members: [],
      memberCount: 42,
      readAt: NOW,
      revision: ROOM_ROSTER_REVISION,
    })
    const many = Array.from({ length: ROOM_ROSTER_MAX_MEMBERS + 2 }, (_, i) => ({
      remoteUserId: `u${i}`,
    }))
    await refreshRoomRoster({
      ...input(adapter(async () => ({ tier: "full", members: many }))),
      conversationKey: "lark:a1:oc_2",
    })
    expect(w.writes[3]!.fields.roomRoster).toMatchObject({
      tier: "partial",
      memberCount: ROOM_ROSTER_MAX_MEMBERS + 2,
    })
    expect((w.writes[3]!.fields.roomRoster as { members: unknown[] }).members).toHaveLength(
      ROOM_ROSTER_MAX_MEMBERS
    )
  })

  it("asks nothing of a direct chat, an adapter without the capability, or a fresh roster", async () => {
    const w = world()
    const a = adapter(async () => ({ tier: "full", members: [] }))
    await expect(refreshRoomRoster({ ...input(a), target: target("private") })).resolves.toBe(
      "skipped"
    )
    await expect(
      refreshRoomRoster(input(adapter(async () => ({ tier: "full", members: [] }), [])))
    ).resolves.toBe("skipped")
    await expect(refreshRoomRoster(input(undefined))).resolves.toBe("skipped")
    await expect(
      refreshRoomRoster(
        input(a, {
          roomRoster: { tier: "full", members: [], readAt: NOW, revision: ROOM_ROSTER_REVISION },
        })
      )
    ).resolves.toBe("skipped")
    expect(a.readRoomMembers).not.toHaveBeenCalled()
    expect(w.writes).toEqual([])
    expect(canReadRoomMembers(a)).toBe(true)
  })

  it("reads once for messages arriving together, and keeps the attempt when the platform fails", async () => {
    const w = world()
    let fail: (error: Error) => void = () => undefined
    const a = adapter(
      () =>
        new Promise<RoomMemberRead>((_, reject) => {
          fail = reject
        })
    )
    const first = refreshRoomRoster(input(a))
    const second = refreshRoomRoster(input(a))
    expect(second).toBe(first)
    await new Promise((resolve) => setTimeout(resolve, 0))
    fail(new Error("scope missing"))
    await expect(first).resolves.toBe("failed")
    expect(a.readRoomMembers).toHaveBeenCalledTimes(1)
    expect(w.writes).toEqual([
      { key: "lark:a1:oc_1", session: "s1", fields: { roomRosterAttemptAt: NOW } },
    ])
  })
})
