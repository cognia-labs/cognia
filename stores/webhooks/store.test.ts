/** @jest-environment jsdom */

import { selectWebhookConfig, useWebhookStore } from "./store"
import { setWebhookSigningSecret } from "@/lib/webhooks/signing-secret"
import { DEFAULT_WEBHOOK_DELIVERY } from "@/types/webhooks"

jest.mock("@/lib/webhooks/signing-secret", () => ({
  setWebhookSigningSecret: jest.fn(),
}))

const setSecret = setWebhookSigningSecret as jest.MockedFunction<typeof setWebhookSigningSecret>

beforeEach(() => {
  jest.clearAllMocks()
  localStorage.clear()
  useWebhookStore.getState().reset()
})

describe("useWebhookStore", () => {
  it("starts with outbound-only defaults", () => {
    const config = selectWebhookConfig(useWebhookStore.getState())
    expect(config.hasSigningSecret).toBe(false)
    expect(config.defaultHeaders).toEqual([])
    expect(config.endpoints).toEqual([])
    expect(config.delivery).toEqual(DEFAULT_WEBHOOK_DELIVERY)
    expect(useWebhookStore.getState()).not.toHaveProperty("status")
    expect(useWebhookStore.getState()).not.toHaveProperty("startInbound")
  })

  it("deep-clones endpoint arrays and delivery settings", async () => {
    const endpoint = {
      id: "ep_1",
      name: "hook",
      url: "https://x.test",
      headers: [{ name: "X-A", value: "1" }],
      enabled: true,
      eventTypes: ["complete"],
    }
    await useWebhookStore.getState().updateConfig({
      endpoints: [endpoint],
      delivery: { maxRetries: 5, timeoutMs: 20000, baseDelayMs: 2000 },
    })

    endpoint.headers[0].value = "mutated"
    endpoint.eventTypes.push("error")
    expect(useWebhookStore.getState().config.endpoints[0].headers[0].value).toBe("1")
    expect(useWebhookStore.getState().config.endpoints[0].eventTypes).toEqual(["complete"])
    expect(useWebhookStore.getState().config.delivery).toEqual({
      maxRetries: 5,
      timeoutMs: 20000,
      baseDelayMs: 2000,
    })
  })

  it("updates default headers through the canonical action", async () => {
    await useWebhookStore
      .getState()
      .setDefaultHeaders([{ name: "Authorization", value: "Bearer x" }])
    expect(useWebhookStore.getState().config.defaultHeaders).toEqual([
      { name: "Authorization", value: "Bearer x" },
    ])
  })

  it("updates the secret mirror only after the shared keyring succeeds", async () => {
    setSecret.mockResolvedValue(undefined)
    await expect(useWebhookStore.getState().setSigningSecret("hunter2")).resolves.toEqual({
      ok: true,
    })
    expect(setSecret).toHaveBeenCalledWith("hunter2")
    expect(useWebhookStore.getState().config.hasSigningSecret).toBe(true)

    await useWebhookStore.getState().setSigningSecret("")
    expect(setSecret).toHaveBeenLastCalledWith(null)
    expect(useWebhookStore.getState().config.hasSigningSecret).toBe(false)
  })

  it("keeps the secret mirror unchanged when keyring storage fails", async () => {
    setSecret.mockRejectedValue(new Error("keyring offline"))
    const result = await useWebhookStore.getState().setSigningSecret("hunter2")
    expect(result).toEqual({ ok: false, error: "keyring offline" })
    expect(useWebhookStore.getState().config.hasSigningSecret).toBe(false)
    expect(useWebhookStore.getState().lastError).toBe("keyring offline")
  })
})
