import { completenessFor, imRosterMemberId, projectRoomParticipants } from "./participants"

const alice = { id: "c-alice", name: "Alice" }
const bob = { id: "c-bob", name: "Bob" }

describe("projectRoomParticipants", () => {
  it("declares a team's members with roles before anyone has spoken", () => {
    const projection = projectRoomParticipants({
      kind: "team",
      characters: [alice, bob],
      members: [{ characterId: "c-alice", role: "Critic" }, { characterId: "c-bob" }],
    })
    expect(projection.completeness).toBe("full")
    expect(projection.participants.map((p) => [p.speaker.id, p.speaker.kind, p.role])).toEqual([
      ["c-alice", "agent", "Critic"],
      ["c-bob", "agent", undefined],
    ])
    expect([...projection.declaredIds]).toEqual(["c-alice", "c-bob"])
  })

  it("keeps the declared row when a member has also spoken, and adds strangers", () => {
    const projection = projectRoomParticipants({
      kind: "team",
      characters: [alice],
      members: [{ characterId: "c-alice", role: "Critic" }],
      messages: [
        { role: "assistant", senderId: "c-alice" },
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "tg:9", displayName: "Zed" } } },
        },
      ],
      ctx: { characterNameById: new Map([["c-alice", "Alice"]]) },
    })
    expect(projection.participants.map((p) => [p.speaker.id, p.role])).toEqual([
      ["c-alice", "Critic"],
      ["tg:9", undefined],
    ])
  })

  it("reads a shared room's roster from memberships and marks guests", () => {
    const projection = projectRoomParticipants({
      kind: "shared",
      memberships: [
        { userId: "usr_1", role: "owner", guest: false, displayName: "Ada" },
        { userId: "usr_2", role: "viewer", guest: true },
      ],
      selfId: "usr_1",
    })
    expect(projection.completeness).toBe("full")
    expect(projection.participants.map((p) => [p.speaker.kind, p.role, p.isSelf ?? false])).toEqual(
      [
        ["human", "owner", true],
        ["guest", "viewer", false],
      ]
    )
  })

  it("has only observed speakers for an IM group until an adapter reads members", () => {
    const projection = projectRoomParticipants({
      kind: "im",
      messages: [
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "tg:1", displayName: "A" } } },
        },
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "tg:2", displayName: "B" } } },
        },
      ],
    })
    expect(projection.completeness).toBe("observed")
    expect(projection.declaredIds.size).toBe(0)
    expect(projection.participants.map((p) => p.speaker.id)).toEqual(["tg:2", "tg:1"])
  })

  it("declares an IM room's listed members and folds in the ones who have spoken", () => {
    const projection = projectRoomParticipants({
      kind: "im",
      imRoster: {
        tier: "full",
        members: [
          { remoteUserId: "ou_ann", displayName: "Ann", role: "owner" },
          { remoteUserId: "ou_ben", role: "member" },
          { remoteUserId: "ou_bot", displayName: "Helper", isBot: true },
          { remoteUserId: "ou_ann", displayName: "Duplicate" },
        ],
      },
      messages: [
        {
          role: "user",
          metadata: {
            platformMessage: {
              sender: { id: "pid_ben", remoteUserId: "ou_ben", displayName: "Ben" },
            },
          },
        },
        {
          role: "user",
          metadata: {
            platformMessage: {
              sender: { id: "pid_zed", remoteUserId: "ou_zed", displayName: "Zed" },
            },
          },
        },
      ],
    })
    expect(projection.completeness).toBe("full")
    expect(
      projection.participants.map((p) => [p.speaker.id, p.speaker.kind, p.speaker.label, p.role])
    ).toEqual([
      [imRosterMemberId("ou_ann"), "human", "Ann", "owner"],
      ["pid_ben", "human", "Ben", undefined],
      [imRosterMemberId("ou_bot"), "app", "Helper", undefined],
      ["pid_zed", "human", "Zed", undefined],
    ])
    expect([...projection.declaredIds]).toEqual([
      imRosterMemberId("ou_ann"),
      "pid_ben",
      imRosterMemberId("ou_bot"),
    ])
    expect(projection.memberCount).toBeUndefined()
  })

  it("says a partial IM roster is partial and keeps the room's size", () => {
    const projection = projectRoomParticipants({
      kind: "im",
      imRoster: {
        tier: "partial",
        members: [{ remoteUserId: "1", displayName: "Admin", role: "admin" }],
        memberCount: 240,
      },
    })
    expect(projection.completeness).toBe("partial")
    expect(projection.memberCount).toBe(240)
    expect(projection.participants).toHaveLength(1)

    const countOnly = projectRoomParticipants({
      kind: "im",
      imRoster: { tier: "partial", members: [], memberCount: 1 },
      messages: [
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "pid_a", remoteUserId: "a" } } },
        },
        {
          role: "user",
          metadata: { platformMessage: { sender: { id: "pid_b", remoteUserId: "b" } } },
        },
      ],
    })
    expect(countOnly.completeness).toBe("partial")
    // A count smaller than who has visibly spoken is stale, not the room.
    expect(countOnly.memberCount).toBeUndefined()
  })

  it("never claims a full roster it did not receive", () => {
    expect(completenessFor("team", 0)).toBe("observed")
    expect(completenessFor("shared", 2)).toBe("full")
    expect(completenessFor("im", 5)).toBe("observed")
    expect(completenessFor("im", 0, "full")).toBe("observed")
    expect(completenessFor("im", 3, "full")).toBe("full")
    expect(completenessFor("im", 0, "partial")).toBe("partial")
    expect(completenessFor("team", 2, "partial")).toBe("full")
    expect(completenessFor(null, 0)).toBe("observed")
  })
})
