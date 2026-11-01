/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  pluginExecutionContext,
  withPluginExecutionContext,
} from "@/lib/plugin/core/invocation-identity"
import {
  invokePluginTool,
  __setInvokePluginToolDepsForTesting,
} from "@/lib/plugin/core/invoke-plugin-tool"
import {
  registerIntegrationsForPlugin,
  unregisterIntegrationsForPlugin,
} from "@/lib/plugin/bridge/integrations-bridge"
import type { PluginManifest, PluginTool } from "@/types/plugin"
import {
  LOCAL_PERSON_RUN,
  startToolExecutionRun,
  finishToolExecutionRun,
} from "@/lib/execution/acting-authority"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  bindIntegrationAccountConnection,
  createIntegrationAccount,
  enqueueIntegrationActionJob,
} from "@/lib/db/integrations"
import {
  invalidateCapabilityGrants,
  listServiceConnections,
  putCapabilityGrant,
  putServiceConnection,
} from "@/lib/db/external-services"
import {
  registerExternalServices,
  unregisterExternalServicesByPlugin,
} from "@/lib/external-services/catalog"
import {
  __resetIntegrationRegistryForTesting,
  registerIntegrationDefinitions,
  listRegisteredIntegrations,
} from "./registry"
import {
  AuthConnectionManager,
  ConnectionUnavailableError,
  ConnectionRevisionChanged,
  getConnectionManager,
} from "@/lib/plugin/auth/connection-manager"
import {
  ConnectionCredentialStore,
  HostAuthSecrets,
} from "@/lib/plugin/auth/connection-credentials"
import {
  getProvider,
  registerAuthenticationProvider,
  unregisterAuthenticationProvider,
  __resetAuthRegistryForTesting,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { CapabilityGrant } from "@/types/external-service"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { createIntegrationsAPI } from "@/lib/plugin/api/integrations-api"
import * as botBinding from "@/lib/plugin/api/bot-integration-binding"
import {
  ConsumerGrantRequired,
  authenticatedIntegrationRequest,
  executeIntegrationAction,
  runIntegrationActionJob,
} from "./action-runner"

jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("@/lib/plugin/api/bot-integration-binding", () => ({
  ...jest.requireActual("@/lib/plugin/api/bot-integration-binding"),
  resolveBotIntegrationBinding: jest.fn(),
}))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  ...jest.requireActual("@/lib/plugin/auth/connection-manager"),
  getConnectionManager: jest.fn(),
}))
jest.mock("@/lib/policy/action-review/plan-integration", () => ({
  ...jest.requireActual("@/lib/policy/action-review/plan-integration"),
  planIntegrationWrite: jest.fn(async () => ({ action: "proceed" })),
}))

const consumer = "business"
const url = "https://api.example.test/items"
const rows = new Map<string, AuthConnectionRow>()
let manager: AuthConnectionManager
let ref: AuthConnectionRef
let accountId: string

async function setup(owner = "provider-owner", header = false) {
  const tokens = new Map<string, string>()
  const credentials = new ConnectionCredentialStore(
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
  )
  manager = new AuthConnectionManager({
    credentials,
    store: {
      get: async (id) => {
        const row = rows.get(id)
        return row && structuredClone(row)
      },
      find: async (key) => [...rows.values()].find((row) => row.identityKey === key),
      list: async () => [...rows.values()],
      put: async (row) => {
        rows.set(row.id, structuredClone(row))
      },
    },
    provider: getProvider,
    providerIdentity: async (provider) => ({
      providerId: provider.id,
      ownerPluginId: provider.pluginId,
      publisher: null,
      contractMajor: 1,
    }),
  })
  jest.mocked(getConnectionManager).mockReturnValue(manager)
  const provider = {
    id: "vendor",
    pluginId: owner,
    label: "Vendor",
    getSessions: jest.fn(async () => []),
    createSession: async () => {
      throw new Error("unused")
    },
    removeSession: async () => {},
    describe: async () => ({
      issuer: "https://api.example.test",
      clientId: "client",
      principal: { id: "service", kind: "service" as const },
      accountLabel: "User",
      scopes: ["read"],
    }),
  }
  registerAuthenticationProvider(provider)
  ref = await manager.createConnectionFromCredentials(provider, {
    accessToken: "host-credential",
    scopes: ["read"],
  })
  registerExternalServices(consumer, [
    {
      id: "items",
      label: "Items",
      fallbackPolicy: "never",
      providers: [
        {
          id: "api",
          kind: "integration",
          contributionId: "vendor",
          priority: 1,
          surfaces: ["chat", "workflow"],
        },
      ],
    },
  ])
  registerIntegrationDefinitions({
    pluginId: consumer,
    definitions: [
      {
        id: "vendor",
        label: "Vendor",
        allowedOrigins: ["https://api.example.test"],
        authStrategies: [
          {
            id: "oauth",
            type: "oauth2",
            label: "OAuth",
            providerId: "vendor",
            ...(header
              ? { requestAuth: { type: "header" as const, name: "x-vendor-key", prefix: "key " } }
              : {}),
          },
        ],
        resourceKinds: [],
        eventTypes: [],
        actions: [
          {
            id: "list",
            operationId: "items.list",
            label: "List",
            handler: "list",
            risk: "read",
            idempotency: "supported",
            inputSchema: { type: "object" },
          },
        ],
      },
    ],
    handlers: { "vendor:list": async (_input, context) => context.authenticatedRequest(url) },
  })
  const account = await createIntegrationAccount(consumer, {
    integrationId: "vendor",
    providerId: "vendor",
    authSessionId: "unused-legacy-handle",
    connectionId: ref,
    remoteAccountId: "user",
    label: "User",
  })
  accountId = account.id
  return provider
}

