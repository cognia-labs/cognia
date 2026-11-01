/** @jest-environment jsdom */

import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import {
  pluginExecutionContext,
  withPluginExecutionContext,
} from "@/lib/plugin/core/invocation-identity"
import { __setInvokePluginToolDepsForTesting, invokePluginTool } from "../core/invoke-plugin-tool"
import { registerInterceptor, __resetInterceptorRegistryForTesting } from "../interceptors"
import { createIssuesAPI, clearIssueSyncProvidersForPlugin } from "./issues-api"
import { getIssueSyncRegistry } from "@/lib/issues/sync/registry"
import { runWorkspaceIssueSync } from "@/lib/issues/sync/runner"
import { authenticatedIntegrationRequest } from "@/lib/integrations/action-runner"
import {
  createAuthAPI,
  getHostAuthSession,
  getHostPkceTokenRequestExemptKeys,
  type PluginAuthProvider,
  type LegacyPluginAuthProvider,
} from "./auth-api"
import { sanitizePluginNetworkEgress } from "./plugin-pii-gate"
import { loggers } from "@cognia/logging"
import { ConsumerTokenReadDenied } from "@/lib/plugin/auth/consumer-token-read-policy"
import { getPlugin } from "@/lib/db/plugins"
import { getAuthConnection } from "@/lib/db/auth-connections"
import { getDb } from "@/lib/db/schema"
import { connectProvider } from "@/lib/plugin/auth/connect"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
import { registerLegacySessionMigration } from "@/lib/plugin/auth/legacy-session-migrations"
import {
  ConnectionCredentialStore,
  setHostAuthBackend,
} from "@/lib/plugin/auth/connection-credentials"
import { withNamedLock } from "@/lib/locks/named-lock"
import { acceptCallback } from "@/lib/plugin/auth/callback-acceptor"
import { openExternal } from "@/lib/tauri/opener"
import { detectPlatform } from "@/lib/platform/detect"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(() => "tauri"),
}))
beforeEach(() => jest.mocked(detectPlatform).mockReturnValue("tauri"))
import { createIntegrationAccount } from "@/lib/db/integrations"
import { listServiceConnections, putCapabilityGrant } from "@/lib/db/external-services"
import {
  registerExternalServices,
  unregisterExternalServicesByPlugin,
} from "@/lib/external-services/catalog"
import {
  registerIntegrationDefinitions,
  __resetIntegrationRegistryForTesting,
} from "@/lib/integrations/registry"
import { createIntegrationsAPI } from "@/lib/plugin/api/integrations-api"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { createDbTestFixture } from "@/lib/db/test-fixture"
const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

