/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getAuthConnection } from "@/lib/db/auth-connections"
import { getConnectionBinding, putConnectionBinding } from "@/lib/db/connection-bindings"
import { createIntegrationAccount, listIntegrationAccounts } from "@/lib/db/integrations"
import { listConsumerGrants, listServiceConnections } from "@/lib/db/external-services"
import {
  registerExternalServices,
  unregisterExternalServicesByPlugin,
  listExternalServices,
} from "@/lib/external-services/catalog"
import {
  registerIntegrationDefinitions,
  __resetIntegrationRegistryForTesting,
  getRegisteredIntegration,
} from "@/lib/integrations/registry"
import {
  authenticatedIntegrationRequest,
  ConsumerGrantRequired,
  executeIntegrationAction,
  runIntegrationActionJob,
} from "@/lib/integrations/action-runner"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { getPlugin } from "@/lib/db/plugins"
import { createAuthAPI } from "@/lib/plugin/api/auth-api"
import { createIntegrationsAPI } from "@/lib/plugin/api/integrations-api"
import {
  registerAuthenticationProvider,
  __resetAuthRegistryForTesting,
  getProvider,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import { AuthConnectionManager, getConnectionManager } from "./connection-manager"
import { ConnectionCredentialStore, HostAuthSecrets } from "./connection-credentials"
import { createAuthConnectionsAPI } from "./connections-api"
import { connectProvider } from "./connect"
import { revokeConsumerAccess } from "./revoke-consumer-access"
import { registerDerivedDataPurger } from "@/lib/external-services/derived-data-registry"
import { sweepAccessTeardowns } from "@/lib/external-services/access-teardown"
import {
  resolveConnectionPrompt,
  subscribeConnectionPrompts,
  type ConnectionPrompt,
} from "./connection-prompts"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"

jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))
jest.mock("./connect", () => ({
  connectProvider: jest.fn((...args: Parameters<typeof connectProvider>) =>
    jest.requireActual("./connect").connectProvider(...args)
  ),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("@/lib/db/connection-bindings", () => ({
  ...jest.requireActual("@/lib/db/connection-bindings"),
  putConnectionBinding: jest.fn(
    jest.requireActual("@/lib/db/connection-bindings").putConnectionBinding
  ),
}))
jest.mock("./connection-manager", () => ({
  ...jest.requireActual("./connection-manager"),
  getConnectionManager: jest.fn(),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
let manager: AuthConnectionManager
let ref: AuthConnectionRef
const api = () => createAuthConnectionsAPI("consumer", () => true)
const url = "https://api.vendor.test/items"

async function addConnection(account = "Account", providerId = "vendor") {
  return manager.createConnectionFromCredentials(getProvider(providerId)!, {
    accessToken: "host-only-token",
    scopes: ["read", "write"],
    extra: { account },
  })
}

function prompt(answer: (request: ConnectionPrompt) => void) {
  return subscribeConnectionPrompts((state) => {
    if (state.current) answer(state.current)
  })
}

beforeEach(async () => {
  localStorage.clear()
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  const tokens = new Map<string, string>()
  manager = new AuthConnectionManager({
    credentials: new ConnectionCredentialStore(
      new HostAuthSecrets("auth-connections", {
        native: false,
        store: {
          load: async (key) => tokens.get(key) ?? null,
          save: async (key, value) => {
            tokens.set(key, value)
          },
          delete: async (key) => {
            tokens.delete(key)
          },
          isPersistent: () => true,
        },
      })
    ),
    providerIdentity: async (provider) => ({
      providerId: provider.id,
      ownerPluginId: provider.pluginId,
      publisher: null,
      contractMajor: 1,
    }),
  })
  jest.mocked(getConnectionManager).mockReturnValue(manager)
  jest.mocked(getPlugin).mockImplementation(
    async (id) =>
      ({
        manifest: {
          name: id === "consumer" ? "Business plugin" : id,
          ...(id === "owner"
            ? {
                providesServices: { "auth.vendor": "1.0.0" },
                authProviders: [
                  {
                    id: "vendor",
                    methods: ["client-credentials"],
                    issuers: ["https://issuer.vendor.test"],
                  },
                ],
              }
            : {}),
          ...(id === "consumer" ? { requiresServices: { "auth.vendor": "^1" } } : {}),
        },
      }) as never
  )
  registerAuthenticationProvider({
    id: "vendor",
    pluginId: "owner",
    label: "Vendor",
    getSessions: async () => [],
    createSession: async () => {
      throw new Error("unused")
    },
    removeSession: async () => {},
    authorization: { clientId: "private-client", issuer: "https://issuer.vendor.test" },
    exchange: jest.fn(async () => ({
      accessToken: "new-host-token",
      scopes: ["read", "write"],
      extra: { account: "Signed in" },
    })),
    describe: async (credentials) => ({
      issuer: "https://issuer.vendor.test",
      clientId: "private-client",
      tenantId: "private-tenant",
      tenantLabel: "Organization",
      principal: { id: credentials.extra!.account, kind: "user" },
      accountLabel: credentials.extra!.account,
      scopes: credentials.scopes,
    }),
  })
  ref = await addConnection()
  registerIntegrationDefinitions({
    pluginId: "consumer",
    definitions: [
      {
        id: "items",
        label: "Items",
        authStrategies: [{ id: "oauth", label: "OAuth", type: "oauth2", providerId: "vendor" }],
        allowedOrigins: ["https://api.vendor.test"],
        resourceKinds: [],
        eventTypes: [],
        actions: [
          {
            id: "list",
            label: "List",
            handler: "list",
            operationId: "items.list",
            risk: "read",
            idempotency: "supported",
            inputSchema: { type: "object" },
          },
        ],
      },
    ],
    handlers: { "items:list": async () => ({}) },
  })
  registerExternalServices("consumer", [
    {
      id: "items",
      label: "Items",
      fallbackPolicy: "never",
      providers: [
        {
          id: "api",
          kind: "integration",
          contributionId: "items",
          priority: 1,
          surfaces: ["chat", "workflow"],
        },
      ],
    },
  ])
  jest
    .mocked(proxyFetch)
    .mockReset()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ items: [1] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
})

afterEach(() => {
  unregisterExternalServicesByPlugin("consumer")
  unregisterExternalServicesByPlugin("other-consumer")
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
})

it("is wired through ctx.auth and lists metadata only for visible connections", async () => {
  const connections = createAuthAPI("consumer", { hasPermission: () => true }).connections
  expect(await connections.list({ service: "auth.vendor" })).toEqual([
    expect.objectContaining({ ref, providerId: "vendor" }),
  ])
  expect(Object.keys((await connections.list())[0]).sort()).toEqual(
    [
      "ref",
      "providerId",
      "accountLabel",
      "principalKind",
      "issuer",
      "tenantLabel",
      "scopes",
      "status",
      "revision",
    ].sort()
  )
  expect(await createAuthConnectionsAPI("unrelated", () => true).list()).toEqual([])
  expect(await createAuthConnectionsAPI("owner", () => true).list()).toHaveLength(1)
  expect(await connections.list({ service: "other" })).toEqual([])
})

it("binds a single match and reuses it after a second connection appears", async () => {
  expect((await api().get({ providerId: "vendor", scopes: ["read"] }))?.ref).toBe(ref)
  await addConnection("Second")
  expect((await api().get({ service: "auth.vendor" }))?.ref).toBe(ref)
  expect((await getConnectionBinding("consumer", "vendor"))?.connectionRef).toBe(ref)
})

it.each(["consumer", "owner"])(
  "signs in with zero candidates and binds for %s",
  async (pluginId) => {
    await manager.disconnect(ref)
    const dispose = prompt((request) => {
      expect(request).toMatchObject({
        kind: "sign-in",
        providerId: "vendor",
        providerLabel: "Vendor",
      })
      resolveConnectionPrompt(request.id, { kind: "sign-in" })
    })
    try {
      const result = await createAuthConnectionsAPI(pluginId, () => true).get({
        service: "auth.vendor",
        scopes: ["read"],
        interactive: true,
      })
      expect(result).toMatchObject({ status: "connected", accountLabel: "Signed in" })
      expect((await getConnectionBinding(pluginId, "vendor"))?.connectionRef).toBe(result!.ref)
      expect(JSON.stringify(result)).not.toMatch(/accessToken|new-host-token|clientId/)
    } finally {
      dispose()
    }
  }
)

it("does not sign in non-interactively, when dismissed, or for invisible providers", async () => {
  await manager.disconnect(ref)
  const prompted = jest.fn()
  const dispose = prompt((request) => {
    prompted()
    resolveConnectionPrompt(request.id, { kind: "dismissed" })
  })
  try {
    expect(await api().get({ providerId: "vendor" })).toBeUndefined()
    expect(prompted).not.toHaveBeenCalled()
    expect(
      await createAuthConnectionsAPI("unrelated", () => true).get({
        providerId: "vendor",
        interactive: true,
      })
    ).toBeUndefined()
    expect(prompted).not.toHaveBeenCalled()
    expect(await api().get({ providerId: "vendor", interactive: true })).toBeUndefined()
    expect(prompted).toHaveBeenCalledTimes(1)
    expect(getProvider("vendor")!.exchange).not.toHaveBeenCalled()
    expect(await getConnectionBinding("consumer", "vendor")).toBeUndefined()
  } finally {
    dispose()
  }
})

it("rechecks service visibility after sign-in before binding", async () => {
  await manager.disconnect(ref)
  const provider = getProvider("vendor")!
  const exchange = provider.exchange!
  provider.exchange = async (...args) => {
    const credentials = await exchange(...args)
    jest.mocked(getPlugin).mockResolvedValue({ manifest: {} } as never)
    return credentials
  }
  const dispose = prompt((request) => resolveConnectionPrompt(request.id, { kind: "sign-in" }))
  try {
    expect(await api().get({ providerId: "vendor", interactive: true })).toBeUndefined()
    expect(await getConnectionBinding("consumer", "vendor")).toBeUndefined()
  } finally {
    dispose()
  }
})

it("persists a picker choice and does not prompt non-interactively", async () => {
  const second = await addConnection("Second")
  expect(await api().get({ providerId: "vendor" })).toBeUndefined()
  const dispose = prompt((request) =>
    resolveConnectionPrompt(request.id, { kind: "selected", ref: second })
  )
  try {
    expect((await api().get({ providerId: "vendor", interactive: true }))?.ref).toBe(second)
  } finally {
    dispose()
  }
  expect((await api().get({ providerId: "vendor" }))?.ref).toBe(second)
})

it("resolves a service to all of its visible providers", async () => {
  registerAuthenticationProvider({ ...getProvider("vendor")!, id: "second-provider" })
  const second = await addConnection("Other provider account", "second-provider")
  expect(await api().list({ service: "auth.vendor" })).toHaveLength(2)
  expect(await api().get({ service: "auth.vendor" })).toBeUndefined()
  const dispose = prompt((request) => {
    if (request.kind === "picker")
      expect(request.candidates.map((row) => row.providerId).sort()).toEqual([
        "second-provider",
        "vendor",
      ])
    resolveConnectionPrompt(request.id, { kind: "selected", ref: second })
  })
  try {
    expect((await api().get({ service: "auth.vendor", interactive: true }))?.ref).toBe(second)
  } finally {
    dispose()
  }
})

it("drops gone and invisible bindings and handles no matching scopes", async () => {
  await putConnectionBinding("consumer", "vendor", "gone" as AuthConnectionRef)
  expect(await api().get({ providerId: "vendor", scopes: ["missing"] })).toBeUndefined()
  expect(await getConnectionBinding("consumer", "vendor")).toBeUndefined()
  await putConnectionBinding("unrelated", "vendor", ref)
  expect(
    await createAuthConnectionsAPI("unrelated", () => true).get({ providerId: "vendor" })
  ).toBeUndefined()
  expect(await getConnectionBinding("unrelated", "vendor")).toBeUndefined()
})

it("does not recreate a terminal binding when disconnect wins the selection race", async () => {
  jest.mocked(putConnectionBinding).mockImplementationOnce(async (...args) => {
    await manager.disconnect(ref)
    return jest.requireActual("@/lib/db/connection-bindings").putConnectionBinding(...args)
  })
  expect(await api().get({ providerId: "vendor" })).toBeUndefined()
  expect(await getConnectionBinding("consumer", "vendor")).toBeUndefined()
})

it("short-circuits provider-owner grants without prompting", async () => {
  registerIntegrationDefinitions({
    pluginId: "owner",
    definitions: [
      {
        id: "own",
        label: "Own",
        authStrategies: [{ id: "oauth", type: "oauth2", label: "OAuth", providerId: "vendor" }],
        resourceKinds: [],
        eventTypes: [],
        actions: [],
      },
    ],
    handlers: {},
  })
  await expect(
    createAuthConnectionsAPI("owner", () => true).requestGrant(ref, {
      operations: ["own.request.GET"],
    })
  ).resolves.toMatchObject({ granted: true, connectionRevision: 1 })
  expect(await listIntegrationAccounts("owner")).toEqual([])
})

it("rejects unavailable scopes, invisible/missing/disconnected refs, and unknown operations", async () => {
  await expect(
    api().requestGrant(ref, { operations: ["items.list"], scopes: ["missing"] })
  ).resolves.toEqual({ granted: false, reason: "scopes-unavailable" })
  await expect(
    api().requestGrant("gone" as AuthConnectionRef, { operations: ["items.list"] })
  ).resolves.toEqual({ granted: false, reason: "connection-unavailable" })
  await expect(
    createAuthConnectionsAPI("unrelated", () => true).requestGrant(ref, {
      operations: ["items.list"],
    })
  ).resolves.toEqual({ granted: false, reason: "connection-unavailable" })
  await expect(api().requestGrant(ref, { operations: ["items.unknown"] })).rejects.toMatchObject({
    code: "unknown-operation",
  })
  await expect(
    api().requestGrant(ref, { operations: ["items.request.BOGUS"] })
  ).rejects.toMatchObject({ code: "unknown-operation" })
  await manager.disconnect(ref)
  await expect(api().requestGrant(ref, { operations: ["items.list"] })).resolves.toEqual({
    granted: false,
    reason: "connection-unavailable",
  })
})

it("reconnects with the scope union, then approves operations at the new revision", async () => {
  jest.mocked(getProvider("vendor")!.exchange!).mockResolvedValueOnce({
    accessToken: "expanded",
    scopes: ["read", "write", "extra"],
    extra: { account: "Account" },
  })
  const kinds: string[] = []
  const dispose = prompt((request) => {
    kinds.push(request.kind)
    if (request.kind === "grant") expect(request.connection.revision).toBe(2)
    resolveConnectionPrompt(request.id, {
      kind: request.kind === "add-scopes" ? "reconnect" : "approved",
    })
  })
  try {
    await expect(
      api().requestGrant(ref, { operations: ["items.request.GET"], scopes: ["extra"] })
    ).resolves.toMatchObject({ granted: true, connectionRevision: 2 })
    expect(connectProvider).toHaveBeenCalledWith({
      providerId: "vendor",
      reconnect: ref,
      scopes: ["read", "write", "extra"],
    })
    expect(kinds).toEqual(["add-scopes", "grant"])
    const [projection] = await listServiceConnections({ pluginId: "consumer" })
    expect(await listConsumerGrants(projection.id, "consumer")).toEqual([
      expect.objectContaining({ connectionRevision: 2 }),
    ])
  } finally {
    dispose()
  }
})

it.each(["denied", "dismissed"] as const)(
  "returns scopes-unavailable on add-scope %s",
  async (kind) => {
    const before = jest.mocked(connectProvider).mock.calls.length
    const dispose = prompt((request) => {
      expect(request.kind).toBe("add-scopes")
      resolveConnectionPrompt(request.id, { kind })
    })
    try {
      await expect(
        api().requestGrant(ref, { operations: ["items.list"], scopes: ["extra"] })
      ).resolves.toEqual({ granted: false, reason: "scopes-unavailable" })
      expect(jest.mocked(connectProvider).mock.calls).toHaveLength(before)
    } finally {
      dispose()
    }
  }
)

it("does not show a grant prompt when reconnect omits requested scopes", async () => {
  jest.mocked(getProvider("vendor")!.exchange!).mockResolvedValueOnce({
    accessToken: "unchanged",
    scopes: ["read", "write"],
    extra: { account: "Account" },
  })
  const dispose = prompt((request) => {
    expect(request.kind).toBe("add-scopes")
    resolveConnectionPrompt(request.id, { kind: "reconnect" })
  })
  try {
    await expect(
      api().requestGrant(ref, { operations: ["items.list"], scopes: ["extra"] })
    ).resolves.toEqual({ granted: false, reason: "scopes-unavailable" })
  } finally {
    dispose()
  }
})

it("revoking a consumer fences later requests and preserves another consumer's grant", async () => {
  const dispose = prompt((request) => resolveConnectionPrompt(request.id, { kind: "approved" }))
  try {
    await api().requestGrant(ref, { operations: ["items.request.GET"] })
  } finally {
    dispose()
  }
  const [projection] = await listServiceConnections({ pluginId: "consumer" })
  const [grant] = await listConsumerGrants(projection.id, "consumer")
  await getDb().capabilityGrants.put({ ...grant, id: "other", consumerPluginId: "other-consumer" })
  registerExternalServices(
    "other-consumer",
    listExternalServices("consumer").map((entry) => entry.definition)
  )
  registerIntegrationDefinitions({
    pluginId: "other-consumer",
    definitions: [getRegisteredIntegration("consumer", "items")!.definition],
    handlers: { "items:list": async () => ({}) },
  })
  const secondAccount = await createIntegrationAccount("other-consumer", {
    integrationId: "items",
    providerId: "vendor",
    connectionId: ref,
    authSessionId: ref,
    remoteAccountId: "Account",
    label: "Account",
  })
  const [secondProjection] = await listServiceConnections({ pluginId: "other-consumer" })
  await getDb().capabilityGrants.put({
    ...grant,
    id: "second-consumer-grant",
    consumerPluginId: "other-consumer",
    connectionId: secondProjection.id,
    accountId: secondAccount.id,
    providerFingerprint: secondProjection.providerFingerprint,
  })
  const [account] = await listIntegrationAccounts("consumer")
  await expect(authenticatedIntegrationRequest("consumer", account.id, url)).resolves.toMatchObject(
    { status: 200 }
  )
  await revokeConsumerAccess(ref, "consumer")
  expect(await listConsumerGrants(projection.id, "consumer")).toEqual([])
  expect(await listConsumerGrants(projection.id, "other-consumer")).toHaveLength(1)
  await expect(authenticatedIntegrationRequest("consumer", account.id, url)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  await expect(
    authenticatedIntegrationRequest("other-consumer", secondAccount.id, url)
  ).resolves.toMatchObject({ status: 200, data: { items: [1] } })
})

it("blocks regrant during cleanup and restores the account only after fresh consent", async () => {
  const approve = prompt((request) => resolveConnectionPrompt(request.id, { kind: "approved" }))
  const purge = jest.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined)
  const dispose = registerDerivedDataPurger({ id: "regrant-retry", purge })
  try {
    await api().requestGrant(ref, { operations: ["items.request.GET"] })
    const [account] = await listIntegrationAccounts("consumer")
    await revokeConsumerAccess(ref, "consumer")
    expect(await api().requestGrant(ref, { operations: ["items.request.GET"] })).toEqual({
      granted: false,
      reason: "connection-unavailable",
    })
    expect(await api().get({ providerId: "vendor" })).toBeUndefined()
    await sweepAccessTeardowns()
    expect(await api().requestGrant(ref, { operations: ["items.request.GET"] })).toEqual({
      granted: true,
      ref,
      connectionRevision: 1,
      operations: ["items.request.GET"],
      scopes: [],
    })
    await expect(
      authenticatedIntegrationRequest("consumer", account.id, url)
    ).resolves.toMatchObject({ status: 200 })
    await sweepAccessTeardowns()
    await expect(
      authenticatedIntegrationRequest("consumer", account.id, url)
    ).resolves.toMatchObject({ status: 200 })
  } finally {
    approve()
    dispose()
  }
})

it.each(["denied", "dismissed"] as const)(
  "returns %s without creating an account",
  async (kind) => {
    const dispose = prompt((request) => resolveConnectionPrompt(request.id, { kind }))
    try {
      await expect(api().requestGrant(ref, { operations: ["items.list"] })).resolves.toEqual({
        granted: false,
        reason: kind,
      })
    } finally {
      dispose()
    }
    expect(await listIntegrationAccounts("consumer")).toEqual([])
  }
)

it("rejects operations owned by a different plugin or provider", async () => {
  const definition = {
    id: "foreign",
    label: "Foreign",
    resourceKinds: [],
    eventTypes: [],
    actions: [],
    authStrategies: [
      { id: "oauth", type: "oauth2" as const, label: "OAuth", providerId: "vendor" },
    ],
  }
  registerIntegrationDefinitions({
    pluginId: "other-plugin",
    definitions: [definition],
    handlers: {},
  })
  registerIntegrationDefinitions({
    pluginId: "consumer",
    definitions: [
      {
        ...definition,
        id: "other-provider",
        authStrategies: [{ ...definition.authStrategies[0], providerId: "different-provider" }],
      },
    ],
    handlers: {},
  })
  const shown = jest.fn()
  const dispose = prompt((request) => {
    shown(request)
    resolveConnectionPrompt(request.id, { kind: "approved" })
  })
  try {
    for (const operation of [
      "foreign.request.GET",
      "other-provider.request.GET",
      "missing.request.GET",
    ])
      await expect(api().requestGrant(ref, { operations: [operation] })).rejects.toMatchObject({
        code: "unknown-operation",
      })
    expect(shown).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it("approval authorizes a calendar action with resource selectors through 3a and the real action runner", async () => {
  registerIntegrationDefinitions({
    pluginId: "consumer",
    definitions: [
      {
        id: "items",
        label: "Calendar",
        resourceKinds: ["calendar"],
        eventTypes: [],
        authStrategies: [{ id: "oauth", type: "oauth2", label: "OAuth", providerId: "vendor" }],
        allowedOrigins: ["https://api.vendor.test"],
        actions: [
          {
            id: "calendar",
            operationId: "calendar.events.list",
            label: "List calendar events",
            handler: "calendar",
            risk: "read",
            idempotency: "supported",
            scopeSelectors: [{ kind: "calendar", jsonPointer: "/calendarId" }],
            inputSchema: {
              type: "object",
              properties: { calendarId: { type: "string" } },
              required: ["calendarId"],
            },
          },
        ],
      },
    ],
    handlers: { "items:calendar": async (_input, context) => context.authenticatedRequest(url) },
  })
  const account = await createIntegrationsAPI("consumer", () => true).createAccount({
    integrationId: "items",
    providerId: "vendor",
    connectionId: ref,
    authSessionId: "ignored",
    remoteAccountId: "ignored",
    label: "Ignored",
  })
  const input = {
    integrationId: "items",
    accountId: account.id,
    actionId: "calendar",
    input: { calendarId: "calendar-1" },
  }
  await expect(executeIntegrationAction("consumer", input)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  expect(proxyFetch).not.toHaveBeenCalled()
  const dispose = prompt((request) => resolveConnectionPrompt(request.id, { kind: "approved" }))
  try {
    await expect(
      api().requestGrant(ref, { operations: ["calendar.events.list"], scopes: ["read"] })
    ).resolves.toMatchObject({ granted: true, connectionRevision: 1 })
    const job = await executeIntegrationAction("consumer", input)
    await expect(runIntegrationActionJob(job.id)).resolves.toMatchObject({ status: "succeeded" })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
    expect(
      new Headers(jest.mocked(proxyFetch).mock.calls[0][1]?.headers).get("Authorization")
    ).toBe("Bearer host-only-token")
    await getDb().authConnections.update(ref, { revision: 2 })
    await expect(executeIntegrationAction("consumer", input)).rejects.toBeInstanceOf(
      ConsumerGrantRequired
    )
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
  }
})

it("dismisses headless/CLI requests immediately", async () => {
  await expect(api().requestGrant(ref, { operations: ["items.list"] })).resolves.toEqual({
    granted: false,
    reason: "dismissed",
  })
})

it.each(["*", "items.*", "items.l*ist"])(
  "refuses wildcard operation id %s before prompting",
  async (operationId) => {
    registerIntegrationDefinitions({
      pluginId: "consumer",
      definitions: [
        {
          id: "wildcard",
          label: "Wildcard",
          resourceKinds: [],
          eventTypes: [],
          authStrategies: [{ id: "oauth", type: "oauth2", label: "OAuth", providerId: "vendor" }],
          actions: [
            {
              id: "read",
              operationId,
              label: "Read",
              handler: "read",
              risk: "read",
              idempotency: "supported",
              inputSchema: { type: "object" },
            },
          ],
        },
      ],
      handlers: { "wildcard:read": async () => ({}) },
    })
    const shown = jest.fn()
    const dispose = prompt((request) => {
      shown(request)
      resolveConnectionPrompt(request.id, { kind: "approved" })
    })
    try {
      await expect(api().requestGrant(ref, { operations: [operationId] })).rejects.toMatchObject({
        code: "unknown-operation",
      })
      expect(shown).not.toHaveBeenCalled()
      expect(await listIntegrationAccounts("consumer")).toEqual([])
    } finally {
      dispose()
    }
  }
)

it("deduplicates concurrent grant approvals and createAccount for the same connection", async () => {
  const dispose = prompt((request) => resolveConnectionPrompt(request.id, { kind: "approved" }))
  try {
    const decisions = await Promise.all([
      api().requestGrant(ref, { operations: ["items.list"] }),
      api().requestGrant(ref, { operations: ["items.request.GET"] }),
      createIntegrationsAPI("consumer", () => true).createAccount({
        integrationId: "items",
        providerId: "vendor",
        connectionId: ref,
        authSessionId: "forged",
        remoteAccountId: "forged",
        label: "Forged",
      }),
    ])
    expect(decisions.slice(0, 2)).toEqual([
      expect.objectContaining({ granted: true }),
      expect.objectContaining({ granted: true }),
    ])
    const accounts = await listIntegrationAccounts("consumer")
    expect(accounts).toHaveLength(1)
    expect(decisions[2]).toMatchObject({ id: accounts[0].id, remoteAccountId: "Account" })
    expect(await listServiceConnections({ pluginId: "consumer" })).toHaveLength(1)
  } finally {
    dispose()
  }
})

it.each([false, true])(
  "drops every consumer binding when disconnected (revoke=%s)",
  async (revoke) => {
    if (revoke) getProvider("vendor")!.revoke = async () => {}
    await putConnectionBinding("consumer", "vendor", ref)
    await putConnectionBinding("other-consumer", "vendor", ref)
    await manager.disconnect(ref, { revoke })
    expect(await getConnectionBinding("consumer", "vendor")).toBeUndefined()
    expect(await getConnectionBinding("other-consumer", "vendor")).toBeUndefined()
    expect(await api().get({ providerId: "vendor" })).toBeUndefined()
  }
)

it("approval creates a bound account and current-revision grant, allowing 3a injection until revision changes", async () => {
  const dispose = prompt((request) => {
    expect(request.pluginName).toBe("Business plugin")
    expect(request.kind).toBe("grant")
    resolveConnectionPrompt(request.id, { kind: "approved" })
  })
  try {
    await expect(
      api().requestGrant(ref, { operations: ["items.request.GET", "items.list"], scopes: ["read"] })
    ).resolves.toMatchObject({ granted: true, ref, connectionRevision: 1 })
    const [account] = await listIntegrationAccounts("consumer")
    expect(account).toMatchObject({
      connectionId: ref,
      authSessionId: ref,
      remoteAccountId: "Account",
      label: "Account",
    })
    const [projection] = await listServiceConnections({ pluginId: "consumer" })
    expect(await listConsumerGrants(projection.id, "consumer")).toEqual([
      expect.objectContaining({
        connectionRevision: 1,
        consumerPluginId: "consumer",
        operationPatterns: ["items.request.GET", "items.list"],
      }),
    ])
    await expect(
      authenticatedIntegrationRequest("consumer", account.id, url)
    ).resolves.toMatchObject({ status: 200, data: { items: [1] } })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
    expect(
      new Headers(jest.mocked(proxyFetch).mock.calls[0][1]?.headers).get("Authorization")
    ).toBe("Bearer host-only-token")
    await api().requestGrant(ref, { operations: ["items.request.GET"] })
    expect(await listIntegrationAccounts("consumer")).toHaveLength(1)
    const row = (await getAuthConnection(ref))!
    await getDb().authConnections.put({ ...row, revision: row.revision + 1 })
    await expect(
      authenticatedIntegrationRequest("consumer", account.id, url)
    ).rejects.toBeInstanceOf(ConsumerGrantRequired)
    expect(proxyFetch).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
  }
})

it("rejects permission revocation and revision changes while a grant prompt is open", async () => {
  let allowed = true
  const dispose = prompt((request) => {
    allowed = false
    resolveConnectionPrompt(request.id, { kind: "approved" })
  })
  try {
    await expect(
      createAuthConnectionsAPI("consumer", () => allowed).requestGrant(ref, {
        operations: ["items.list"],
      })
    ).rejects.toThrow("auth:consume")
  } finally {
    dispose()
  }
  const close = prompt((request) => {
    void getDb()
      .authConnections.update(ref, { revision: 2 })
      .then(() => resolveConnectionPrompt(request.id, { kind: "approved" }))
  })
  try {
    await expect(api().requestGrant(ref, { operations: ["items.list"] })).resolves.toEqual({
      granted: false,
      reason: "connection-unavailable",
    })
  } finally {
    close()
  }
  expect(await listIntegrationAccounts("consumer")).toEqual([])
})

it("filters and sanitizes change events, and its disposer stops later notifications", async () => {
  const listener = jest.fn()
  const dispose = api().onDidChange(listener, { providerId: "vendor" })
  const unrelated = jest.fn()
  const stop = createAuthConnectionsAPI("unrelated", () => true).onDidChange(unrelated)
  const otherProvider = jest.fn()
  const stopOther = api().onDidChange(otherProvider, { providerId: "different" })
  await addConnection("Second")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(listener).toHaveBeenCalledWith({
    added: [expect.objectContaining({ accountLabel: "Second" })],
    removed: [],
    changed: [],
  })
  expect(JSON.stringify(listener.mock.calls)).not.toMatch(
    /host-only-token|private-client|principalId/
  )
  expect(unrelated).not.toHaveBeenCalled()
  expect(otherProvider).not.toHaveBeenCalled()
  dispose()
  stop()
  stopOther()
  await addConnection("Third")
  expect(listener).toHaveBeenCalledTimes(1)
})

it("checks auth:consume on every entry point and after async manifest reads", async () => {
  const denied = createAuthConnectionsAPI("consumer", () => false)
  await expect(denied.get({ providerId: "vendor" })).rejects.toThrow("auth:consume")
  await expect(denied.list()).rejects.toThrow("auth:consume")
  await expect(denied.requestGrant(ref, { operations: ["items.list"] })).rejects.toThrow(
    "auth:consume"
  )
  expect(() => denied.onDidChange(() => {})).toThrow("auth:consume")
  let allowed = true
  jest.mocked(getPlugin).mockImplementationOnce(async () => {
    allowed = false
    return undefined
  })
  await expect(createAuthConnectionsAPI("consumer", () => allowed).list()).rejects.toThrow(
    "auth:consume"
  )
})

it("classifies an existing connection's first update as changed", async () => {
  const listener = jest.fn()
  const dispose = api().onDidChange(listener)
  try {
    await manager.markProviderUnavailable("vendor")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listener).toHaveBeenCalledWith({
      added: [],
      removed: [],
      changed: [expect.objectContaining({ ref, status: "provider-unavailable" })],
    })
  } finally {
    dispose()
  }
})

it("delivers changed and removed metadata in order", async () => {
  const listener = jest.fn()
  const dispose = api().onDidChange(listener)
  try {
    const second = await addConnection("Second")
    await manager.markProviderUnavailable("vendor")
    await manager.restoreProvider("vendor")
    await manager.disconnect(second)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const changes = listener.mock.calls
      .flatMap(([event]) => [
        ...event.added.map((row: { ref: string; status: string }) => ({ kind: "added", ...row })),
        ...event.changed.map((row: { ref: string; status: string }) => ({
          kind: "changed",
          ...row,
        })),
        ...event.removed.map((row: { ref: string; status: string }) => ({
          kind: "removed",
          ...row,
        })),
      ])
      .filter((row) => row.ref === second)
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "added", status: "connected" }),
        expect.objectContaining({ kind: "changed", status: "provider-unavailable" }),
        expect.objectContaining({ kind: "changed", status: "connected" }),
        expect.objectContaining({ kind: "removed", status: "tombstoned" }),
      ])
    )
    expect(changes.slice(0, 3).map((row) => row.status)).toEqual([
      "connected",
      "provider-unavailable",
      "connected",
    ])
  } finally {
    dispose()
  }
})

it.each(["revoke", "dispose"] as const)(
  "suppresses pending events on %s during a manifest read",
  async (action) => {
    let allowed = true
    let finish!: (value: Awaited<ReturnType<typeof getPlugin>>) => void
    let started!: () => void
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    const listener = jest.fn()
    const dispose = createAuthConnectionsAPI("consumer", () => allowed).onDidChange(listener)
    jest.mocked(getPlugin).mockImplementationOnce(() => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    try {
      await addConnection("Second")
      await reading
      if (action === "revoke") allowed = false
      else dispose()
      finish({ manifest: { providesServices: { "auth.vendor": "1.0.0" } } } as never)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(listener).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  }
)
