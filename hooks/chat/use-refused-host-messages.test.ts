/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

import { refusedHostMessageId } from "@/lib/chat/refused-host-message"
import { getDb } from "@/lib/db/schema"

import { useRefusedHostMessages } from "./use-refused-host-messages"

function userRow(id: string, hostState: Record<string, unknown>, createdAt = 1) {
  return {
    id,
    sessionId: "s1",
    role: "user",
    parts: [{ type: "text", text: id }],
    createdAt,
    metadata: { hostState },
  }
}

beforeEach(async () => {
  await getDb().messages.clear()
})

it("lists refused sends oldest first and the Host ids they stand for", async () => {
  const refusal = (messageId?: string, at = 5) => ({
    optimistic: true,
    refusal: { code: "denied", at, ...(messageId ? { messageId } : {}) },
  })
  await getDb().messages.bulkPut([
    userRow(refusedHostMessageId("b"), refusal("m-b"), 2) as never,
    userRow(refusedHostMessageId("a"), refusal(), 1) as never,
    userRow("m-ok", { optimistic: true }, 3) as never,
  ])
  const { result } = renderHook(() => useRefusedHostMessages("s1"))
  await waitFor(() => expect(result.current.messages).toHaveLength(2))
  expect(result.current.messages.map((message) => message.id)).toEqual([
    refusedHostMessageId("a"),
    refusedHostMessageId("b"),
  ])
  expect([...result.current.hiddenIds].sort()).toEqual([refusedHostMessageId("a"), "m-b"].sort())
})

it("drops a refused copy whose original became a real transcript row", async () => {
  await getDb().messages.bulkPut([
    userRow(refusedHostMessageId("c"), {
      optimistic: true,
      refusal: { code: "denied", at: 5, messageId: "m-c" },
    }) as never,
    // The original arrived as a confirmed row (no HostState placeholder).
    { id: "m-c", sessionId: "s1", role: "user", parts: [], createdAt: 1 } as never,
    userRow(refusedHostMessageId("d"), {
      optimistic: true,
      refusal: { code: "denied", at: 6 },
    }) as never,
  ])
  const { result } = renderHook(() => useRefusedHostMessages("s1"))
  await waitFor(() => expect(result.current.messages).toHaveLength(1))
  expect(result.current.messages[0].id).toBe(refusedHostMessageId("d"))
  expect(result.current.hiddenIds.has("m-c")).toBe(false)
})
