/** @jest-environment jsdom */

import type { CollabHealth } from "./client"
import {
  __setSharedChatAvailabilityDepsForTesting,
  keepsSharedChatRunning,
  sharedChatInertMessageKey,
  probeSharedChatAvailability,
  readSharedChatAvailability,
  refreshSharedChatAvailability,
  SHARED_CHAT_AVAILABILITY_TTL_MS,
  SHARED_CHAT_TRANSIENT_TTL_MS,
  subscribeSharedChatAvailability,
  type SharedChatAvailabilityDeps,
  type SharedChatUnavailableReason,
} from "./shared-chat-availability"
import { saveCollabConnection } from "./connection"
import { writeSharedChatPreference } from "./shared-chat-feature"

const SERVING: CollabHealth = {
  status: "ok",
  collabProtocolVersion: 2,
  features: ["shared-chat", "shared-chat-execution-v2"],
}

function deps(overrides: Partial<SharedChatAvailabilityDeps> = {}): SharedChatAvailabilityDeps {
  return {
    accountId: () => "acct",
    clientEnabled: () => true,
    hasServer: () => true,
    readHealth: async () => SERVING,
    now: () => 1_000,
    ...overrides,
  }
}

describe("probeSharedChatAvailability", () => {
  it("is available when the server serves shared chat at this client's protocol", async () => {
    await expect(probeSharedChatAvailability(deps())).resolves.toEqual({
      state: "available",
      accountId: "acct",
      checkedAt: 1_000,
    })
    await expect(
      probeSharedChatAvailability(
        deps({ readHealth: async () => ({ ...SERVING, collabProtocolVersion: 3 }) })
      )
    ).resolves.toMatchObject({ state: "available" })
  })

  const cases: Array<[SharedChatUnavailableReason, Partial<SharedChatAvailabilityDeps>]> = [
    ["turned_off", { clientEnabled: () => false }],
    ["no_server", { hasServer: () => false }],
    ["not_signed_in", { readHealth: async () => null }],
    [
      "server_unreachable",
      {
        readHealth: async () => {
          throw new Error("offline")
        },
      },
    ],
    ["not_offered", { readHealth: async () => ({ status: "ok", collabProtocolVersion: 2 }) }],
    [
      "not_offered",
      { readHealth: async () => ({ ...SERVING, features: ["canvas"] }) as CollabHealth },
    ],
    [
      "protocol_unsupported",
      { readHealth: async () => ({ ...SERVING, collabProtocolVersion: 1 }) },
    ],
    [
      "protocol_unsupported",
      { readHealth: async () => ({ status: "ok", features: ["shared-chat"] }) },
    ],
  ]
  it.each(cases)("names %s", async (reason, overrides) => {
    await expect(probeSharedChatAvailability(deps(overrides))).resolves.toEqual({
      state: "unavailable",
      reason,
      accountId: "acct",
      checkedAt: 1_000,
    })
  })

  it("asks nothing of the server once the machine said no, or has none", async () => {
    const readHealth = jest.fn(async () => SERVING)
    await probeSharedChatAvailability(deps({ clientEnabled: () => false, readHealth }))
    await probeSharedChatAvailability(deps({ hasServer: () => false, readHealth }))
    expect(readHealth).not.toHaveBeenCalled()
  })
})

describe("keepsSharedChatRunning", () => {
  it("keeps the plane up while offered or only out of reach", () => {
    expect(keepsSharedChatRunning({ state: "checking" })).toBe(false)
    expect(keepsSharedChatRunning({ state: "available", accountId: "a", checkedAt: 0 })).toBe(true)
    expect(
      keepsSharedChatRunning({
        state: "unavailable",
        reason: "server_unreachable",
        accountId: "a",
        checkedAt: 0,
      })
    ).toBe(true)
    for (const reason of ["turned_off", "no_server", "not_offered"] as const) {
      expect(
        keepsSharedChatRunning({ state: "unavailable", reason, accountId: "a", checkedAt: 0 })
      ).toBe(false)
    }
  })
})

