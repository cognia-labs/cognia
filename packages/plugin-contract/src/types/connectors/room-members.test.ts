import { clampRoomMemberRead, type RoomMember } from "./room-members"

const members = (n: number): RoomMember[] =>
  Array.from({ length: n }, (_, i) => ({ remoteUserId: `u${i}` }))

describe("clampRoomMemberRead", () => {
  it("leaves a read within the limit alone", () => {
    const read = { tier: "full" as const, members: members(3) }
    expect(clampRoomMemberRead(read, 3)).toBe(read)
  })

  it("turns an over-long full list into a partial one with the true count", () => {
    expect(clampRoomMemberRead({ tier: "full", members: members(5) }, 2)).toEqual({
      tier: "partial",
      members: members(2),
      memberCount: 5,
    })
  })

  it("keeps the larger of the reported count and what was listed", () => {
    expect(
      clampRoomMemberRead({ tier: "partial", members: members(4), memberCount: 40 }, 1)
    ).toEqual({ tier: "partial", members: members(1), memberCount: 40 })
    expect(
      clampRoomMemberRead({ tier: "partial", members: members(4), memberCount: 2 }, 1)
    ).toEqual({ tier: "partial", members: members(1), memberCount: 4 })
  })

  it("treats a negative or fractional limit as its floor at zero", () => {
    expect(clampRoomMemberRead({ tier: "full", members: members(2) }, -1).members).toEqual([])
    expect(clampRoomMemberRead({ tier: "full", members: members(3) }, 1.9).members).toHaveLength(1)
  })
})