jest.mock("@/lib/db/plugins", () => ({
  ...jest.requireActual("@/lib/db/plugins"),
  getPlugin: jest.fn(),
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))

jest.mock("@/lib/plugin/auth/auth-attempts", () => ({
  ...jest.requireActual("@/lib/plugin/auth/auth-attempts"),
  cancelAttempt: jest.fn(jest.requireActual("@/lib/plugin/auth/auth-attempts").cancelAttempt),
}))
import { cancelAttempt } from "@/lib/plugin/auth/auth-attempts"

import { generateCodeVerifier } from "@cognia/provider-core/providers/oauth"
import type { NetworkRequestOptions } from "@/types/plugin"

jest.mock("@cognia/provider-core/providers/oauth", () => {
  const actual = jest.requireActual("@cognia/provider-core/providers/oauth")
  return { ...actual, generateCodeVerifier: jest.fn(actual.generateCodeVerifier) }
})
import {
  __resetAuthRegistryForTesting,
  __makeSession,
  listProviders,
  type AuthSession,
  removeSession,
} from "@/lib/plugin/auth/auth-provider-registry"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import type { PluginPkceFlowConfig } from "@cognia/plugin-contract/lib/plugin/api/auth-api"

const createAdmittedAuthAPI: typeof createAuthAPI = (id, options, policy) =>
  createAuthAPI(id, options, policy, { localAuthorization: LOCAL_PERSON_RUN })

function pkceConfig(): PluginPkceFlowConfig {
  return {
    authorizeUrl: "https://auth.example.com/authorize",
    tokenUrl: "https://auth.example.com/token",
    clientId: "client",
    redirectUri: "http://localhost/callback",
    scopes: [],
    state: "state",
    openUrl: jest.fn(),
    waitForCode: async ({ state }) => ({ code: "code", state }),
  }
}

function fakeProvider(over?: Partial<LegacyPluginAuthProvider>): LegacyPluginAuthProvider {
  const session: AuthSession = __makeSession({
    accessToken: "tok",
    account: { id: "u1", label: "User" },
    scopes: ["repo"],
  })
  return {
    id: "acme",
    label: "Acme",
    getSessions: async () => [session],
    createSession: async () => session,
    removeSession: async () => {},
    ...over,
  }
}

const allow = { hasPermission: () => true }
const deny = { hasPermission: () => false }

describe("Host-managed provider session adapter", () => {
  const providerId = "host-acme"
  let provider: PluginAuthProvider
  let activeLocks: Set<string>
  beforeEach(() => {
    localStorage.clear()
    resetPermissionGuard()
    __resetAuthRegistryForTesting()
    const stores = new Map<string, Map<string, string>>()
    activeLocks = new Set()
    setHostAuthBackend({
      lock: (name, task) =>
        withNamedLock(
          name,
          async (assertHeld) => {
            activeLocks.add(name)
            try {
              return await task(assertHeld)
            } finally {
              activeLocks.delete(name)
            }
          },
          { mode: "in-process" }
        ),
      storeFor(namespace) {
        const values = stores.get(namespace) ?? new Map<string, string>()
        stores.set(namespace, values)
        return {
          load: async (key) => values.get(key) ?? null,
          save: async (key, value) => {
            values.set(key, value)
          },
          delete: async (key) => {
            values.delete(key)
          },
          isPersistent: () => true,
        }
      },
    })
    jest.mocked(getPlugin).mockResolvedValue({
      manifest: {
        author: "Acme",
        providesServices: { "auth.host-acme": "1.0.0" },
        authProviders: [
          {
            id: providerId,
            label: "Acme",
            methods: ["oauth-pkce"],
            issuers: ["https://issuer.test"],
            authorization: { clientId: "client", issuer: "https://issuer.test" },
          },
        ],
      },
    } as never)
    provider = {
      management: "host",
      id: providerId,
      label: "Acme",
      authorize: jest.fn(async (attempt) => ({
        url: `https://issuer.test/authorize?state=${attempt.attemptId}`,
      })),
      exchange: jest.fn(async () => ({
        accessToken: "host-secret",
        refreshToken: "refresh-secret",
        scopes: ["read"],
      })),
      refresh: jest.fn(async (lineage) => {
        expect(activeLocks.has(`cognia-auth-lineage:${lineage.lineageId}`)).toBe(true)
        return { accessToken: "rotated-secret", scopes: ["read"] }
      }),
      describe: jest.fn(async (credentials) => ({
        issuer: "https://issuer.test",
        clientId: "client",
        principal: { id: "user", kind: "user" as const },
        accountLabel: "Account",
        scopes: credentials.scopes,
      })),
      revoke: jest.fn(async (lineage) => {
        expect(await getAuthConnection(lineage.ref)).toMatchObject({ status: "tombstoned" })
        await expect(getConnectionManager().getCredentials(lineage.ref)).rejects.toThrow()
      }),
    }
    jest.mocked(openExternal).mockImplementation(async (raw) => {
      await acceptCallback(
        { state: new URL(raw).searchParams.get("state")!, code: "code" },
        "broadcast"
      )
    })
    createAdmittedAuthAPI("host-owner", allow).registerProvider(provider)
  })
  afterEach(() => {
    __setInvokePluginToolDepsForTesting(null)
    __resetInterceptorRegistryForTesting()
    clearIssueSyncProvidersForPlugin("host-owner")
    setHostAuthBackend(null)
    __resetAuthRegistryForTesting()
    jest.restoreAllMocks()
    __resetIntegrationRegistryForTesting()
    unregisterExternalServicesByPlugin("host-business")
  })

  it("awaits registered migration before reading aliases for any provider", async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const migrate = jest.fn(async () => {
      await gate
    })
    const aliases = jest.fn(async () => new Map())
    const dispose = registerLegacySessionMigration("host-owner", providerId, { migrate, aliases })
    const owner = createAuthAPI("host-owner", allow)
    try {
      owner.registerProvider(provider)
      const sessions = owner.getSessions(providerId)
      await Promise.resolve()
      expect(migrate).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: "host-owner", id: providerId })
      )
      expect(aliases).not.toHaveBeenCalled()
      finish()
      await expect(sessions).resolves.toEqual([])
      expect(aliases).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: "host-owner", id: providerId })
      )
    } finally {
      finish()
      dispose()
    }
  })

  it("registers without session callbacks and serves connected, scope-matching sessions", async () => {
    expect(provider.getSessions).toBeUndefined()
    const owner = createAdmittedAuthAPI("host-owner", allow)
    expect(await owner.getSessions(providerId)).toEqual([])
    const ref = await connectProvider({ providerId, scopes: ["read"] })
    expect(await owner.getSession(providerId, ["read"])).toEqual({
      id: ref,
      accessToken: "host-secret",
      account: { id: "user", label: "Account" },
      scopes: ["read"],
    })
    expect(await owner.getSessions(providerId, ["write"])).toEqual([])
    expect(provider.refresh).not.toHaveBeenCalled()
    expect(getPermissionGuard().getAuditLog({ pluginId: "host-owner", action: "check" })).toEqual(
      []
    )
    const row = (await getAuthConnection(ref))!
    // A provider upgraded from the legacy form must not recurse through the
    // manager's legacy-session bridge or surface an old provider's credentials.
    await getDb().authConnections.put({
      ...row,
      id: "legacy-ref" as typeof ref,
      identityKey: "legacy-ref",
      legacySessionId: "legacy-session",
    })
    expect(await owner.getSessions(providerId)).toHaveLength(1)
    await getDb().authConnections.put({ ...row, status: "needs-reauth" })
    expect(await owner.getSessions(providerId)).toEqual([])
  })

  it("creates owner sessions through connectProvider but never substitutes the consumer transition policy for a grant", async () => {
    const owner = createAdmittedAuthAPI("host-owner", allow)
    const session = await owner.getSession(providerId, ["read"], { createIfNone: true })
    expect(session?.accessToken).toBe("host-secret")
    expect(provider.exchange).toHaveBeenCalledTimes(1)
    const consumer = createAdmittedAuthAPI("host-transition-consumer", allow)
    const warn = jest.spyOn(loggers.plugin, "warn").mockImplementation(() => {})
    await expect(consumer.getSession(providerId, ["read"])).rejects.toBeInstanceOf(
      ConsumerTokenReadDenied
    )
    await expect(consumer.getSessions(providerId, ["read"])).rejects.toBeInstanceOf(
      ConsumerTokenReadDenied
    )
    expect(warn).not.toHaveBeenCalled()
    const audit = getPermissionGuard().getAuditLog({
      pluginId: "host-transition-consumer",
      action: "check",
    })
    expect(audit).toHaveLength(0)
    expect(JSON.stringify(audit)).not.toContain("host-secret")
    await expect(
      createAdmittedAuthAPI("host-denied-consumer", allow, "deny").getSession(providerId, [])
    ).rejects.toBeInstanceOf(ConsumerTokenReadDenied)
    await expect(
      createAdmittedAuthAPI("host-owner", allow, "deny").getSession(providerId, [])
    ).resolves.toEqual(session)
  })

  it("stores form configuration through the Host without exposing it to provider callbacks", async () => {
    jest.mocked(invokePluginApi).mockClear()
    jest.mocked(invokePluginApi).mockResolvedValueOnce(undefined)
    const configuration = { clientSecret: "form-client-secret" }
    const session = await createAdmittedAuthAPI("host-owner", allow).getSession(
      providerId,
      ["read"],
      {
        createIfNone: true,
        configuration,
      }
    )
    expect(session?.accessToken).toBe("host-secret")
    expect(invokePluginApi).toHaveBeenCalledWith("host-owner", "auth:setClientSecret", {
      providerId,
      clientId: "client",
      issuer: "https://issuer.test",
      value: configuration.clientSecret,
    })
    expect(JSON.stringify(jest.mocked(provider.authorize!).mock.calls)).not.toContain(
      configuration.clientSecret
    )
    expect(JSON.stringify(jest.mocked(provider.exchange!).mock.calls)).not.toContain(
      configuration.clientSecret
    )
    expect(jest.mocked(provider.exchange!).mock.calls[0][0]).not.toHaveProperty("configuration")
    expect(JSON.stringify(await getAuthConnection(session!.id))).not.toContain(
      configuration.clientSecret
    )
  })

  it("refreshes two connections with each stored client binding and its own Host secret", async () => {
    __resetAuthRegistryForTesting()
    const owner = createAdmittedAuthAPI("host-owner", allow)
    const secrets = new Map<string, string>()
    const sent: Array<{ clientId: string; secret: string }> = []
    jest.mocked(invokePluginApi).mockImplementation(async (_pluginId, operation, input) => {
      const payload = input as {
        clientId: string
        issuer: string
        value: string
        params: Record<string, string>
        knownClients?: Array<{ clientId: string; issuer: string }>
      }
      const key = JSON.stringify([payload.issuer, payload.clientId])
      if (operation === "auth:setClientSecret") {
        secrets.set(key, payload.value)
        return undefined
      }
      expect(operation).toBe("auth:exchange")
      expect(payload.knownClients).toEqual(
        expect.arrayContaining([
          { clientId: "one", issuer: "https://issuer.test" },
          { clientId: "two", issuer: "https://issuer.test" },
        ])
      )
      sent.push({ clientId: payload.clientId, secret: secrets.get(key)! })
      return { status: 200, body: { access_token: `refreshed-${payload.clientId}` } }
    })
    owner.registerProvider({
      management: "host",
      id: providerId,
      label: "Acme",
      authorize: provider.authorize,
      exchange: async (attempt) => ({
        accessToken: attempt.clientId,
        refreshToken: `refresh-${attempt.clientId}`,
        scopes: ["read"],
        expiresAt: "2000-01-01T00:00:00Z",
      }),
      describe: async (credentials) => ({
        clientId: credentials.accessToken,
        issuer: "https://issuer.test",
        principal: { id: "same-user", kind: "user" },
        accountLabel: "User",
        scopes: credentials.scopes,
      }),
      refresh: async (lineage) => {
        const response = await owner.exchangeConfidential({
          providerId,
          tokenUrl: "https://issuer.test/token",
          placement: "basic",
          clientId: lineage.identity.clientId,
          issuer: lineage.identity.issuer,
          params: { grant_type: "refresh_token", refresh_token: lineage.credentials.refreshToken! },
        })
        return { accessToken: String(response.body.access_token), scopes: ["read"] }
      },
    })
    const refs = []
    for (const clientId of ["one", "two"]) {
      refs.push(
        await connectProvider({
          providerId,
          scopes: ["read"],
          configuration: { clientId, clientSecret: `secret-${clientId}` },
        })
      )
    }
    await Promise.all(
      refs.map((ref) =>
        getConnectionManager().getCredentials(ref, {
          credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
        })
      )
    )
    expect(sent).toEqual(
      expect.arrayContaining([
        { clientId: "one", secret: "secret-one" },
        { clientId: "two", secret: "secret-two" },
      ])
    )
    expect(sent).toHaveLength(2)
    jest.mocked(invokePluginApi).mockReset()
  })

  it("tombstones before revoking and removes the legacy session", async () => {
    const session = await createAdmittedAuthAPI("host-owner", allow).getSession(providerId, [], {
      createIfNone: true,
    })
    await removeSession(providerId, session!.id)
    expect(provider.revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({ accessToken: "host-secret" }),
      })
    )
    expect(await getAuthConnection(session!.id)).toMatchObject({ status: "revoked", revision: 2 })
    expect(await createAdmittedAuthAPI("host-owner", allow).getSessions(providerId)).toEqual([])
  })

  it("refreshes expired credentials only through the Host lineage lock", async () => {
    jest.mocked(provider.exchange!).mockResolvedValueOnce({
      accessToken: "expired",
      refreshToken: "refresh-secret",
      expiresAt: "2020-01-01T00:00:00.000Z",
      scopes: ["read"],
    })
    await connectProvider({ providerId, scopes: ["read"] })
    expect(provider.refresh).not.toHaveBeenCalled()
    const owner = createAdmittedAuthAPI("host-owner", allow)
    const sessions = await Promise.all([
      owner.getSession(providerId, []),
      owner.getSession(providerId, []),
    ])
    expect(sessions.map((session) => session?.accessToken)).toEqual([
      "rotated-secret",
      "rotated-secret",
    ])
    expect(provider.refresh).toHaveBeenCalledTimes(1)
  })

  it("admits owner reads outside a run and never lends UI authority to a Host-bound non-person run", async () => {
    await connectProvider({ providerId, scopes: ["read"] })
    const admitted = createAdmittedAuthAPI("host-owner", allow)
    const unproven = createAuthAPI("host-owner", allow)
    await expect(admitted.getSessions(providerId)).resolves.toHaveLength(1)
    await expect(unproven.getSessions(providerId)).resolves.toHaveLength(1)
    await expect(unproven.getSession(providerId, ["read"])).resolves.toMatchObject({
      accessToken: "host-secret",
    })
    const run = await startToolExecutionRun(undefined, { runId: "host-owner-non-person" })
    await withPluginExecutionContext("host-owner", { executionRunId: run.id }, async () => {
      await expect(unproven.getSessions(providerId)).rejects.toMatchObject({
        name: "PersonalCredentialRefusedError",
      })
      await expect(admitted.getSession(providerId, ["read"])).rejects.toMatchObject({
        name: "PersonalCredentialRefusedError",
      })
    })
    await expect(admitted.getSessions(providerId)).resolves.toHaveLength(1)
    await expect(getHostAuthSession(providerId, ["read"])).rejects.toMatchObject({
      name: "PersonalCredentialRefusedError",
    })
    await expect(
      getHostAuthSession(providerId, ["read"], undefined, { localAuthorization: LOCAL_PERSON_RUN })
    ).resolves.toMatchObject({ accessToken: "host-secret" })
  })

  it.each(["service", "external-event"] as const)(
    "binds cross-plugin prepare/execute interceptors to the exact %s run",
    async (automation) => {
      await connectProvider({ providerId, scopes: ["read"] })
      const owner = createAuthAPI("host-owner", allow)
      const run = await startToolExecutionRun(undefined, {
        runId: `interceptor-${automation}`,
        automation: automation === "service" ? "service" : undefined,
      })
      const attempted: string[] = []
      for (const [pointId, semantic] of [
        ["tool.call.prepare", "transform"],
        ["tool.execute", "around"],
      ] as const) {
        registerInterceptor({
          registrationId: pointId,
          pluginId: "host-owner",
          pluginInstanceId: "host-owner#1",
          generation: 1,
          realmId: "global",
          pointId,
          semantic,
          trustTier: "community",
          order: {},
          timeoutMs: 5000,
          source: "interceptors",
          runtime: "frontend",
          handler: (async (value: unknown, next?: (value: unknown) => Promise<unknown>) => {
            await expect(owner.getSessions(providerId)).rejects.toMatchObject({
              name: "PersonalCredentialRefusedError",
            })
            attempted.push(pointId)
            return semantic === "around" ? next!(value) : value
          }) as never,
        })
      }
      __setInvokePluginToolDepsForTesting({
        getManager: () => ({
          getPlugin: () => ({ status: "enabled", manifest: { permissions: [] } }),
          getRegistry: () => ({
            getTool: () => ({
              name: "safe",
              pluginId: "tool-owner",
              definition: {
                name: "safe",
                description: "safe",
                parametersSchema: { type: "object" },
              },
              execute: async () => "safe",
            }),
          }),
          handleActivationEvent: async () => {},
        }),
        getGuard: () => ({ getTier: () => "silent", checkWithConsent: async () => true }),
        getBroker: () => ({ request: async () => true }),
        resolveSandboxRuntimeRef: () => undefined,
      })
      await expect(
        invokePluginTool("tool-owner", "safe", {}, { executionRunId: run.id })
      ).resolves.toMatchObject({ result: "safe" })
      expect(attempted).toEqual(["tool.call.prepare", "tool.execute"])
      await expect(owner.getSessions(providerId)).resolves.toHaveLength(1)

      // A failed-open transform returns to the Host before the plugin settles.
      // Its later auth read must still use the original run, not the owner exception.
      __resetInterceptorRegistryForTesting()
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      let callback!: Promise<void>
      registerInterceptor({
        registrationId: "late-prepare",
        pluginId: "host-owner",
        pluginInstanceId: "host-owner#1",
        generation: 1,
        realmId: "global",
        pointId: "tool.call.prepare",
        semantic: "transform",
        trustTier: "community",
        order: {},
        timeoutMs: 1,
        source: "interceptors",
        runtime: "frontend",
        handler: ((value: unknown) => {
          callback = (async () => {
            await waiting
            expect(pluginExecutionContext("host-owner")?.executionRunId).toBe(run.id)
            await expect(owner.getSessions(providerId)).rejects.toMatchObject({
              name: "PersonalCredentialRefusedError",
            })
          })()
          return callback.then(() => value)
        }) as never,
      })
      try {
        await expect(
          invokePluginTool("tool-owner", "safe", {}, { executionRunId: run.id })
        ).resolves.toMatchObject({ result: "safe" })
        expect(pluginExecutionContext("host-owner")?.executionRunId).toBe(run.id)
      } finally {
        release()
        await callback
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      await expect(owner.getSessions(providerId)).resolves.toHaveLength(1)
    }
  )

  it("binds issue pull/push/create and production scheduled sync, while admitting the person's UI sync", async () => {
    await connectProvider({ providerId, scopes: ["read"] })
    const owner = createAuthAPI("host-owner", allow)
    getPermissionGuard().registerPlugin("host-owner", ["issue:write"])
    const read = async () => {
      await owner.getSessions(providerId)
    }
    createIssuesAPI("host-owner", {
      id: "host-owner",
      issueSyncProviders: [{ id: "private", label: "Private", schemaVersion: 1 }],
    }).registerSyncProvider({
      id: "private",
      label: "Private",
      pullFields: [],
      pushFields: [],
      resource: {
        label: "Private",
        schemaVersion: 1,
        schema: { type: "object", properties: {} },
        describe: () => ({ key: "private", label: "Private" }),
      },
      pull: async () => {
        await read()
        return { items: [], notModified: true }
      },
      push: async () => {
        await read()
        return { status: "applied" }
      },
      create: async () => {
        await read()
        return { provider: "private", externalId: "1" }
      },
    })
    const provider = getIssueSyncRegistry().get("plugin:host-owner/private")!
    const run = await startToolExecutionRun(undefined, {
      runId: "issue-service",
      automation: "service",
    })
    const credentialContext = { executionRunId: run.id }
    await expect(provider.pull({} as never, { credentialContext })).rejects.toMatchObject({
      name: "PersonalCredentialRefusedError",
    })
    await expect(
      provider.push!({} as never, {} as never, {}, {} as never, {
        idempotencyKey: "private",
        by: { kind: "agent" },
        credentialContext,
      })
    ).rejects.toMatchObject({ name: "PersonalCredentialRefusedError" })
    await expect(
      provider.create!({} as never, {} as never, credentialContext)
    ).rejects.toMatchObject({ name: "PersonalCredentialRefusedError" })
    const listContainers = async () =>
      [
        {
          id: "private-container",
          projectId: "private-workspace",
          resources: [
            {
              kind: "plugin",
              providerId: provider.id,
              schemaVersion: 1,
              config: {},
              addedAt: 1,
              sync: { mode: "import" },
            },
          ],
        },
      ] as never
    const credentialReads = jest.spyOn(ConnectionCredentialStore.prototype, "read")
    const scheduled = await runWorkspaceIssueSync({ mirror: false }, { listContainers })
    expect(scheduled.bindingCount).toBe(1)
    expect(scheduled.failures).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ name: "IssueSyncOutcomeError", code: "sync-failed" }),
      }),
    ])
    expect(credentialReads).not.toHaveBeenCalled()
    credentialReads.mockRestore()
    const local = await runWorkspaceIssueSync(
      // A full manual rebuild deliberately retries the failed background pass;
      // automatic runs keep the core's persisted backoff.
      { mirror: false, full: true, credentialContext: { localAuthorization: LOCAL_PERSON_RUN } },
      { listContainers }
    )
    expect(local.bindingCount).toBe(1)
    expect(local.failures).toEqual([])
    expect(local.outcomes).toHaveLength(1)
    await expect(owner.getSessions(providerId)).resolves.toHaveLength(1)
  })

  it("keeps Host-managed service sessions available without personal admission", async () => {
    provider.describe = async (credentials) => ({
      issuer: "https://issuer.test",
      clientId: "client",
      principal: { id: "app", kind: "service" },
      accountLabel: "Service",
      scopes: credentials.scopes,
    })
    createAuthAPI("host-owner", allow).registerProvider(provider)
    await connectProvider({ providerId, scopes: ["read"] })
    await expect(createAuthAPI("host-owner", allow).getSessions(providerId)).resolves.toHaveLength(
      1
    )
  })

  it.each(["getSession", "getSessions"] as const)(
    "does not let a local-person run replace a consumer grant on raw %s",
    async (method) => {
      await connectProvider({ providerId, scopes: ["read"] })
      const consumer = createAuthAPI("ungranted-consumer", allow)
      const run = await startToolExecutionRun(undefined, {
        runId: "ungranted-local-consumer",
        localAuthorization: LOCAL_PERSON_RUN,
      })
      await withPluginExecutionContext(
        "ungranted-consumer",
        { executionRunId: run.id },
        async () => {
          await expect(consumer[method](providerId, ["read"])).rejects.toMatchObject({
            name: "ConsumerTokenReadDenied",
          })
        }
      )
    }
  )

  it("requires the grant outside a run and additionally the Host-run decision inside a run, without legacy token reads", async () => {
    const consumer = "host-business"
    const ref = await connectProvider({ providerId, scopes: ["read"] })
    registerExternalServices(consumer, [
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
            surfaces: ["chat"],
          },
        ],
      },
    ])
    registerIntegrationDefinitions({
      pluginId: consumer,
      definitions: [
        {
          id: "items",
          label: "Items",
          allowedOrigins: ["https://issuer.test"],
          authStrategies: [{ id: "oauth", type: "oauth2", label: "OAuth", providerId }],
          resourceKinds: [],
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
    })
    const account = await createIntegrationAccount(consumer, {
      integrationId: "items",
      providerId,
      connectionId: ref,
      authSessionId: "unused-legacy-handle",
      remoteAccountId: "user",
      label: "Account",
    })
    const api = createIntegrationsAPI(consumer, allow.hasPermission)
    await expect(
      api.authenticatedRequest(account.id, "https://issuer.test/items")
    ).rejects.toMatchObject({ name: "ConsumerGrantRequired" })
    const [projection] = await listServiceConnections({ pluginId: consumer })
    await putCapabilityGrant({
      id: "host-consumer-grant",
      connectionId: projection.id,
      providerFingerprint: projection.providerFingerprint,
      consumerPluginId: consumer,
      connectionRevision: 1,
      operationPatterns: ["items.request.GET"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    jest.mocked(proxyFetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ items: ["one"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    )
    const sessionRead = jest.spyOn(
      listProviders().find((item) => item.id === providerId)!,
      "getSessions"
    )
    await expect(
      api.authenticatedRequest(account.id, "https://issuer.test/items")
    ).resolves.toMatchObject({ data: { items: ["one"] } })
    const run = await startToolExecutionRun(undefined, { runId: "host-consumer-non-person" })
    await withPluginExecutionContext(consumer, { executionRunId: run.id }, async () => {
      await expect(
        api.authenticatedRequest(account.id, "https://issuer.test/items", {
          credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
        } as never)
      ).rejects.toMatchObject({ name: "PersonalCredentialRefusedError" })
    })
    expect(proxyFetch).toHaveBeenCalledTimes(1)
    expect(
      await authenticatedIntegrationRequest(
        consumer,
        account.id,
        "https://issuer.test/items",
        undefined,
        { localAuthorization: LOCAL_PERSON_RUN }
      )
    ).toMatchObject({
      data: { items: ["one"] },
    })
    expect(
      new Headers(jest.mocked(proxyFetch).mock.calls.at(-1)![1]?.headers).get("authorization")
    ).toBe("Bearer host-secret")
    expect(sessionRead).not.toHaveBeenCalled()
    expect(provider.refresh).not.toHaveBeenCalled()
  })
})

it("wires all four connection methods through the auth:consume gate", async () => {
  const connections = createAdmittedAuthAPI("consumer", deny).connections
  expect(Object.keys(connections).sort()).toEqual(["get", "list", "onDidChange", "requestGrant"])
  await expect(connections.list()).rejects.toThrow("auth:consume")
  expect(() => connections.onDidChange(() => {})).toThrow("auth:consume")
})

jest.mock("@/lib/plugin/core/transport", () => ({
  ...jest.requireActual("@/lib/plugin/core/transport"),
  isPluginGatewayAvailable: jest.fn(() => true),
  invokePluginApi: jest.fn(),
}))
import {
  invokePluginApi,
  isPluginGatewayAvailable,
  PluginGatewayError,
} from "@/lib/plugin/core/transport"

describe("confidential exchange", () => {
  const request = {
    providerId: "acme",
    tokenUrl: "https://acme.test/token",
    params: { grant_type: "client_credentials" },
    clientId: "client",
    issuer: "https://acme.test",
    placement: "basic" as const,
  }
  beforeEach(() => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
  })
  it("uses the trusted gateway and returns only the token response", async () => {
    const response = { status: 200, body: { access_token: "token" } }
    jest.mocked(invokePluginApi).mockResolvedValueOnce(response)
    await expect(
      createAdmittedAuthAPI("owner", allow).exchangeConfidential(request)
    ).resolves.toEqual(response)
    expect(invokePluginApi).toHaveBeenLastCalledWith("owner", "auth:exchange", request)
  })
  it.each(["auth:provide", "network:fetch"])(
    "requires %s before calling the gateway",
    async (permission) => {
      jest.mocked(invokePluginApi).mockClear()
      await expect(
        createAdmittedAuthAPI("owner", {
          hasPermission: (p) => p !== permission,
        }).exchangeConfidential(request)
      ).rejects.toThrow(permission)
      expect(invokePluginApi).not.toHaveBeenCalled()
    }
  )
  it("fails closed without a trusted runtime", async () => {
    jest.mocked(detectPlatform).mockReturnValue("web")
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(false)
    jest.mocked(invokePluginApi).mockClear()
    const result = createAdmittedAuthAPI("owner", allow).exchangeConfidential(request)
    await expect(result).rejects.toBeInstanceOf(PluginGatewayError)
    await expect(result).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      details: {
        reason: "confidential-exchange-unavailable",
        recovery: ["pair-with-desktop", "use-always-on-host"],
      },
    })
    expect(invokePluginApi).not.toHaveBeenCalled()
  })
})

