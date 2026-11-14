/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import Dexie, { type Table } from "dexie"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useSessionAsideIdentity } from "./use-session-aside-identity"

let mockDb: Dexie & { sessions: Table<ChatSession, string> }
jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDb }))

const id = "resource-workbench:session:parent"
const row = (kind: ChatSession["kind"]): ChatSession => ({
  id,
  title: "Conversation",
  kind,
  createdAt: 1,
  updatedAt: 1,
})

beforeEach(async () => {
  mockDb = new Dexie("session-aside-identity-test") as typeof mockDb
  mockDb.version(1).stores({ sessions: "id" })
  await mockDb.open()
})
afterEach(async () => {
  jest.restoreAllMocks()
  await mockDb.delete()
})

it.each(["embedded", "promoted", "unknown"])(
  "fails closed until the persisted row is known: %s",
  async (state) => {
    if (state !== "unknown")
      await mockDb.sessions.put(row(state === "embedded" ? "resource-workbench" : "direct"))
    const get = jest.spyOn(mockDb.sessions, "get")
    const { result } = renderHook(() => useSessionAsideIdentity(id))
    expect(result.current).toBe(true)
    await waitFor(() => expect(get).toHaveBeenCalledWith(id))
    if (state === "promoted") await waitFor(() => expect(result.current).toBe(false))
    else expect(result.current).toBe(true)
  }
)

it("observes promotion and deletion without a plugin store load", async () => {
  await mockDb.sessions.put(row("resource-workbench"))
  const { result } = renderHook(() => useSessionAsideIdentity(id))
  expect(result.current).toBe(true)
  await act(async () => {
    await mockDb.sessions.put(row("direct"))
  })
  await waitFor(() => expect(result.current).toBe(false))
  await act(async () => {
    await mockDb.sessions.delete(id)
  })
  await waitFor(() => expect(result.current).toBe(true))
})

it("does not reuse a promoted row's identity after switching to an unknown aside", async () => {
  await mockDb.sessions.put(row("direct"))
  const { result, rerender } = renderHook(({ sessionId }) => useSessionAsideIdentity(sessionId), {
    initialProps: { sessionId: id },
  })
  await waitFor(() => expect(result.current).toBe(false))
  rerender({ sessionId: "resource-workbench:session:unknown" })
  expect(result.current).toBe(true)
})

it("keeps an aside blocked when the row cannot be read", async () => {
  const get = jest.spyOn(mockDb.sessions, "get").mockRejectedValue(new Error("read failed"))
  const { result } = renderHook(() => useSessionAsideIdentity(id))
  await waitFor(() => expect(get).toHaveBeenCalledWith(id))
  expect(result.current).toBe(true)
})

it.each([null, undefined, "ordinary"])(
  "does not read Dexie for an unprefixed id: %s",
  (sessionId) => {
    const get = jest.spyOn(mockDb.sessions, "get")
    const { result } = renderHook(() => useSessionAsideIdentity(sessionId))
    expect(result.current).toBe(false)
    expect(get).not.toHaveBeenCalled()
  }
)
