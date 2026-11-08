import { MATRIX_ROSTER_MAX_RESPONSE_BYTES, readMatrixRoomMembers } from "./room-members"

describe("readMatrixRoomMembers", () => {
  it("lists every joined member and marks power level 50+ as admin", async () => {
    const request = jest.fn(async (_method: "GET", path: string) =>
      path.endsWith("/joined_members")
        ? {
            joined: {
              "@ann:hs": { display_name: "Ann" },
              "@ben:hs": { display_name: null },
              "@mod:hs": {},
            },
          }
        : { users: { "@ann:hs": 100, "@mod:hs": 50, "@ben:hs": 0 } }
    )
    await expect(readMatrixRoomMembers(request, "!r:hs", { maxMembers: 500 })).resolves.toEqual({
      tier: "full",
      members: [
        { remoteUserId: "@ann:hs", displayName: "Ann", role: "admin" },
        { remoteUserId: "@ben:hs", role: "member" },
        { remoteUserId: "@mod:hs", role: "admin" },
      ],
    })
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/rooms/!r%3Ahs/joined_members",
      undefined,
      { maxResponseBytes: MATRIX_ROSTER_MAX_RESPONSE_BYTES }
    )
  })

  it("still lists members when the power levels are hidden, and cuts a long room", async () => {
    const request = jest.fn(async (_method: "GET", path: string) => {
      if (!path.endsWith("/joined_members")) throw new Error("M_FORBIDDEN")
      return { joined: { "@a:hs": {}, "@b:hs": {}, "@c:hs": {} } }
    })
    await expect(readMatrixRoomMembers(request, "!r:hs", { maxMembers: 2 })).resolves.toEqual({
      tier: "partial",
      members: [
        { remoteUserId: "@a:hs", role: "member" },
        { remoteUserId: "@b:hs", role: "member" },
      ],
      memberCount: 3,
    })
  })

  it("fails when the member list itself cannot be read", async () => {
    const request = jest.fn(async () => {
      throw new Error("M_FORBIDDEN")
    })
    await expect(readMatrixRoomMembers(request, "!r:hs", { maxMembers: 5 })).rejects.toThrow(
      "M_FORBIDDEN"
    )
  })
})