async function grant(overrides: Partial<CapabilityGrant> = {}) {
  const [projection] = await listServiceConnections({ pluginId: consumer })
  return putCapabilityGrant({
    id: "consumer-grant",
    connectionId: projection.id,
    providerFingerprint: projection.providerFingerprint,
    consumerPluginId: consumer,
    connectionRevision: 1,
    operationPatterns: ["vendor.request.GET"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  })
}

function response() {
  return new Response(JSON.stringify({ items: ["item"] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  rows.clear()
  jest
    .mocked(proxyFetch)
    .mockReset()
    .mockImplementation(async () => response())
})
afterEach(async () => {
  jest.restoreAllMocks()
  unregisterExternalServicesByPlugin(consumer)
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  await getDb().delete()
  __resetDbForTesting()
})

it("denies a connection-backed read before resolving credentials or calling the network", async () => {
  const provider = await setup()
  const credentials = jest.spyOn(manager, "getCredentials")
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toMatchObject({
    name: "ConsumerGrantRequired",
    connectionRef: ref,
    consumerPluginId: consumer,
    operation: "vendor.request.GET",
    revision: 1,
  })
  expect(credentials).not.toHaveBeenCalled()
  expect(provider.getSessions).not.toHaveBeenCalled()
  expect(proxyFetch).not.toHaveBeenCalled()
})

it.each([
  { consumerPluginId: "other", connectionRevision: 2 },
  { connectionRevision: 1 },
  { connectionRevision: 3 },
  { connectionRevision: undefined },
  { consumerPluginId: undefined, connectionRevision: 2 },
])("denies a mismatched consumer grant %j", async (override) => {
  await setup()
  rows.set(ref, { ...rows.get(ref)!, revision: 2 })
  await grant(override)
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  expect(proxyFetch).not.toHaveBeenCalled()
})

it.each([false, true])(
  "injects matching connection credentials (custom header: %s)",
  async (header) => {
    await setup("provider-owner", header)
    await grant()
    expect(await authenticatedIntegrationRequest(consumer, accountId, url)).toMatchObject({
      data: { items: ["item"] },
    })
    const headers = new Headers(jest.mocked(proxyFetch).mock.calls[0][1]?.headers)
    expect(headers.get(header ? "x-vendor-key" : "authorization")).toBe(
      header ? "key host-credential" : "Bearer host-credential"
    )
  }
)

it("allows the providing plugin without a consumer grant", async () => {
  await setup(consumer)
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).resolves.toMatchObject({
    status: 200,
  })
  expect(proxyFetch).toHaveBeenCalledTimes(1)
})

it.each(["needs-reauth", "tombstoned", "revoked", "provider-unavailable"] as const)(
  "refuses unavailable connection %s and updates account health",
  async (status) => {
    await setup()
    rows.set(ref, { ...rows.get(ref)!, status })
    await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toMatchObject({
      name: "ConnectionUnavailableError",
      reason: status,
    })
    expect((await getDb().integrationAccounts.get(accountId))?.health).toBe("revoked")
    expect(proxyFetch).not.toHaveBeenCalled()
  }
)

it("drops a response when the revision changes during the network request", async () => {
  await setup()
  await grant()
  jest.mocked(proxyFetch).mockImplementationOnce(async () => {
    rows.set(ref, { ...rows.get(ref)!, revision: 2 })
    return response()
  })
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConnectionRevisionChanged
  )
})

it("drops a read revoked during fetch before consuming its body", async () => {
  await setup()
  await grant()
  const result = response()
  const parse = jest.spyOn(result, "json")
  jest.mocked(proxyFetch).mockImplementationOnce(async () => {
    const [projection] = await listServiceConnections({ pluginId: consumer })
    await invalidateCapabilityGrants(projection.id)
    return result
  })
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toMatchObject({
    name: "ConsumerGrantRequired",
    consumerPluginId: consumer,
    operation: "vendor.request.GET",
  })
  expect(parse).not.toHaveBeenCalled()
  expect(rows.get(ref)?.revision).toBe(1)
})

it.each(["application/json", "text/plain"])(
  "drops a read revoked during %s body parsing",
  async (contentType) => {
    await setup()
    await grant()
    const result = new Response("private response", { headers: { "content-type": contentType } })
    const parse = async () => {
      const [projection] = await listServiceConnections({ pluginId: consumer })
      await invalidateCapabilityGrants(projection.id)
      return "private response"
    }
    const consume = jest
      .spyOn(result, contentType === "application/json" ? "json" : "text")
      .mockImplementation(parse)
    jest.mocked(proxyFetch).mockResolvedValueOnce(result)
    await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toMatchObject({
      name: "ConsumerGrantRequired",
      consumerPluginId: consumer,
      operation: "vendor.request.GET",
    })
    expect(consume).toHaveBeenCalledTimes(1)
    expect(rows.get(ref)?.revision).toBe(1)
  }
)

it("drops a response when disconnect wins during body consumption", async () => {
  await setup()
  await grant()
  jest.mocked(proxyFetch).mockImplementationOnce(async () => {
    const result = response()
    result.json = async () => {
      await manager.disconnect(ref)
      return { items: ["stale"] }
    }
    return result
  })
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConnectionRevisionChanged
  )
})

