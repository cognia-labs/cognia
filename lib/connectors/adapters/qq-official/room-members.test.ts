import type { ConnectorManagementRequest } from "@/types/connectors/management"
import { QQ_ROSTER_MAX_PAGES, readQQRoomMembers } from "./room-members"

describe("readQQRoomMembers", () => {
  it("pages members.list and maps openids, names, roles and bots", async () => {
    const execute = jest.fn(async (request: ConnectorManagementRequest) => {
      const cursor = (request.input as { cursor?: string }).cursor
      return cursor
        ? { status: "ok" as const, items: [{ member_openid: "m3", member_role: "custom" }] }
        : {
            status: "ok" as const,
            items: [
              { member_openid: "m1", username: "Ann", member_role: "owner" },
              { member_openid: "m2", member_role: "admin", bot: true },
              { username: "no id" },
            ],
            nextCursor: "c2",
          }
    })
    await expect(readQQRoomMembers({ execute }, "g1", { maxMembers: 500 })).resolves.toEqual({
      tier: "full",
      members: [
        { remoteUserId: "m1", displayName: "Ann", role: "owner" },
        { remoteUserId: "m2", role: "admin", isBot: true },
        { remoteUserId: "m3" },
      ],
    })
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      { operation: "members.list", input: { chatId: "g1" } },
      { operation: "members.list", input: { chatId: "g1", cursor: "c2" } },
    ])
  })

  it("stops after a few spaced pages and calls a long group partial", async () => {
    let page = 0
    const execute = jest.fn(async () => {
      page += 1
      return {
        status: "ok" as const,
        items: [{ member_openid: `m${page}` }],
        nextCursor: `c${page}`,
      }
    })
    const read = await readQQRoomMembers({ execute }, "g1", { maxMembers: 500 })
    expect(read.tier).toBe("partial")
    expect(read.members).toHaveLength(QQ_ROSTER_MAX_PAGES)
    expect(execute).toHaveBeenCalledTimes(QQ_ROSTER_MAX_PAGES)
  })
})
