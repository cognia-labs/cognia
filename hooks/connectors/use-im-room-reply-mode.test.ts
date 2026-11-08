/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"

const mutateConversationOverride = jest.fn(async (..._args: unknown[]) => ({
  route: "local" as const,
  conversationKey: "lark:a1:oc_1",
}))
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: (...args: unknown[]) => mutateConversationOverride(...args),
}))

import { useImRoomReplyMode } from "./use-im-room-reply-mode"

const KEY = "lark:a1:oc_1"

const group = (scopeKind: "group" | "thread" | "private" = "group") =>
  ({
    id: "s-1",
    title: "Group",
    platformBinding: { platform: "lark", adapterId: "a1", conversationKey: KEY, scopeKind },
  }) as unknown as ChatSession

beforeEach(async () => {
  mutateConversationOverride.mockClear()
  await getDb().delete()
  __resetDbForTesting()
  await getDb().adapterInstances.put({
    id: "a1",
    type: "lark",
    inboundActivationPolicy: "always",
  } as unknown as AdapterInstanceRow)
})

describe("useImRoomReplyMode", () => {
  it("reads an IM group's mode off its policy and writes the matching policy back", async () => {
    await getDb().conversationOverrides.put({
      id: "o-1",
      conversationKey: KEY,
      sessionId: "s-1",
      inboundActivationPolicy: "mention_each",
      createdAt: 1,
      updatedAt: 1,
    } as ConversationOverrideRow)
    const { result } = renderHook(() => useImRoomReplyMode(group()))
    await waitFor(() => expect(result.current?.mode).toBe("mention_only"))

    await act(() => result.current!.setMode("asleep"))
    expect(mutateConversationOverride).toHaveBeenLastCalledWith(
      {
        kind: "configSection",
        adapterId: "a1",
        conversationKey: KEY,
        sessionId: "s-1",
        section: "behavior",
        source: "room.settings",
        patch: { inboundActivationPolicy: "off" },
      },
      { label: "room.replyMode" }
    )

    // The adapter already answers everything, so "auto" clears the override.
    await act(() => result.current!.setMode("auto"))
    expect(mutateConversationOverride.mock.calls.at(-1)![0]).toMatchObject({
      patch: { inboundActivationPolicy: undefined },
    })
  })

  it("has no mode until the adapter row is readable, and is absent outside an IM room", async () => {
    await getDb().adapterInstances.delete("a1")
    const { result } = renderHook(() => useImRoomReplyMode(group()))
    expect(result.current).toEqual({ mode: null, setMode: expect.any(Function) })
    await act(() => result.current!.setMode("asleep"))
    expect(mutateConversationOverride).not.toHaveBeenCalled()

    const dm = renderHook(() => useImRoomReplyMode(group("private")))
    expect(dm.result.current).toBeNull()
    const team = renderHook(() =>
      useImRoomReplyMode({ ...group(), kind: "team", teamId: "t-1" } as ChatSession)
    )
    expect(team.result.current).toBeNull()
  })
})