it("checks the revision again after credential resolution, before dispatch", async () => {
  await setup()
  await grant()
  const original = manager.getCredentials.bind(manager)
  jest.spyOn(manager, "getCredentials").mockImplementationOnce(async (...args) => {
    const credentials = await original(...args)
    rows.set(ref, { ...rows.get(ref)!, revision: 2 })
    return credentials
  })
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConnectionRevisionChanged
  )
  expect(proxyFetch).not.toHaveBeenCalled()
})

it.each(["getConnection", "getCredentials"] as const)(
  "keeps provider teardown during %s typed and stops dispatch",
  async (stage) => {
    await setup()
    await grant()
    if (stage === "getConnection") {
      const original = manager.getConnection.bind(manager)
      jest.spyOn(manager, "getConnection").mockImplementationOnce(async (...args) => {
        const row = await original(...args)
        unregisterAuthenticationProvider("vendor")
        return row
      })
    } else {
      const original = manager.getCredentials.bind(manager)
      jest.spyOn(manager, "getCredentials").mockImplementationOnce(async (...args) => {
        const credentials = await original(...args)
        unregisterAuthenticationProvider("vendor")
        return credentials
      })
    }
    await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toMatchObject({
      name: "ConnectionUnavailableError",
      reason: "provider-unavailable",
    })
    expect((await getDb().integrationAccounts.get(accountId))?.health).toBe("revoked")
    expect(proxyFetch).not.toHaveBeenCalled()
  }
)

