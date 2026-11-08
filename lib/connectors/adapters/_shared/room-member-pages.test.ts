import type { RoomMember } from "@/types/connectors/room-members"
import { collectRoomMemberPages, type RoomMemberPage } from "./room-member-pages"

const m = (id: string): RoomMember => ({ remoteUserId: id })

function pages(...list: RoomMemberPage[]) {
  const fetchPage = jest.fn(async (cursor: string | undefined) => {
    const index = cursor === undefined ? 0 : Number(cursor)
    return list[index]!
  })
  return fetchPage
}

describe("collectRoomMemberPages", () => {
  it("follows the cursor to the end and calls the list full", async () => {
    const fetchPage = pages(
      { members: [m("a"), m("b")], nextCursor: "1" },
      { members: [m("b"), m("c")] }
    )
    await expect(collectRoomMemberPages(fetchPage, { maxMembers: 10 })).resolves.toEqual({
      tier: "full",
      members: [m("a"), m("b"), m("c")],
    })
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "1"])
  })

  it("stops at the caller's limit and reports the room's size", async () => {
    const fetchPage = pages(
      { members: [m("a"), m("b")], nextCursor: "1", total: 9 },
      { members: [m("c")] }
    )
    await expect(collectRoomMemberPages(fetchPage, { maxMembers: 2 })).resolves.toEqual({
      tier: "partial",
      members: [m("a"), m("b")],
      memberCount: 9,
    })
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it("calls a read cut by the page budget partial without inventing a count", async () => {
    const fetchPage = pages(
      { members: [m("a")], nextCursor: "1" },
      { members: [m("b")], nextCursor: "2" }
    )
    await expect(collectRoomMemberPages(fetchPage, { maxMembers: 10 }, 1)).resolves.toEqual({
      tier: "partial",
      members: [m("a")],
    })
  })

  it("trusts a platform total larger than what it listed", async () => {
    await expect(
      collectRoomMemberPages(pages({ members: [m("a")], total: 3 }), { maxMembers: 10 })
    ).resolves.toEqual({ tier: "partial", members: [m("a")], memberCount: 3 })
  })

  it("stops on a cursor that does not move, and on an aborted signal", async () => {
    const stuck = jest.fn(async () => ({ members: [m("a")], nextCursor: "same" }))
    await collectRoomMemberPages(stuck, { maxMembers: 10 })
    expect(stuck).toHaveBeenCalledTimes(2)

    const controller = new AbortController()
    controller.abort(new Error("timeout"))
    await expect(
      collectRoomMemberPages(pages({ members: [m("a")] }), {
        maxMembers: 10,
        signal: controller.signal,
      })
    ).rejects.toThrow("timeout")
  })
})
