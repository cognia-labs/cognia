import { readDiscordRoomMembers } from "./room-members"

describe("readDiscordRoomMembers", () => {
  it("reports the owner without using guild size as the channel size", async () => {
    const request = jest.fn(async () => ({ owner_id: "42", approximate_member_count: 1300 }))
    await expect(readDiscordRoomMembers(request, "g1", { maxMembers: 500 })).resolves.toEqual({
      tier: "partial",
      members: [{ remoteUserId: "42", role: "owner" }],
    })
    expect(request).toHaveBeenCalledWith("GET", "/guilds/g1")
  })

  it("refuses a conversation with no guild, and keeps nobody when the caller keeps nobody", async () => {
    const request = jest.fn(async () => ({ owner_id: "42" }))
    await expect(readDiscordRoomMembers(request, undefined, { maxMembers: 5 })).rejects.toThrow(
      /guild id/
    )
    expect(request).not.toHaveBeenCalled()
    await expect(readDiscordRoomMembers(request, "g1", { maxMembers: 0 })).resolves.toEqual({
      tier: "partial",
      members: [],
    })
  })
})
