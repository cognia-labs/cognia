/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { useImRoomTeam } from "./use-im-room-team"

const KEY = "lark:a1:oc_1"

const group = (scopeKind: "group" | "private" = "group") =>
  ({
    id: "s-1",
    title: "Group",
    platformBinding: { platform: "lark", adapterId: "a1", conversationKey: KEY, scopeKind },
  }) as unknown as ChatSession

const character = (id: string, name: string) =>
  ({ id, name, avatarColor: "x", systemPrompt: "", createdAt: 0, updatedAt: 0 }) as never

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await getDb().characters.bulkPut([character("c-ana", "Ana"), character("c-ben", "Ben")])
  await getDb().teams.put({
    id: "ct-1",
    name: "Launch",
    avatarColor: "x",
    members: [{ characterId: "c-ben" }, { characterId: "c-gone" }, { characterId: "c-ana" }],
    orchestration: "round_robin",
    createdAt: 0,
    updatedAt: 0,
  } as never)
})

const bind = (characterTeamId?: string) =>
  getDb().conversationOverrides.put({
    id: "o-1",
    conversationKey: KEY,
    sessionId: "s-1",
    ...(characterTeamId ? { characterTeamId } : {}),
    createdAt: 1,
    updatedAt: 1,
  } as ConversationOverrideRow)

describe("useImRoomTeam", () => {
  it("reads the team a group's conversation names, members in team order", async () => {
    await bind("ct-1")
    const { result } = renderHook(() => useImRoomTeam(group()))
    await waitFor(() =>
      expect(result.current?.members.map((member) => member.name)).toEqual(["Ben", "Ana"])
    )
    expect(result.current?.team.id).toBe("ct-1")
  })

  it("is null for a plain group, a missing team and a one-to-one chat", async () => {
    await bind()
    const plain = renderHook(() => useImRoomTeam(group()))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(plain.result.current).toBeNull()

    await bind("ct-deleted")
    const missing = renderHook(() => useImRoomTeam(group()))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(missing.result.current).toBeNull()

    await bind("ct-1")
    const dm = renderHook(() => useImRoomTeam(group("private")))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(dm.result.current).toBeNull()
  })
})
