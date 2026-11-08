import { readOneBotRoomMembers } from "./room-members"

const ok = (data: unknown) => ({ status: "ok" as const, retcode: 0, data, echo: "e" })

describe("readOneBotRoomMembers", () => {
  it("reads a v11 group with card names and roles", async () => {
    const send = jest.fn(async () =>
      ok([
        { user_id: 1, nickname: "Ann", card: "Ann (PM)", role: "owner" },
        { user_id: 2, nickname: "Ben", card: "", role: "admin" },
        { user_id: 3, nickname: " ", role: "member", is_robot: true },
        { nickname: "no id" },
      ])
    )
    await expect(
      readOneBotRoomMembers(
        { send, variant: "v11", adapterId: "ob1", groupId: "123" },
        { maxMembers: 500 }
      )
    ).resolves.toEqual({
      tier: "full",
      members: [
        { remoteUserId: "1", displayName: "Ann (PM)", role: "owner" },
        { remoteUserId: "2", displayName: "Ben", role: "admin" },
        { remoteUserId: "3", role: "member", isBot: true },
      ],
    })
    const [call, timeout] = send.mock.calls[0] as unknown as [Record<string, unknown>, number]
    expect(call).toMatchObject({ action: "get_group_member_list", params: { group_id: 123 } })
    expect(call).not.toHaveProperty("self")
    expect(timeout).toBeGreaterThan(0)
  })

  it("reads a v12 group with its display names and account selector", async () => {
    const send = jest.fn(async (_call: unknown, _timeoutMs?: number) =>
      ok([
        { user_id: "u1", user_name: "ann", user_displayname: "Ann" },
        { user_id: "u2", user_name: "ben" },
        { user_id: "u3" },
      ])
    )
    const self = { platform: "qq", user_id: "bot" }
    await expect(
      readOneBotRoomMembers(
        { send, variant: "v12", self, adapterId: "ob1", groupId: "g1" },
        { maxMembers: 2 }
      )
    ).resolves.toEqual({
      tier: "partial",
      members: [
        { remoteUserId: "u1", displayName: "Ann" },
        { remoteUserId: "u2", displayName: "ben" },
      ],
      memberCount: 3,
    })
    expect(send.mock.calls[0]![0]).toMatchObject({ params: { group_id: "g1" }, self })
  })

  it("refuses a non-numeric v11 group id and a rejected action", async () => {
    const send = jest.fn(async () => ({
      status: "failed" as const,
      retcode: 100,
      data: null,
      echo: "e",
    }))
    await expect(
      readOneBotRoomMembers(
        { send, variant: "v11", adapterId: "ob1", groupId: "g:1" },
        { maxMembers: 5 }
      )
    ).rejects.toThrow(/numeric/)
    expect(send).not.toHaveBeenCalled()
    await expect(
      readOneBotRoomMembers(
        { send, variant: "v11", adapterId: "ob1", groupId: "1" },
        { maxMembers: 5 }
      )
    ).rejects.toThrow()
  })
})
