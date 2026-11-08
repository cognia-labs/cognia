/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import type { CollabHealth } from "@/lib/collab/client"
import { __setSharedChatAvailabilityDepsForTesting } from "@/lib/collab/shared-chat-availability"
import { writeSharedChatPreference } from "@/lib/collab/shared-chat-feature"

import { useSharedChatAvailability, useSharedChatEnabled } from "./use-shared-chat-enabled"

let mockAccount = "acct"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (select: (state: { unlockedAccountId: string }) => unknown) =>
    select({ unlockedAccountId: mockAccount }),
}))

const SERVING: CollabHealth = {
  status: "ok",
  collabProtocolVersion: 2,
  features: ["shared-chat"],
}

describe("useSharedChatAvailability", () => {
  let health: jest.Mock<Promise<CollabHealth | null>, []>
  let hasServer = true

  beforeEach(() => {
    localStorage.clear()
    mockAccount = "acct"
    hasServer = true
    health = jest.fn(async () => SERVING)
    __setSharedChatAvailabilityDepsForTesting({
      accountId: () => mockAccount,
      hasServer: () => hasServer,
      readHealth: () => health(),
    })
  })

  afterAll(() => __setSharedChatAvailabilityDepsForTesting(null))

  it("says checking first, then what the server offers", async () => {
    const { result } = renderHook(() => useSharedChatAvailability())
    expect(result.current).toEqual({ state: "checking" })
    await waitFor(() => expect(result.current.state).toBe("available"))
  })

  it("names the reason when shared chat is not offered here", async () => {
    hasServer = false
    const { result } = renderHook(() => useSharedChatAvailability())
    await waitFor(() => expect(result.current).toMatchObject({ reason: "no_server" }))
  })

  it("follows the switch without a reload", async () => {
    // The point of the subscription: a header that keeps offering to share a
    // conversation after the setting was turned off is a lie the user cannot
    // see through.
    const { result } = renderHook(() => useSharedChatEnabled())
    await waitFor(() => expect(result.current).toBe(true))

    act(() => writeSharedChatPreference(false))
    await waitFor(() => expect(result.current).toBe(false))

    act(() => writeSharedChatPreference(true))
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("asks again for another account", async () => {
    const { result, rerender } = renderHook(() => useSharedChatAvailability())
    await waitFor(() => expect(result.current.state).toBe("available"))
    mockAccount = "other"
    health.mockResolvedValueOnce({ status: "ok", collabProtocolVersion: 2, features: [] })
    rerender()
    await waitFor(() =>
      expect(result.current).toMatchObject({ reason: "not_offered", accountId: "other" })
    )
  })
})
