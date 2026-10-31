import {
  setProviderClientSecret,
  clearProviderClientSecret,
  hasProviderClientSecret,
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
  await expect(setProviderClientSecret("owner", "acme", "secret")).resolves.toBeUndefined()
  await expect(hasProviderClientSecret("owner", "acme")).resolves.toBe(true)
  await expect(clearProviderClientSecret("owner", "acme")).resolves.toBeUndefined()
  expect(jest.mocked(invokePluginApi).mock.calls).toEqual([
    ["owner", "auth:setClientSecret", { providerId: "acme", value: "secret" }],
    ["owner", "auth:hasClientSecret", { providerId: "acme" }],
    ["owner", "auth:clearClientSecret", { providerId: "acme" }],
  ])
})

it("refuses every configuration operation without a trusted gateway", async () => {
  jest.mocked(isPluginGatewayAvailable).mockReturnValue(false)
  for (const operation of [
    () => setProviderClientSecret("owner", "acme", "secret"),
    () => clearProviderClientSecret("owner", "acme"),
    () => hasProviderClientSecret("owner", "acme"),
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
  await expect(setProviderClientSecret("owner", "foreign", "secret")).rejects.toBe(error)
})