it("consumes a Host attempt on legacy plugin callback routes even when the old driver owns its state", async () => {
  const { routePluginDeepLink } = await import("@/lib/plugin/uri/route-deep-link")
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    data: { access_token: "token" },
  })
  let sentState = ""
  const result = await createAdmittedAuthAPI("legacy-owner", {
    ...allow,
    network: { fetch },
  }).createPkceFlow({
    ...pkceConfig(),
    state: "legacy-driver-state",
    waitForCode: () => new Promise(() => {}),
    openUrl: async (raw) => {
      sentState = new URL(raw).searchParams.get("state")!
      await routePluginDeepLink(
        `cognia://plugin/legacy-owner/oauth-callback?state=${sentState}&code=old-route-code`
      )
    },
  })
  expect(sentState).toMatch(/^[a-f0-9]{64}$/)
  expect(result.accessToken).toBe("token")
  const { consumeAttempt } = await import("@/lib/plugin/auth/auth-attempts")
  await expect(
    consumeAttempt(sentState, {
      providerId: "legacy-owner",
      clientId: "client",
      issuer: "https://auth.example.com",
    })
  ).rejects.toMatchObject({ reason: "already-consumed" })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it("rejects replayed driver state before a token exchange", async () => {
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    data: { access_token: "token" },
  })
  const api = createAdmittedAuthAPI("owner", { ...allow, network: { fetch } })
  let firstState = ""
  await api.createPkceFlow({
    ...pkceConfig(),
    waitForCode: async ({ state }) => {
      firstState = state
      return { code: "first", state }
    },
  })
  await expect(
    api.createPkceFlow({
      ...pkceConfig(),
      waitForCode: async () => ({ code: "replay", state: firstState }),
    })
  ).rejects.toThrow("state mismatch")
  expect(fetch).toHaveBeenCalledTimes(1)
})

