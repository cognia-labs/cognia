import { readSlackRoomMembers } from "./room-members"

describe("readSlackRoomMembers", () => {
  it("pages conversations.members by cursor to the end", async () => {
    const request = jest.fn(async (_method: "GET", path: string) =>
      path.includes("cursor=c2")
        ? { ok: true, members: ["U3"], response_metadata: { next_cursor: "" } }
        : { ok: true, members: ["U1", "U2", 7], response_metadata: { next_cursor: "c2" } }
    )
    await expect(readSlackRoomMembers(request, "C1", { maxMembers: 500 })).resolves.toEqual({
      tier: "full",
      members: [{ remoteUserId: "U1" }, { remoteUserId: "U2" }, { remoteUserId: "U3" }],
    })
    expect(request.mock.calls.map(([, path]) => path)).toEqual([
      "conversations.members?channel=C1&limit=200",
      "conversations.members?channel=C1&limit=200&cursor=c2",
    ])
  })

  it("stops at the caller's limit and calls the list partial", async () => {
    const request = jest.fn(async (_method: "GET", _path: string) => ({
      ok: true,
      members: ["U1", "U2"],
      response_metadata: { next_cursor: "more" },
    }))
    await expect(readSlackRoomMembers(request, "C1", { maxMembers: 2 })).resolves.toEqual({
      tier: "partial",
      members: [{ remoteUserId: "U1" }, { remoteUserId: "U2" }],
    })
    expect(request.mock.calls[0]![1]).toContain("limit=2")
  })
})
