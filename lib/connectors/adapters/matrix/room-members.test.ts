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

  it.each([0, 50])(
    "honors default %i, explicit overrides, and every v12 creator",
    async (users_default) => {
      const request = jest.fn(async (_method: "GET", path: string) => {
        if (path.endsWith("/joined_members")) {
          return {
            joined: { "@creator:hs": {}, "@other:hs": {}, "@default:hs": {}, "@low:hs": {} },
          }
        }
        if (path.endsWith("/state/m.room.create?format=event")) {
          return {
            type: "m.room.create",
            sender: "@creator:hs",
            content: { room_version: "12", additional_creators: ["@other:hs"] },
          }
        }
        return { users_default, users: { "@low:hs": 0 } }
      })
      await expect(readMatrixRoomMembers(request, "!r:hs", { maxMembers: 10 })).resolves.toEqual({
        tier: "full",
        members: [
          { remoteUserId: "@creator:hs", role: "admin" },
          { remoteUserId: "@other:hs", role: "admin" },
          { remoteUserId: "@default:hs", role: users_default === 50 ? "admin" : "member" },
          { remoteUserId: "@low:hs", role: "member" },
        ],
      })
    }
  )

  it.each([404, 403])(
    "uses the legacy creator default only when the power levels event is absent (%i)",
    async (status) => {
      const request = jest.fn(async (_method: "GET", path: string) => {
        if (path.endsWith("/joined_members"))
          return { joined: { "@creator:hs": {}, "@peer:hs": {} } }
        // Older servers may return only content even when format=event was requested.
        if (path.endsWith("/state/m.room.create?format=event")) return { creator: "@creator:hs" }
        throw Object.assign(new Error("Cannot read power levels"), { status })
      })
      await expect(readMatrixRoomMembers(request, "!r:hs", { maxMembers: 10 })).resolves.toEqual({
        tier: "full",
        members: [
          { remoteUserId: "@creator:hs", role: status === 404 ? "admin" : "member" },
          { remoteUserId: "@peer:hs", role: "member" },
        ],
      })
    }
  )

  it("reads the v11 creation sender from bounded room state on older homeservers", async () => {
    const request = jest.fn(async (_method: "GET", path: string) => {
      if (path.endsWith("/joined_members")) return { joined: { "@creator:hs": {}, "@peer:hs": {} } }
      if (path.endsWith("/state/m.room.create?format=event")) return { room_version: "11" }
      if (path.endsWith("/state")) {
        return [{ type: "m.room.create", sender: "@creator:hs", content: { room_version: "11" } }]
      }
      throw Object.assign(new Error("No power levels event"), { status: 404 })
    })
    await expect(readMatrixRoomMembers(request, "!r:hs", { maxMembers: 10 })).resolves.toEqual({
      tier: "full",
      members: [
        { remoteUserId: "@creator:hs", role: "admin" },
        { remoteUserId: "@peer:hs", role: "member" },
      ],
    })
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/rooms/!r%3Ahs/state",
      undefined,
      {
        maxResponseBytes: MATRIX_ROSTER_MAX_RESPONSE_BYTES,
      }
    )
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