it("cancels the attempt when aborted and drops a late callback", async () => {
  const { acceptCallback } = await import("@/lib/plugin/auth/callback-acceptor")
  const controller = new AbortController()
  const fetch = jest.fn()
  let state = ""
  const flow = createAdmittedAuthAPI("owner", { ...allow, network: { fetch } }).createPkceFlow({
    ...pkceConfig(),
    signal: controller.signal,
    openUrl: (raw) => {
      state = new URL(raw).searchParams.get("state")!
      controller.abort()
    },
    waitForCode: () => new Promise(() => {}),
  })
  await expect(flow).rejects.toThrow("cancelled")
  expect(await acceptCallback({ state, code: "late" }, "deep-link")).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})

describe("createAuthAPI", () => {
  beforeEach(() => {
    localStorage.clear()
    resetPermissionGuard()
  })
  afterEach(() => __resetAuthRegistryForTesting())

  it.each(["getSession", "getSessions"] as const)(
    "transitions non-owner %s with one audit per call and one process warning",
    async (method) => {
      const owner = createAdmittedAuthAPI("owner", allow)
      owner.registerProvider(fakeProvider({ id: `transition-${method}` }))
      const api = createAdmittedAuthAPI(`transition-consumer-${method}`, allow)
      const warn = jest.spyOn(loggers.plugin, "warn").mockImplementation(() => {})
      try {
        const result = await api[method](`transition-${method}`, [])
        expect(method === "getSession" ? result : (result as AuthSession[])[0]).toMatchObject({
          accessToken: "tok",
        })
        const audit = getPermissionGuard().getAuditLog({
          pluginId: `transition-consumer-${method}`,
          action: "check",
        })
        expect(audit).toHaveLength(1)
        expect(JSON.stringify(audit)).not.toContain('"tok"')
        await api[method](`transition-${method}`, [])
        expect(warn).toHaveBeenCalledTimes(1)
        expect(
          getPermissionGuard().getAuditLog({
            pluginId: `transition-consumer-${method}`,
            action: "check",
          })
        ).toHaveLength(2)
        await owner[method](`transition-${method}`, [])
        expect(
          getPermissionGuard().getAuditLog({ pluginId: "owner", action: "check" })
        ).toHaveLength(0)
      } finally {
        warn.mockRestore()
      }
    }
  )

  it.each(["getSession", "getSessions"] as const)(
    "deny policy withholds non-owner %s by throwing a typed error",
    async (method) => {
      const owner = createAdmittedAuthAPI("owner", allow, "deny")
      owner.registerProvider(fakeProvider())
      await expect(
        createAdmittedAuthAPI("consumer", allow, "deny")[method]("acme", [])
      ).rejects.toBeInstanceOf(ConsumerTokenReadDenied)
      const result = await owner[method]("acme", [])
      expect(method === "getSession" ? result : (result as AuthSession[])[0]).toMatchObject({
        accessToken: "tok",
      })
    }
  )

  describe("permission gating", () => {
    it("requires auth:consume to subscribe", () => {
      expect(() => createAdmittedAuthAPI("p", deny).onDidChangeSessions(() => {})).toThrow(
        /auth:consume/
      )
    })
    it("registerProvider requires auth:provide", () => {
      const api = createAdmittedAuthAPI("p", deny)
      expect(() => api.registerProvider(fakeProvider())).toThrow(/auth:provide/)
    })

    it("getSession/getSessions require auth:consume", async () => {
      const api = createAdmittedAuthAPI("p", { hasPermission: (perm) => perm === "auth:provide" })
      api.registerProvider(fakeProvider())
      await expect(api.getSession("acme", ["repo"])).rejects.toThrow(/auth:consume/)
      await expect(api.getSessions("acme")).rejects.toThrow(/auth:consume/)
    })

    it("createPkceFlow requires auth:provide", async () => {
      const api = createAdmittedAuthAPI("p", deny)
      await expect(
        api.createPkceFlow({
          authorizeUrl: "https://a",
          tokenUrl: "https://t",
          clientId: "c",
          scopes: [],
          redirectUri: "http://localhost",
          openUrl: () => {},
          waitForCode: async () => ({ code: "x", state: "y" }),
        })
      ).rejects.toThrow(/auth:provide/)
    })
  })

  it("keeps provider ownership after deactivation and registry restart", () => {
    const dispose = createAdmittedAuthAPI("owner", allow).registerProvider(fakeProvider())
    dispose()
    __resetAuthRegistryForTesting()
    expect(() => createAdmittedAuthAPI("squatter", allow).registerProvider(fakeProvider())).toThrow(
      /owned by another plugin/
    )
    expect(() =>
      createAdmittedAuthAPI("owner", allow).registerProvider(fakeProvider())
    ).not.toThrow()
  })

  it("rechecks permission for each event delivery", async () => {
    const guard = getPermissionGuard()
    guard.registerPlugin("consumer", ["auth:consume"])
    const consumer = createAdmittedAuthAPI("consumer", {
      hasPermission: (permission) => guard.check("consumer", permission as "auth:consume"),
    })
    const listener = jest.fn()
    consumer.onDidChangeSessions(listener)
    const owner = createAdmittedAuthAPI("owner", allow)
    owner.registerProvider(fakeProvider({ getSessions: async () => [] }))
    await owner.getSession("acme", [], { createIfNone: true })
    expect(listener).toHaveBeenCalledTimes(1)
    guard.revoke("consumer", "auth:consume")
    await expect(consumer.getSession("acme", [])).rejects.toThrow(/auth:consume/)
    await expect(consumer.getSessions("acme")).rejects.toThrow(/auth:consume/)
    expect(() => consumer.onDidChangeSessions(jest.fn())).toThrow(/auth:consume/)
    await owner.getSession("acme", [], { forceNewSession: true })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("forbids plugin-supplied PKCE transport overrides before calling them", async () => {
    const fetchImpl = jest.fn()
    await expect(
      createAdmittedAuthAPI("p", allow).createPkceFlow({
        ...pkceConfig(),
        fetchImpl,
      } as PluginPkceFlowConfig)
    ).rejects.toThrow(/does not allow fetchImpl/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("requires network permission before exchanging PKCE tokens", async () => {
    const fetch = jest.fn()
    const config = pkceConfig()
    await expect(
      createAdmittedAuthAPI("p", {
        hasPermission: (permission) => permission === "auth:provide",
        network: { fetch },
      }).createPkceFlow(config)
    ).rejects.toThrow(/network:fetch/)
    expect(fetch).not.toHaveBeenCalled()
    expect(config.openUrl).not.toHaveBeenCalled()
  })

  it("never falls back to global fetch without a host transport", async () => {
    await expect(createAdmittedAuthAPI("p", allow).createPkceFlow(pkceConfig())).rejects.toThrow(
      /host-governed network transport/
    )
  })

  describe.each(["form", "json"] as const)("host PKCE %s provenance", (tokenRequestEncoding) => {
    function transport() {
      const bodies: Record<string, string>[] = []
      const fetch = jest
        .fn()
        .mockImplementation(async (url: string, options: NetworkRequestOptions) => {
          // Host wrappers may clone options. Symbol provenance must survive the
          // spread without becoming a public string-keyed network option.
          const forwarded = { ...options }
          const egress = sanitizePluginNetworkEgress(
            "provider",
            { url, ...forwarded },
            {
              oauthTokenKeys: getHostPkceTokenRequestExemptKeys(forwarded, url),
            }
          )
          bodies.push(
            typeof egress.body === "string"
              ? Object.fromEntries(new URLSearchParams(egress.body))
              : (egress.body as Record<string, string>)
          )
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: {},
            data: { access_token: "secret" },
          }
        })
      return { fetch, bodies }
    }

    it("preserves code, client id and verifier shapes while sanitizing extra parameters", async () => {
      const { fetch, bodies } = transport()
      const api = createAdmittedAuthAPI("provider", { ...allow, network: { fetch } })
      const clientId = "10123456789-abc.apps.googleusercontent.com"
      for (const code of [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
        "1234567890",
        "13812345678",
      ]) {
        const verifier = `sk-${"a".repeat(43)}`
        jest.mocked(generateCodeVerifier).mockReturnValueOnce(verifier)
        await api.createPkceFlow({
          ...pkceConfig(),
          tokenRequestEncoding,
          clientId,
          waitForCode: async ({ state }) => ({ code, state }),
          extraTokenParams: { token: "alice@example.com", secret: "bob@example.com" },
        })
        expect(bodies.at(-1)).toEqual({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: "http://localhost/callback",
          code_verifier: verifier,
          token: "<EMAIL_001>",
          secret: "<EMAIL_001>",
        })
      }
    })

    it.each(["grant_type", "code", "redirect_uri", "client_id", "code_verifier"])(
      "does not exempt an extraTokenParams override of %s",
      async (key) => {
        const { fetch, bodies } = transport()
        await createAdmittedAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
          ...pkceConfig(),
          tokenRequestEncoding,
          extraTokenParams: { [key]: "alice@example.com" },
        })
        expect(bodies[0][key]).toBe("<EMAIL_001>")
      }
    )

    it("keeps a confidential client's secret verbatim and still inspects other extras", async () => {
      const { fetch, bodies } = transport()
      const clientSecret = `sk-${"b".repeat(40)}`
      await createAdmittedAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
        ...pkceConfig(),
        tokenRequestEncoding,
        extraTokenParams: { client_secret: clientSecret, audience: "alice@example.com" },
      })
      expect(bodies[0].client_secret).toBe(clientSecret)
      expect(bodies[0].audience).toBe("<EMAIL_001>")
    })

    it("scopes captured provenance to this flow's token URL and lifetime", async () => {
      let captured: NetworkRequestOptions | undefined
      let duringFlow: { sameUrl?: ReadonlySet<string>; otherUrl?: ReadonlySet<string> } = {}
      const fetch = jest
        .fn()
        .mockImplementation(async (url: string, options: NetworkRequestOptions) => {
          captured = { ...options }
          duringFlow = {
            sameUrl: getHostPkceTokenRequestExemptKeys(captured, url),
            otherUrl: getHostPkceTokenRequestExemptKeys(captured, "https://collector.example/"),
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: {},
            data: { access_token: "secret" },
          }
        })
      await createAdmittedAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
        ...pkceConfig(),
        tokenRequestEncoding,
      })
      expect(duringFlow.sameUrl?.has("code")).toBe(true)
      expect(duringFlow.otherUrl).toBeUndefined()
      expect(getHostPkceTokenRequestExemptKeys(captured, pkceConfig().tokenUrl)).toBeUndefined()
    })

    it("snapshots token overrides before plugin callbacks run", async () => {
      const { fetch, bodies } = transport()
      const extraTokenParams = { code: "alice@example.com" }
      await createAdmittedAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
        ...pkceConfig(),
        tokenRequestEncoding,
        extraTokenParams,
        openUrl: () => {
          Reflect.deleteProperty(extraTokenParams, "code")
        },
      })
      expect(bodies[0].code).toBe("<EMAIL_001>")
    })
  })

  it.each(["getSession", "getSessions"] as const)(
    "review regression: %s withholds a provider result after auth:consume is revoked",
    async (method) => {
      let allowed = true
      const api = createAdmittedAuthAPI("p", { hasPermission: () => allowed })
      api.registerProvider(
        fakeProvider({
          getSessions: async () => {
            allowed = false
            return [
              __makeSession({
                accessToken: "secret",
                account: { id: "u", label: "U" },
                scopes: [],
              }),
            ]
          },
        })
      )
      await expect(api[method]("acme", [])).rejects.toThrow(/auth:consume/)
    }
  )

  it.each(["auth:provide", "network:fetch"])(
    "review regression: blocks PKCE dispatch when %s is revoked during the callback",
    async (permission) => {
      const revoked = new Set<string>()
      const fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        data: { access_token: "secret" },
      })
      const api = createAdmittedAuthAPI("p", {
        hasPermission: (p) => !revoked.has(p),
        network: { fetch },
      })
      await expect(
        api.createPkceFlow({
          ...pkceConfig(),
          waitForCode: async ({ state }) => {
            revoked.add(permission)
            return { code: "code", state }
          },
        })
      ).rejects.toThrow(permission)
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it.each(["auth:provide", "network:fetch"])(
    "review regression: withholds PKCE tokens when %s is revoked during exchange",
    async (permission) => {
      const revoked = new Set<string>()
      const fetch = jest.fn().mockImplementation(async () => {
        revoked.add(permission)
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          data: { access_token: "secret" },
        }
      })
      const api = createAdmittedAuthAPI("p", {
        hasPermission: (p) => !revoked.has(p),
        network: { fetch },
      })
      await expect(api.createPkceFlow(pkceConfig())).rejects.toThrow(permission)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it("filters session notifications by provider without relying on session ids", async () => {
    const api = createAdmittedAuthAPI("p", allow)
    const session = __makeSession({
      accessToken: "secret",
      account: { id: "u", label: "U" },
      scopes: [],
    })
    for (const id of ["acme", "other"])
      api.registerProvider(
        fakeProvider({ id, getSessions: async () => [], createSession: async () => session })
      )
    const listener = jest.fn()
    api.onDidChangeSessions(listener, "acme")
    await api.getSession("other", [], { createIfNone: true })
    await api.getSession("acme", [], { createIfNone: true })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].providerId).toBe("acme")
  })

  it("delivers only provider-tagged metadata for additions and removals", async () => {
    const api = createAdmittedAuthAPI("p", allow)
    const session = {
      ...__makeSession({
        accessToken: "secret",
        account: { id: "u", label: "U" },
        scopes: ["repo"],
      }),
      refreshToken: "also-secret",
    }
    api.registerProvider(
      fakeProvider({ createSession: async () => session, getSessions: async () => [session] })
    )
    const listener = jest.fn()
    const dispose = api.onDidChangeSessions(listener)
    await api.getSession("acme", [], { forceNewSession: true })
    await removeSession("acme", session.id)
    const metadata = { id: session.id, account: { id: "u", label: "U" }, scopes: ["repo"] }
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { providerId: "acme", added: [metadata], removed: [], changed: [] },
      { providerId: "acme", added: [], removed: [metadata], changed: [] },
    ])
    dispose()
    await api.getSession("acme", [], { forceNewSession: true })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("registers a provider stamped with the plugin id", () => {
    const api = createAdmittedAuthAPI("plugin-a", allow)
    api.registerProvider(fakeProvider())
    const [p] = listProviders()
    expect(p).toMatchObject({ id: "acme", pluginId: "plugin-a" })
  })

  it("cannot replace an authentication provider owned by another plugin", () => {
    const owner = createAdmittedAuthAPI("provider-owner", allow)
    owner.registerProvider(fakeProvider())
    const intruder = createAdmittedAuthAPI("another-plugin", allow)
    expect(() => intruder.registerProvider(fakeProvider())).toThrow(/owned by another plugin/)
    expect(listProviders()[0].pluginId).toBe("provider-owner")
  })

  it("getSessions delegates to the provider (silent)", async () => {
    const api = createAdmittedAuthAPI("p", allow)
    const getSessions = jest.fn(async () => [
      __makeSession({ accessToken: "t", account: { id: "u", label: "U" }, scopes: [] }),
    ])
    api.registerProvider(fakeProvider({ getSessions }))
    const sessions = await api.getSessions("acme", ["repo"])
    expect(sessions).toHaveLength(1)
    expect(getSessions).toHaveBeenCalledWith(["repo"], { silent: true })
  })

  it("getSessions throws for an unknown provider", async () => {
    const api = createAdmittedAuthAPI("p", allow)
    await expect(api.getSessions("nope")).rejects.toThrow(/No auth provider/)
  })

  it("getSession returns an existing matching session", async () => {
    const api = createAdmittedAuthAPI("p", allow)
    api.registerProvider(fakeProvider())
    const session = await api.getSession("acme", ["repo"])
    expect(session?.accessToken).toBe("tok")
  })

  it("onDidChangeSessions observes session changes", async () => {
    const api = createAdmittedAuthAPI("p", allow)
    const events: unknown[] = []
    api.onDidChangeSessions((e) => events.push(e))
    api.registerProvider(
      fakeProvider({
        getSessions: async () => [],
        createSession: async () =>
          __makeSession({ accessToken: "new", account: { id: "u", label: "U" }, scopes: ["repo"] }),
      })
    )
    await api.getSession("acme", ["repo"], { createIfNone: true })
    await new Promise((r) => queueMicrotask(() => r(null)))
    expect(events.length).toBeGreaterThan(0)
  })
})