it("enforces the raw ctx.integrations API at the same injection boundary", async () => {
  await setup()
  const api = createIntegrationsAPI(consumer, () => true)
  await expect(api.authenticatedRequest(accountId, url)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  await grant()
  await expect(api.authenticatedRequest(accountId, url)).resolves.toMatchObject({ status: 200 })
})

it("checks actions and job handlers by action operation, rather than the handler's HTTP method", async () => {
  await setup()
  const input = { integrationId: "vendor", accountId, actionId: "list", input: {} }
  await expect(executeIntegrationAction(consumer, input)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  await grant() // A raw GET grant does not cover items.list.
  await expect(executeIntegrationAction(consumer, input)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  await grant({ operationPatterns: ["items.list"] })
  const job = await executeIntegrationAction(consumer, input)
  await expect(runIntegrationActionJob(job.id)).resolves.toMatchObject({ status: "succeeded" })
  expect(proxyFetch).toHaveBeenCalledTimes(1)
})

it("rechecks queued job grants and fails without retrying or sending", async () => {
  await setup()
  const job = await enqueueIntegrationActionJob({
    pluginId: consumer,
    integrationId: "vendor",
    accountId,
    actionId: "list",
    input: {},
    status: "queued",
    risk: "read",
    attempts: 0,
    maxAttempts: 5,
    source: "manual",
  })
  await expect(runIntegrationActionJob(job.id)).resolves.toMatchObject({
    status: "failed",
    error: expect.stringContaining("consumer grant"),
  })
  expect(proxyFetch).not.toHaveBeenCalled()
})

it("rejects missing connection references", async () => {
  await setup()
  await bindIntegrationAccountConnection(consumer, accountId, "missing")
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConnectionUnavailableError
  )
})

it.each(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])(
  "uses an explicit method operation for raw %s requests",
  async (method) => {
    await setup()
    await expect(
      authenticatedIntegrationRequest(consumer, accountId, url, { method: method.toLowerCase() })
    ).rejects.toMatchObject({ operation: `vendor.request.${method}` })
    await grant({ operationPatterns: [`vendor.request.${method}`] })
    await expect(
      authenticatedIntegrationRequest(consumer, accountId, url, { method: method.toLowerCase() })
    ).resolves.toMatchObject({ status: 200 })
  }
)

it("does not accept a forged Host operation on a raw request", async () => {
  await setup()
  await grant({ operationPatterns: ["items.list"] })
  await expect(
    authenticatedIntegrationRequest(consumer, accountId, url, {
      operation: { actionId: "list", input: {} },
    } as never)
  ).rejects.toMatchObject({ operation: "vendor.request.GET" })
  expect(proxyFetch).not.toHaveBeenCalled()
})

it("changes the projection fingerprint on rebinding, so an old grant cannot authorize a new connection", async () => {
  await setup()
  await grant()
  const nextRef = "another-connection" as AuthConnectionRef
  rows.set(nextRef, { ...rows.get(ref)!, id: nextRef })
  await bindIntegrationAccountConnection(consumer, accountId, nextRef)
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  expect(proxyFetch).not.toHaveBeenCalled()
})

it("denies a stale projection racing a connection rebind even when its fingerprint still matches the old grant", async () => {
  await setup()
  await grant()
  const [stale] = await listServiceConnections({ pluginId: consumer })
  const nextRef = "another-connection" as AuthConnectionRef
  rows.set(nextRef, { ...rows.get(ref)!, id: nextRef })
  await bindIntegrationAccountConnection(consumer, accountId, nextRef)
  await putServiceConnection(stale)
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConsumerGrantRequired
  )
  expect(proxyFetch).not.toHaveBeenCalled()
})

it.each(["another-consumer", "old-revision", "needs-reauth", "tombstoned"])(
  "enforces %s on both executeAction and a prequeued job",
  async (reason) => {
    await setup()
    if (reason === "another-consumer")
      await grant({ operationPatterns: ["items.list"], consumerPluginId: "other" })
    if (reason === "old-revision") {
      await grant({ operationPatterns: ["items.list"] })
      rows.set(ref, { ...rows.get(ref)!, revision: 2 })
    }
    if (reason === "needs-reauth" || reason === "tombstoned")
      rows.set(ref, { ...rows.get(ref)!, status: reason })
    const input = { integrationId: "vendor", accountId, actionId: "list", input: {} }
    await expect(executeIntegrationAction(consumer, input)).rejects.toBeInstanceOf(
      reason === "needs-reauth" || reason === "tombstoned"
        ? ConnectionUnavailableError
        : ConsumerGrantRequired
    )
    const job = await enqueueIntegrationActionJob({
      ...input,
      pluginId: consumer,
      status: "queued",
      risk: "read",
      attempts: 0,
      maxAttempts: 5,
      source: "manual",
    })
    await expect(runIntegrationActionJob(job.id)).resolves.toMatchObject({ status: "failed" })
    expect(proxyFetch).not.toHaveBeenCalled()
  }
)

it("drops an action handler response when its connection revision moves mid-flight", async () => {
  await setup()
  await grant({ operationPatterns: ["items.list"] })
  jest.mocked(proxyFetch).mockImplementationOnce(async () => {
    rows.set(ref, { ...rows.get(ref)!, revision: 2 })
    return response()
  })
  const job = await executeIntegrationAction(consumer, {
    integrationId: "vendor",
    accountId,
    actionId: "list",
    input: {},
  })
  expect(job).toMatchObject({
    status: "failed",
    error: expect.stringContaining("revision changed"),
  })
  expect(job.output).toBeUndefined()
})