describe("sharedChatInertMessageKey", () => {
  it("names why an entry point is inert, and nothing once offered", () => {
    expect(sharedChatInertMessageKey({ state: "available", accountId: "a", checkedAt: 0 })).toBe(
      null
    )
    expect(sharedChatInertMessageKey({ state: "checking" })).toBe("availability.checking")
    expect(
      sharedChatInertMessageKey({
        state: "unavailable",
        reason: "not_offered",
        accountId: "a",
        checkedAt: 0,
      })
    ).toBe("unavailable.not_offered")
  })
})

describe("the availability snapshot", () => {
  let now = 1_000
  let account = "acct"
  let health: () => Promise<CollabHealth | null>

  beforeEach(() => {
    now = 1_000
    account = "acct"
    health = jest.fn(async () => SERVING)
    localStorage.clear()
    __setSharedChatAvailabilityDepsForTesting({
      accountId: () => account,
      hasServer: () => true,
      readHealth: () => health(),
      now: () => now,
    })
  })

  afterAll(() => __setSharedChatAvailabilityDepsForTesting(null))

  it("starts checking, settles once, and shares one probe between callers", async () => {
    expect(readSharedChatAvailability()).toEqual({ state: "checking" })
    const [first, second] = await Promise.all([
      refreshSharedChatAvailability(),
      refreshSharedChatAvailability(),
    ])
    expect(first).toEqual(second)
    expect(health).toHaveBeenCalledTimes(1)
    expect(readSharedChatAvailability()).toMatchObject({ state: "available" })
  })

  it("holds a settled answer for the TTL, and a transient one for less", async () => {
    await refreshSharedChatAvailability()
    now += SHARED_CHAT_AVAILABILITY_TTL_MS - 1
    await refreshSharedChatAvailability()
    expect(health).toHaveBeenCalledTimes(1)
    now += 1
    await refreshSharedChatAvailability()
    expect(health).toHaveBeenCalledTimes(2)

    health = jest.fn(async () => {
      throw new Error("offline")
    })
    await refreshSharedChatAvailability({ force: true })
    expect(readSharedChatAvailability()).toMatchObject({ reason: "server_unreachable" })
    now += SHARED_CHAT_TRANSIENT_TTL_MS
    await refreshSharedChatAvailability()
    expect(health).toHaveBeenCalledTimes(2)
  })

  it("drops a probe a newer change overtook", async () => {
    let release: (value: CollabHealth) => void = () => {}
    health = () => new Promise((resolve) => (release = resolve))
    const late = refreshSharedChatAvailability()
    health = async () => ({ status: "ok", collabProtocolVersion: 2, features: [] })
    await refreshSharedChatAvailability({ force: true })
    release(SERVING)
    await late
    expect(readSharedChatAvailability()).toMatchObject({ reason: "not_offered" })
  })

  it("never shows one account's answer to another", async () => {
    await refreshSharedChatAvailability()
    account = "other"
    expect(readSharedChatAvailability()).toEqual({ state: "checking" })
    await refreshSharedChatAvailability()
    expect(health).toHaveBeenCalledTimes(2)
    expect(readSharedChatAvailability()).toMatchObject({ state: "available", accountId: "other" })
  })

  it("asks again when the preference, the connection or the network changes", async () => {
    const listener = jest.fn()
    const unsubscribe = subscribeSharedChatAvailability(listener)
    await refreshSharedChatAvailability()
    expect(listener).toHaveBeenCalledTimes(1)

    writeSharedChatPreference(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readSharedChatAvailability()).toMatchObject({ reason: "turned_off" })

    writeSharedChatPreference(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(readSharedChatAvailability()).toMatchObject({ state: "available" })

    saveCollabConnection("acct", { baseUrl: "https://collab.example" })
    window.dispatchEvent(new Event("online"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(health).toHaveBeenCalledTimes(4)

    unsubscribe()
    writeSharedChatPreference(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(health).toHaveBeenCalledTimes(4)
  })
})
