/** @jest-environment jsdom */
import { listGoogleConnections } from "@/lib/auth-providers/google/host-auth"
jest.mock("@/lib/auth-providers/google/host-auth", () => ({
  listGoogleConnections: jest.fn(async () => []),
}))
import "fake-indexeddb/auto"
import { act, renderHook, waitFor } from "@testing-library/react"
import { listAuthConnections } from "@/lib/db/auth-connections"
import {
  listProviders,
  subscribeAuthProviders,
  getAuthProviderRevision,
} from "@/lib/plugin/auth/auth-provider-registry"
import { useAuthConnections } from "./use-auth-connections"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { listLarkConnections } from "@/lib/connectors/adapters/lark/host-auth"
import { useHostProfile } from "@/hooks/use-host-profile"

jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: jest.fn(() => "desktop") }))
jest.mock("@/lib/connectors/adapters/lark/host-auth", () => ({
  listLarkConnections: jest.fn(async () => []),
}))

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
  expect(listLarkConnections).toHaveBeenCalledWith({ localAuthorization: LOCAL_PERSON_RUN })
  expect(listGoogleConnections).toHaveBeenCalledWith({ localAuthorization: LOCAL_PERSON_RUN })
  jest
    .mocked(listProviders)
    .mockReturnValue([{ id: "vendor", describe: () => {} }, { id: "legacy" }] as never)
  jest.mocked(getAuthProviderRevision).mockReturnValue(1)
  act(() => jest.mocked(subscribeAuthProviders).mock.calls[0][0]())
  expect(result.current.providers.map((provider) => provider.id)).toEqual(["vendor"])
})

it("does not mint Host discovery admission from a companion account list", async () => {
  jest.mocked(useHostProfile).mockReturnValue("cloud-companion")
  jest.mocked(listLarkConnections).mockClear()
  jest.mocked(listGoogleConnections).mockClear()
  try {
    const { result } = renderHook(useAuthConnections)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(listLarkConnections).not.toHaveBeenCalled()
    expect(listGoogleConnections).not.toHaveBeenCalled()
  } finally {
    jest.mocked(useHostProfile).mockReturnValue("desktop")
  }
})

it("distinguishes a storage failure from an empty connection list", async () => {
  jest.mocked(listAuthConnections).mockRejectedValueOnce(new Error("storage unavailable"))
  const { result } = renderHook(useAuthConnections)
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.loading).toBe(false)
})