it.each([true, false])(
  "PKCE cleanup never replaces the result or original exchange error, success=%s",
  async (success) => {
    const original = new Error("exchange offline")
    const fetch = success
      ? jest.fn().mockResolvedValue({
          status: 200,
          statusText: "OK",
          headers: {},
          data: { access_token: "token" },
        })
      : jest.fn().mockRejectedValue(original)
    jest.mocked(cancelAttempt).mockRejectedValueOnce(new Error("cleanup offline"))
    const pending = createAdmittedAuthAPI("cleanup-owner", {
      ...allow,
      network: { fetch },
    }).createPkceFlow(pkceConfig())
    if (success) await expect(pending).resolves.toMatchObject({ accessToken: "token" })
    else await expect(pending).rejects.toBe(original)
  }
)

it("PKCE rejects storage failure promptly instead of waiting for attempt expiry", async () => {
  const { getAuthAttemptStore } = await import("@/lib/plugin/auth/auth-attempts")
  const failure = new Error("attempt storage offline")
  const attemptStore = getAuthAttemptStore()
  const consume = jest.spyOn(attemptStore, "consumeAttempt").mockRejectedValueOnce(failure)
  const fetch = jest.fn()
  try {
    await expect(
      createAdmittedAuthAPI("storage-owner", { ...allow, network: { fetch } }).createPkceFlow(
        pkceConfig()
      )
    ).rejects.toBe(failure)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    consume.mockRestore()
  }
})
