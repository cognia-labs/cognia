import { buildConnectionViews } from "./connection-view"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import type { CapabilityGrant, ServiceConnection } from "@/types/external-service"
import type { PluginIntegrationDef } from "@/types/plugin/plugin-integration"
import type { AuthenticationProvider } from "@/lib/plugin/auth/auth-provider-registry"
import { registerHostConnectionDriver } from "@/lib/plugin/auth/connection-manager"

const connection: AuthConnectionRow = {
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
  scopes: ["read"],
  revision: 3,
  credentialRevision: 1,
  lineageId: "lineage",
  identityKey: "identity",
  status: "needs-reauth",
  createdAt: 0,
  updatedAt: 0,
}

it("offers reauthentication through a registered Rust-backed Host driver", () => {
  const dispose = registerHostConnectionDriver("lark", {
    publisher: "cognia",
    getCredentials: async () => ({ accessToken: "unused", scopes: [] }),
    disconnect: async () => {},
    reauthorize: async () => {},
  })
  try {
    const [view] = buildConnectionViews(
      [{ ...connection, providerId: "lark", ownerPluginId: null }],
      [],
      [],
      [{ id: "lark", pluginId: null, label: "Lark" } as AuthenticationProvider],
      [],
      []
    )
    expect(view.canReconnect).toBe(true)
  } finally {
    dispose()
  }
})
const projection = (id: string): ServiceConnection => ({
  id,
  pluginId: "consumer",
  serviceId: "items",
  providerId: "api",
  runtimeTargetId: "local",
  status: "connected",
  providerFingerprint: "fp",
  providerRef: { kind: "integration", accountId: id, authConnectionRef: connection.id },
  enabledSurfaces: ["chat"],
  createdAt: "",
  updatedAt: "",
})
const grant = (id: string, consumerPluginId = "consumer"): CapabilityGrant => ({
  id,
  consumerPluginId,
  connectionId: "projection",
  connectionRevision: 3,
  providerFingerprint: "fp",
  operationPatterns: ["items.list", "items.request.GET", "items.remove", "items.*"],
  createdAt: "",
  updatedAt: "",
})
const integration: PluginIntegrationDef = {
  id: "items",
  label: "Items",
  authStrategies: [],
  resourceKinds: [],
  eventTypes: [],
  actions: [
    {
      id: "list",
      label: "List",
      handler: "list",
      risk: "read",
      idempotency: "supported",
      inputSchema: {},
    },
    {
      id: "remove",
      label: "Remove",
      handler: "remove",
      risk: "destructive",
      idempotency: "supported",
      inputSchema: {},
    },
  ],
}
const provider = {
  id: "vendor",
  pluginId: "owner",
  label: "Vendor",
  describe: () => {},
} as unknown as AuthenticationProvider

it("groups consumers across projections, classifies operations and flags stale revisions", () => {
  const [view] = buildConnectionViews(
    [connection],
    [projection("projection"), projection("second")],
    [
      grant("one"),
      { ...grant("old"), connectionRevision: 2, connectionId: "second" },
      grant("other", "other"),
      { ...grant("expired"), expiresAt: "2020-01-01" },
      { ...grant("unrelated"), connectionId: "foreign" },
    ],
    [provider],
    [{ id: "consumer", manifest: { name: "Business" } }],
    [{ pluginId: "consumer", definition: integration }]
  )
  expect(view.providerLabel).toBe("Vendor")
  expect(view.canReconnect).toBe(true)
  expect(view.consumers.map((row) => row.name)).toEqual(["Business", "other"])
  expect(view.consumers[0].grants).toEqual([
    {
      id: "one",
      revision: 3,
      needsReapproval: false,
      readOperations: ["items.list", "items.request.GET"],
      writeOperations: ["items.remove", "items.*"],
    },
    expect.objectContaining({ id: "old", revision: 2, needsReapproval: true }),
  ])
})

it("hides terminal rows and only reconnects when the owning provider has returned", () => {
  const rows = [
    connection,
    { ...connection, id: "revoked" as AuthConnectionRow["id"], status: "revoked" as const },
    { ...connection, id: "gone" as AuthConnectionRow["id"], status: "tombstoned" as const },
  ]
  const views = buildConnectionViews(rows, [], [], [], [], [])
  expect(views).toHaveLength(1)
  expect(views[0]).toMatchObject({ providerLabel: "vendor", canReconnect: false, consumers: [] })
  expect(
    buildConnectionViews(
      [{ ...connection, status: "provider-unavailable" }],
      [],
      [],
      [provider],
      [],
      []
    )[0].canReconnect
  ).toBe(true)
  expect(
    buildConnectionViews([connection], [], [], [{ ...provider, pluginId: "impostor" }], [], [])[0]
      .canReconnect
  ).toBe(false)
})