it("allows a restored connection to recover the account's previous unavailable health", async () => {
  await setup()
  await grant()
  rows.set(ref, { ...rows.get(ref)!, status: "provider-unavailable" })
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).rejects.toBeInstanceOf(
    ConnectionUnavailableError
  )
  rows.set(ref, { ...rows.get(ref)!, status: "connected" })
  await expect(authenticatedIntegrationRequest(consumer, accountId, url)).resolves.toMatchObject({
    status: 200,
  })
})

it("revalidates the exact Bot connection binding before releasing a Host-held user credential", async () => {
  await setup(consumer)
  rows.get(ref)!.principalKind = "user"
  const read = jest.spyOn(manager, "getCredentials")
  const boundRead = jest.spyOn(manager, "getCredentialsForBotBinding")
  const resolve = jest
    .mocked(botBinding.resolveBotIntegrationBinding)
    .mockResolvedValue({ account: { connectionId: ref } } as never)
  const binding = { runId: "bot-run", slotId: "installed-slot" }
  const verified = {
    pluginId: consumer,
    accountId,
    binding: { pluginId: "bot", ref: binding },
  }
  await expect(
    authenticatedIntegrationRequest(consumer, accountId, url, undefined, undefined, verified)
  ).resolves.toMatchObject({ status: 200 })
  expect(boundRead).toHaveBeenCalledWith(ref, "bot", binding)
  expect(read).not.toHaveBeenCalled()
  resolve.mockResolvedValue({ account: { connectionId: "different-connection" } } as never)
  await expect(
    authenticatedIntegrationRequest(consumer, accountId, url, undefined, undefined, verified)
  ).rejects.toThrow("bot-binding-changed")
  expect(proxyFetch).toHaveBeenCalledTimes(1)
})

it("gates a user-scoped connection before getCredentials, independent of consumer ownership", async () => {
  await setup(consumer)
  rows.get(ref)!.principalKind = "user"
  const read = jest.spyOn(manager, "getCredentials")
  const run = await startToolExecutionRun("im", { runId: "not-owner" })
  await getDb().executionRuns.update(run.id, {
    actingIdentity: {
      schemaVersion: 1,
      rootRunId: run.id,
      lane: "legacy",
      trigger: "requester",
      authorityRevision: 0,
      requesters: [
        { kind: "platform", platform: "lark", adapterId: "connected", remoteUserId: "not-owner" },
      ],
    },
  })
  await expect(
    authenticatedIntegrationRequest(consumer, accountId, url, undefined, {
      sessionId: "im",
      executionRunId: run.id,
    })
  ).rejects.toThrow("Personal credential integration-user refused")
  expect(read).not.toHaveBeenCalled()
  await expect(
    authenticatedIntegrationRequest(consumer, accountId, url, undefined, {
      localAuthorization: LOCAL_PERSON_RUN,
    })
  ).resolves.toMatchObject({ status: 200 })
  expect(read).toHaveBeenCalledTimes(1)
})

it("a connectionRef consumer grant admits outside a run but omitted or forged plugin fields cannot escape the Host-bound run", async () => {
  await setup()
  rows.get(ref)!.principalKind = "user"
  await grant()
  const api = createIntegrationsAPI(consumer, () => true)
  await expect(
    api.authenticatedRequest(accountId, url, { connectionRef: ref })
  ).resolves.toMatchObject({ status: 200 })
  jest.mocked(proxyFetch).mockClear()
  const run = await startToolExecutionRun(undefined, { runId: "consumer-refused" })
  await withPluginExecutionContext(consumer, { executionRunId: run.id }, async () => {
    for (const init of [
      { connectionRef: ref },
      {
        connectionRef: ref,
        executionRunId: undefined,
        credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      },
    ]) {
      await expect(api.authenticatedRequest(accountId, url, init)).rejects.toMatchObject({
        name: "PersonalCredentialRefusedError",
      })
    }
  })
  expect(proxyFetch).not.toHaveBeenCalled()
})

