/** @jest-environment jsdom */
jest.mock("next-intl", () => {
  const messages = {
    plugins: { auth: jest.requireActual("@/i18n/messages/en/plugins/auth.json") },
    settings: {
      externalServices: jest.requireActual("@/i18n/messages/en/settings/externalServices.json"),
    },
  }
  return {
    useLocale: () => "en",
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
      const value = `${namespace}.${key}`
        .split(".")
        .reduce<unknown>(
          (item, segment) =>
            item && typeof item === "object"
              ? (item as Record<string, unknown>)[segment]
              : undefined,
          messages
        )
      return Object.entries(values ?? {}).reduce(
        (text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)),
        typeof value === "string" ? value : key
      )
    },
    NextIntlClientProvider: ({ children }: { children: import("react").ReactNode }) => children,
  }
})
import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en/settings/externalServices.json"
import zh from "@/i18n/messages/zh-CN/settings/externalServices.json"
import auth from "@/i18n/messages/en/plugins/auth.json"
import { listAuthConnections } from "@/lib/db/auth-connections"
import { listCapabilityGrants, listServiceConnections } from "@/lib/db/external-services"
import { listPlugins } from "@/lib/db/plugins"
import {
  getConnectionManager,
  disconnect,
  registerHostConnectionDriver,
  ConnectionIdentityConflict,
} from "@/lib/plugin/auth/connection-manager"
import { listProviders } from "@/lib/plugin/auth/auth-provider-registry"
import { AuthConnectError, connectProvider } from "@/lib/plugin/auth/connect"
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
  ...jest.requireActual("@/lib/plugin/auth/connection-manager"),
  getConnectionManager: jest.fn(() => ({ onDidChange: jest.fn(() => jest.fn()) })),
  disconnect: jest.fn(async () => {}),
}))
jest.mock("@/hooks/use-connector-ingress", () => ({
  useConnectorIngress: () => ({ base: "https://relay.example" }),
}))
jest.mock("@/lib/plugin/auth/connect", () => ({
  ...jest.requireActual("@/lib/plugin/auth/connect"),
  connectProvider: jest.fn(async () => "host"),
}))
jest.mock("@/hooks/plugins/use-external-service-runtime-profile", () => ({
  useExternalServiceRuntimeProfile: () => ({ local: "browser", gateway: "browser" }),
}))
jest.mock("@/lib/plugin/auth/revoke-consumer-access", () => ({
  revokeConsumerAccess: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({
  listProviders: jest.fn(),
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
    <NextIntlClientProvider
      locale="en"
      messages={{ settings: { externalServices: en }, plugins: { auth } }}
    >
      <ConnectionsPanel />
    </NextIntlClientProvider>
  )
}
beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(listProviders)
    .mockReturnValue([
      { id: "vendor", label: "Vendor", pluginId: "owner", describe: () => {} },
    ] as never)
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

it("shows runtime reasons and pairing for unavailable providers and reconnects", async () => {
  jest.mocked(listPlugins).mockResolvedValue([
    {
      id: "owner",
      manifest: {
        authProviders: [{ id: "vendor", label: "Vendor", methods: ["client-credentials"] }],
      },
    },
  ] as never)
  mount()
  await screen.findByText("Person")
  expect(screen.getByRole("button", { name: "Sign in to Vendor" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled()
  expect(
    screen.getAllByText(auth.runtimeSupport.reasons["confidential-exchange-unavailable"])
  ).toHaveLength(2)
  expect(screen.getAllByRole("link", { name: "Pair with desktop" })[0]).toHaveAttribute(
    "href",
    "/pair"
  )
})

it("honors a manifest's declared trusted-exchange restriction even for public PKCE", async () => {
  jest.mocked(listPlugins).mockResolvedValue([
    {
      id: "owner",
      manifest: {
        runtimeCompatibility: {
          browser: { availability: "blocked", reason: "confidential-exchange-unavailable" },
        },
        authProviders: [{ id: "vendor", label: "Vendor", methods: ["oauth-pkce"] }],
      },
    },
  ] as never)
  mount()
  await screen.findByText("Person")
  expect(screen.getByRole("button", { name: "Sign in to Vendor" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled()
})

it("keeps a mapped vault failure recoverable without showing provider exceptions", async () => {
  jest.mocked(connectProvider).mockRejectedValueOnce(
    new AuthConnectError("UNAVAILABLE", "non-persistent-until-vault-unlock", {
      recovery: ["unlock-vault"],
    })
  )
  mount()
  await screen.findByText("Person")
  await userEvent.click(screen.getByRole("button", { name: "Sign in to Vendor" }))
  expect(await screen.findByRole("button", { name: "Unlock vault" })).toBeVisible()
})

it("maps duplicate-lineage refusal to the localized existing-connection reason", async () => {
  jest.mocked(connectProvider).mockRejectedValueOnce(new ConnectionIdentityConflict())
  mount()
  await screen.findByText("Person")
  await userEvent.click(screen.getByRole("button", { name: "Sign in to Vendor" }))
  expect(await screen.findByRole("alert")).toHaveTextContent(en.connections.identityConflict)
})

it.each(["lark", "google"])(
  "reauthorizes a %s Host connection through its provider flow",
  async (providerId) => {
    const reauthorize = jest.fn(async () => {})
    const dispose = registerHostConnectionDriver(providerId, {
      publisher: "cognia",
      getCredentials: async () => ({ accessToken: "unused", scopes: [] }),
      disconnect: async () => {},
      reauthorize,
    })
    jest
      .mocked(listProviders)
      .mockReturnValue([{ id: providerId, label: providerId, pluginId: null }] as never)
    jest
      .mocked(listAuthConnections)
      .mockResolvedValue([{ ...row, providerId, ownerPluginId: null }])
    try {
      mount()
      await screen.findByText("Person")
      await userEvent.click(screen.getByRole("button", { name: "Reconnect" }))
      await waitFor(() =>
        expect(reauthorize).toHaveBeenCalledWith("host", { ingressBase: "https://relay.example" })
      )
      expect(connectProvider).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  }
)

it("opens the shared device dialog for a Host reconnect and polls that authorization", async () => {
  const authorization = {
    kind: "device-code" as const,
    userCode: "PANEL-CODE",
    verificationUrl: "https://vendor.test/device",
    expiresAt: Date.now() + 60_000,
    intervalSeconds: 5,
    poll: jest.fn(async () => ({ status: "pending" as const })),
    cancel: jest.fn(async () => {}),
  }
  const reauthorize = jest.fn(async () => authorization)
  const dispose = registerHostConnectionDriver("device-vendor", {
    publisher: "cognia",
    getCredentials: async () => ({ accessToken: "unused", scopes: [] }),
    disconnect: async () => {},
    reauthorize,
  })
  jest
    .mocked(listAuthConnections)
    .mockResolvedValue([{ ...row, providerId: "device-vendor", ownerPluginId: null }])
  jest
    .mocked(listProviders)
    .mockReturnValue([{ id: "device-vendor", label: "Device vendor", pluginId: null }] as never)
  const view = mount()
  try {
    await screen.findByText("Person")
    jest.useFakeTimers()
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }))
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole("dialog", { name: auth.deviceTitle })).toBeVisible()
    expect(screen.getByText("PANEL-CODE")).toBeVisible()
    expect(reauthorize).toHaveBeenCalledWith("host", { ingressBase: "https://relay.example" })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000)
    })
    expect(authorization.poll).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: auth.deviceCancel }))
    expect(authorization.cancel).toHaveBeenCalledTimes(1)
  } finally {
    view.unmount()
    jest.useRealTimers()
    dispose()
  }
})
