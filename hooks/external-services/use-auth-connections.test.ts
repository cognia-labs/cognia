/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { listAuthConnections } from "@/lib/db/auth-connections"
import {
  listProviders,
  subscribeAuthProviders,
  getAuthProviderRevision,
} from "@/lib/plugin/auth/auth-provider-registry"
import { useAuthConnections } from "./use-auth-connections"

jest.mock("@/lib/db/auth-connections", () => ({ listAuthConnections: jest.fn(async () => []) }))
jest.mock("@/lib/db/external-services", () => ({
  listServiceConnections: async () => [],
  listCapabilityGrants: async () => [],
}))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: async () => [] }))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  getConnectionManager: () => ({ onDidChange: () => () => {} }),
}))
jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({
  listProviders: jest.fn(() => []),
  subscribeAuthProviders: jest.fn(() => () => {}),
  getAuthProviderRevision: jest.fn(() => 0),
}))
jest.mock("@/lib/integrations/registry", () => ({
  listRegisteredIntegrationEntries: () => [],
  subscribeIntegrationRegistry: () => () => {},
  getIntegrationRegistryRevision: () => 0,
}))

it("updates the sign-in choices when a provider registers with no existing connection", async () => {
  const { result } = renderHook(useAuthConnections)
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.providers).toEqual([])
  jest
    .mocked(listProviders)
    .mockReturnValue([{ id: "vendor", describe: () => {} }, { id: "legacy" }] as never)
  jest.mocked(getAuthProviderRevision).mockReturnValue(1)
  act(() => jest.mocked(subscribeAuthProviders).mock.calls[0][0]())
  expect(result.current.providers.map((provider) => provider.id)).toEqual(["vendor"])
})

it("distinguishes a storage failure from an empty connection list", async () => {
  jest.mocked(listAuthConnections).mockRejectedValueOnce(new Error("storage unavailable"))
  const { result } = renderHook(useAuthConnections)
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.loading).toBe(false)
})
