/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/settings/externalServices.json"
import zh from "@/i18n/messages/zh-CN/settings/externalServices.json"
import { listAuthConnections } from "@/lib/db/auth-connections"
import { listCapabilityGrants, listServiceConnections } from "@/lib/db/external-services"
import { listPlugins } from "@/lib/db/plugins"
import { getConnectionManager, disconnect } from "@/lib/plugin/auth/connection-manager"
import { connectProvider } from "@/lib/plugin/auth/connect"
import { revokeConsumerAccess } from "@/lib/plugin/auth/revoke-consumer-access"
import { ConnectionsPanel } from "./connections-panel"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"

jest.mock("@/lib/db/auth-connections", () => ({ listAuthConnections: jest.fn() }))
jest.mock("@/lib/db/external-services", () => ({
  listServiceConnections: jest.fn(),
  listCapabilityGrants: jest.fn(),
}))
jest.mock("@/lib/db/plugins", () => ({ listPlugins: jest.fn() }))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  getConnectionManager: jest.fn(() => ({ onDidChange: jest.fn(() => jest.fn()) })),
  disconnect: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/auth/connect", () => ({ connectProvider: jest.fn(async () => "host") }))
jest.mock("@/lib/plugin/auth/revoke-consumer-access", () => ({
  revokeConsumerAccess: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({
  listProviders: () => [{ id: "vendor", label: "Vendor", pluginId: "owner", describe: () => {} }],
  subscribeAuthProviders: () => () => {},
  getAuthProviderRevision: () => 0,
}))
jest.mock("@/lib/integrations/registry", () => ({
  listRegisteredIntegrationEntries: () => [],
  subscribeIntegrationRegistry: () => () => {},
  getIntegrationRegistryRevision: () => 0,
}))

const row: AuthConnectionRow = {
  id: "host" as AuthConnectionRow["id"],
  providerId: "vendor",
  ownerPluginId: "owner",
  publisher: null,
  contractMajor: 1,
  issuer: "https://issuer.test",
  clientId: "client",
  principalId: "person",
  principalKind: "user",
  accountLabel: "Person",
  tenantLabel: "Team",
  scopes: ["read"],
  revision: 2,
  credentialRevision: 1,
  lineageId: "lineage",
  identityKey: "identity",
  status: "needs-reauth",
  createdAt: 0,
  updatedAt: 0,
}
function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ settings: { externalServices: en } }}>
      <ConnectionsPanel />
    </NextIntlClientProvider>
  )
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(listAuthConnections).mockResolvedValue([row])
  jest.mocked(listServiceConnections).mockResolvedValue([
    {
      id: "projection",
      providerId: "api",
      serviceId: "items",
      pluginId: "consumer",
      runtimeTargetId: "local",
      providerFingerprint: "fp",
      status: "connected",
      providerRef: { kind: "integration", accountId: "account", authConnectionRef: "host" },
      enabledSurfaces: ["chat"],
      createdAt: "",
      updatedAt: "",
    },
  ])
  jest.mocked(listCapabilityGrants).mockResolvedValue([
    {
      id: "grant",
      connectionId: "projection",
      providerFingerprint: "fp",
      consumerPluginId: "consumer",
      connectionRevision: 1,
      operationPatterns: ["items.list"],
      createdAt: "",
      updatedAt: "",
    },
  ])
  jest
    .mocked(listPlugins)
    .mockResolvedValue([{ id: "consumer", manifest: { name: "Calendar" } }] as never)
})

it("signs in, reconnects, revokes one consumer, and disconnects only after confirming data retention", async () => {
  mount()
  const user = userEvent.setup()
  await screen.findByText("Person")
  expect(screen.getByText("Needs re-approval")).toBeVisible()
  expect(screen.getByText("Team")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "Sign in to Vendor" }))
  await waitFor(() =>
    expect(connectProvider).toHaveBeenCalledWith({ providerId: "vendor", scopes: [] })
  )
  await user.click(screen.getByRole("button", { name: "Reconnect" }))
  await waitFor(() =>
    expect(connectProvider).toHaveBeenCalledWith({
      providerId: "vendor",
      reconnect: "host",
      scopes: ["read"],
    })
  )
  await user.click(screen.getByRole("button", { name: "Revoke access for Calendar" }))
  await waitFor(() => expect(revokeConsumerAccess).toHaveBeenCalledWith("host", "consumer"))
  await user.click(screen.getByRole("button", { name: "Disconnect" }))
  expect(disconnect).not.toHaveBeenCalled()
  const dialog = screen.getByRole("alertdialog", { name: "Disconnect Person?" })
  expect(within(dialog).getByText(en.connections.disconnectDescription)).toBeVisible()
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
  expect(disconnect).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Disconnect" }))
  await user.click(screen.getByRole("button", { name: "Disconnect and revoke" }))
  await waitFor(() => expect(disconnect).toHaveBeenCalledWith("host", { revoke: true }))
})

it("rerenders from manager changes, shows the empty state, and unsubscribes on unmount", async () => {
  const { unmount } = mount()
  await screen.findByText("Person")
  const manager = jest.mocked(getConnectionManager).mock.results[0].value
  const listener = manager.onDidChange.mock.calls[0][0]
  jest.mocked(listAuthConnections).mockResolvedValue([{ ...row, status: "connected", revision: 3 }])
  act(() => listener({ ...row, ref: row.id, status: "connected" }, "changed"))
  await screen.findByText("Connection revision: 3")
  expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument()
  jest.mocked(listAuthConnections).mockResolvedValue([])
  act(() => listener({ ...row, ref: row.id, status: "tombstoned" }, "removed"))
  await screen.findByText(en.connections.empty)
  expect(screen.queryByText("Person")).not.toBeInTheDocument()
  unmount()
  expect(manager.onDidChange.mock.results[0].value).toHaveBeenCalledTimes(1)
})

it("reports an action failure without displaying provider exceptions", async () => {
  jest.mocked(connectProvider).mockRejectedValueOnce(new Error("private-provider-detail"))
  mount()
  await screen.findByText("Person")
  await userEvent.click(screen.getByRole("button", { name: "Sign in to Vendor" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(en.connections.failed)
  expect(screen.queryByText("private-provider-detail")).not.toBeInTheDocument()
})

it("has matching Settings translation keys in both locales", () => {
  function keys(value: object, prefix = ""): string[] {
    return Object.entries(value).flatMap(([key, item]) =>
      typeof item === "object" ? keys(item, `${prefix}${key}.`) : [`${prefix}${key}`]
    )
  }
  expect(keys(en).sort()).toEqual(keys(zh).sort())
})
