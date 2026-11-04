const complete = jest.fn()
jest.mock("../host-llm-client", () => ({ createHostLlmClient: jest.fn(() => ({ complete })) }))
import { createHostLlmClient } from "../host-llm-client"
import { testHostProviderConnection } from "./host-connection"
beforeEach(() => {
  jest.clearAllMocks()
  complete.mockResolvedValue("OK")
})
it("tests the exact selected model and credentials through Host", async () => {
  const result = await testHostProviderConnection("openai", {
    apiKey: "private-key",
    baseURL: "http://127.0.0.1:8787/v1",
    defaultModel: "gpt-5.6-luna",
    apiFlavor: "chat",
    customHeaders: { "X-Tenant": "one" },
  })
  expect(result).toMatchObject({
    success: true,
    authoritative: true,
    outcome: "verified",
    model_info: "gpt-5.6-luna",
  })
  expect(createHostLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "gpt-5.6-luna",
      apiKey: "private-key",
      headers: { "X-Tenant": "one" },
    }),
    "provider-connection-test"
  )
  expect(complete).toHaveBeenCalledWith("Reply with OK.", { maxTokens: 16, temperature: 0 })
})
it("does not mistake empty output for a verified connection", async () => {
  complete.mockResolvedValue("  ")
  expect(
    await testHostProviderConnection("openai", { apiKey: "private-key", defaultModel: "gpt-x" })
  ).toMatchObject({ success: false, outcome: "failed" })
})
it("propagates failure without exposing the tested credential", async () => {
  complete.mockRejectedValue(new Error("Rejected private-key"))
  const result = await testHostProviderConnection("openai", {
    apiKey: "private-key",
    defaultModel: "gpt-x",
  })
  expect(result.success).toBe(false)
  expect(result.message).not.toContain("private-key")
})
it("tests custom protocols without falling back to a different provider", async () => {
  expect(
    (
      await testHostProviderConnection("custom-relay", {
        apiKey: "k",
        baseURL: "http://relay/v1",
        defaultModel: "relay-model",
        protocol: "openai",
      })
    ).success
  ).toBe(true)
  expect(createHostLlmClient).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "custom-relay",
      model: "relay-model",
      protocol: "openai",
    }),
    "provider-connection-test"
  )
})
