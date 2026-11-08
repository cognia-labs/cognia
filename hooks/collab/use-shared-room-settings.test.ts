/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { ChatSession, SessionRole } from "@cognia/agent-config-types"
import { sharedChatCacheKey } from "@/lib/db/collab-chat-mirror"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import { useSharedRoomSettings } from "./use-shared-room-settings"

const mockResolve = jest.fn()
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: () => mockResolve(),
}))
const mockUpdate = jest.fn()
jest.mock("@/lib/collab/shared-room-settings", () => ({
  ...jest.requireActual("@/lib/collab/shared-room-settings"),
  updateSharedRoomSettings: (...args: unknown[]) => mockUpdate(...args),
}))

const BASE = "https://collab.test"
const session = {
  id: "local",
  collaboration: { orgId: "org", workspaceId: "ws", sessionId: "remote", policyRevision: 1 },
} as Pick<ChatSession, "id" | "collaboration" | "roomSettings">
const key = sharedChatCacheKey("org", "remote", BASE)

async function member(role: SessionRole) {
  await getDb().collabChatMemberships.put({
    sessionId: key,
    userId: "usr_me",
    orgId: "org",
    role,
    approver: false,
    guest: false,
    createdAt: 1,
    updatedAt: 1,
    fetchedAt: 1,
  } as never)
}

describe("useSharedRoomSettings", () => {
  const db = createDbTestFixture()
  beforeAll(db.initialize)
  beforeEach(async () => {
    await db.restore()
    mockResolve.mockReset().mockResolvedValue({
      orgId: "org",
      userId: "usr_me",
      client: { baseUrl: BASE },
    })
    mockUpdate.mockReset().mockResolvedValue({})
  })
  afterAll(db.dispose)

  it("lets an owner or a maintainer change the room's settings", async () => {
    await member("maintainer")
    const { result } = renderHook(() => useSharedRoomSettings(session))
    await waitFor(() => expect(result.current.access).toEqual({ state: "allowed" }))
    await act(() => result.current.update({ replyMode: "auto" }))
    expect(mockUpdate).toHaveBeenCalledWith(session, { replyMode: "auto" })
  })

  it("names the role of a member who may not", async () => {
    await member("member")
    const { result } = renderHook(() => useSharedRoomSettings(session))
    await waitFor(() => expect(result.current.access).toEqual({ state: "denied", role: "member" }))
  })

  it("follows a role change the sync mirrors", async () => {
    await member("member")
    const { result } = renderHook(() => useSharedRoomSettings(session))
    await waitFor(() => expect(result.current.access.state).toBe("denied"))
    await act(() => member("owner"))
    await waitFor(() => expect(result.current.access).toEqual({ state: "allowed" }))
  })

  it("denies a session this connection does not serve", async () => {
    mockResolve.mockResolvedValue({ orgId: "other", userId: "usr_me", client: { baseUrl: BASE } })
    const { result } = renderHook(() => useSharedRoomSettings(session))
    await waitFor(() => expect(result.current.access).toEqual({ state: "denied", role: null }))
  })

  it("is still checking for a session that is not shared", () => {
    const { result } = renderHook(() => useSharedRoomSettings({ id: "plain" } as ChatSession))
    expect(result.current.access).toEqual({ state: "checking" })
  })
})