it.each([true, false])(
  "keeps the verified parent tool to child job identity through the real promoted integration bridge (local-person: %s)",
  async (localPerson) => {
    await setup()
    rows.get(ref)!.principalKind = "user"
    const definition = listRegisteredIntegrations(consumer)[0]
    const tools: PluginTool[] = []
    let handlerContext: ReturnType<typeof pluginExecutionContext>
    await registerIntegrationsForPlugin(
      consumer,
      {
        id: consumer,
        name: "Business",
        version: "1.0.0",
        type: "frontend",
        capabilities: ["integrations"],
        integrations: [definition],
      } as PluginManifest,
      {
        list: async (
          _input: unknown,
          context: Parameters<
            import("@/types/plugin/plugin-integration").IntegrationActionHandler
          >[1]
        ) => {
          handlerContext = pluginExecutionContext(consumer)
          return context.authenticatedRequest(url, { connectionRef: ref })
        },
      },
      (tool) => {
        tools.push(tool)
        return () => {}
      }
    )
    await grant({ operationPatterns: ["items.list"] })
    const parent = await startToolExecutionRun(undefined, {
      runId: "promoted-local-parent",
      ...(localPerson
        ? { localAuthorization: LOCAL_PERSON_RUN }
        : { automation: "service" as const }),
    })
    const tool = tools[0]
    __setInvokePluginToolDepsForTesting({
      getManager: () => ({
        getPlugin: () => ({ status: "enabled", manifest: {} }),
        getRegistry: () => ({ getTool: () => tool }),
        handleActivationEvent: async () => {},
      }),
      getGuard: () => ({ getTier: () => "silent", checkWithConsent: async () => true }),
      getBroker: () => ({ request: async () => true }),
      resolveSandboxRuntimeRef: () => undefined,
    } as never)
    try {
      const reply = await invokePluginTool(
        consumer,
        tool.name,
        { accountId },
        { executionRunId: parent.id }
      )
      expect(handlerContext?.executionRunId).toMatch(/^execution:job:integration:/)
      expect(reply.result).toMatchObject({ status: localPerson ? "succeeded" : "failed" })
      const jobRun = await getDb().executionRuns.get(handlerContext!.executionRunId!)
      expect(jobRun).toMatchObject({
        parentRunId: parent.id,
        actingIdentity: { rootRunId: parent.id },
        status: localPerson ? "completed" : "failed",
      })
      if (localPerson) {
        expect(proxyFetch).toHaveBeenCalledTimes(1)
        expect(
          new Headers(jest.mocked(proxyFetch).mock.calls[0][1]?.headers).get("authorization")
        ).toBe("Bearer host-credential")
      } else {
        expect(proxyFetch).not.toHaveBeenCalled()
      }
      expect(pluginExecutionContext(consumer)).toBeUndefined()
    } finally {
      __setInvokePluginToolDepsForTesting(null)
      await unregisterIntegrationsForPlugin(consumer)
    }
  }
)

it.each(["api", "host", "outside"] as const)(
  "pins raw authenticated requests before the first account await (%s)",
  async (entry) => {
    await setup()
    rows.get(ref)!.principalKind = "user"
    await grant()
    const table = getDb().integrationAccounts
    const row = await table.get(accountId)
    let unblock!: (value: typeof row) => void
    const gate = new Promise<typeof row>((resolve) => {
      unblock = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    jest.spyOn(table, "get").mockImplementationOnce(() => {
      entered()
      return gate as never
    })
    const origin = await startToolExecutionRun(undefined, {
      runId: "deferred-request-origin",
      automation: "service",
    })
    const later = await startToolExecutionRun(undefined, {
      runId: "deferred-request-local",
      localAuthorization: LOCAL_PERSON_RUN,
    })
    const api = createIntegrationsAPI(consumer, () => true)
    let pending!: Promise<unknown>
    const begin = async () => {
      pending =
        entry === "host"
          ? authenticatedIntegrationRequest(consumer, accountId, url, { connectionRef: ref })
          : api.authenticatedRequest(accountId, url, { connectionRef: ref })
      await started
    }
    try {
      if (entry === "outside") await begin()
      else await withPluginExecutionContext(consumer, { executionRunId: origin.id }, begin)
      await finishToolExecutionRun(origin.id)
      await withPluginExecutionContext(consumer, { executionRunId: later.id }, async () => {
        unblock(row)
        await expect(pending).rejects.toMatchObject({ name: "PersonalCredentialRefusedError" })
      })
      expect(proxyFetch).not.toHaveBeenCalled()
    } finally {
      unblock(row)
      await pending?.catch(() => undefined)
    }
  }
)
