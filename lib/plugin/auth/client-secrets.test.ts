import {
  setProviderClientSecret,
  clearProviderClientSecret,
  hasProviderClientSecret,
  isClientSecretRequired,
} from "./client-secrets"
import {
  invokePluginApi,
  isPluginGatewayAvailable,
  PluginGatewayError,
} from "@/lib/plugin/core/transport"

jest.mock("@/lib/plugin/core/transport", () => ({
  ...jest.requireActual("@/lib/plugin/core/transport"),
  invokePluginApi: jest.fn(),
  isPluginGatewayAvailable: jest.fn(() => true),
}))

beforeEach(() => {
  jest.mocked(invokePluginApi).mockReset()
  jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
})

it("routes Host configuration to the selected plugin and exposes only presence", async () => {
  jest
    .mocked(invokePluginApi)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(undefined)
  await expect(
    setProviderClientSecret("owner", "acme", "client", "secret", "https://issuer.test")
  ).resolves.toBeUndefined()
  await expect(
    hasProviderClientSecret("owner", "acme", "client", "https://issuer.test")
  ).resolves.toBe(true)
  await expect(
    clearProviderClientSecret("owner", "acme", "client", "https://issuer.test")
  ).resolves.toBeUndefined()
  expect(jest.mocked(invokePluginApi).mock.calls).toEqual([
    [
      "owner",
      "auth:setClientSecret",
      { providerId: "acme", clientId: "client", issuer: "https://issuer.test", value: "secret" },
    ],
    [
      "owner",
      "auth:hasClientSecret",
      { providerId: "acme", clientId: "client", issuer: "https://issuer.test" },
    ],
    [
      "owner",
      "auth:clearClientSecret",
      { providerId: "acme", clientId: "client", issuer: "https://issuer.test" },
    ],
  ])
})

it("refuses every configuration operation without a trusted gateway", async () => {
  jest.mocked(isPluginGatewayAvailable).mockReturnValue(false)
  for (const operation of [
    () => setProviderClientSecret("owner", "acme", "client", "secret"),
    () => clearProviderClientSecret("owner", "acme", "client"),
    () => hasProviderClientSecret("owner", "acme", "client"),
  ]) {
    const result = operation()
    await expect(result).rejects.toBeInstanceOf(PluginGatewayError)
    await expect(result).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      details: { reason: "confidential-exchange-unavailable" },
    })
  }
  expect(invokePluginApi).not.toHaveBeenCalled()
})

it("preserves typed Host store and authorization failures", async () => {
  const error = new PluginGatewayError({
    code: "PERMISSION_DENIED",
    message: "undeclared provider",
    pluginId: "owner",
    api: "auth:setClientSecret",
    requestId: "req",
  })
  jest.mocked(invokePluginApi).mockRejectedValueOnce(error)
  await expect(setProviderClientSecret("owner", "foreign", "client", "secret")).rejects.toBe(error)
})

it("distinguishes client-secret re-entry from unrelated Host failures", () => {
  for (const reason of ["client-secret-missing", "client-secret-ambiguous"]) {
    expect(isClientSecretRequired({ code: "NOT_FOUND", details: { reason } })).toBe(true)
  }
  for (const error of [
    null,
    undefined,
    { code: "NOT_FOUND" },
    { code: "INTERNAL", details: { reason: "client-secret-missing" } },
  ]) {
    expect(isClientSecretRequired(error)).toBe(false)
  }
})
