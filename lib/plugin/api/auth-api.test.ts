/** @jest-environment jsdom */

import {
  createAuthAPI,
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
import { setHostAuthBackend } from "@/lib/plugin/auth/connection-credentials"
import { withNamedLock } from "@/lib/locks/named-lock"
import { acceptCallback } from "@/lib/plugin/auth/callback-acceptor"
import { openExternal } from "@/lib/tauri/opener"
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
    createAuthAPI("host-owner", allow).registerProvider(provider)
  })
  afterEach(() => {
    setHostAuthBackend(null)
    __resetAuthRegistryForTesting()
    jest.restoreAllMocks()
    __resetIntegrationRegistryForTesting()
    unregisterExternalServicesByPlugin("host-business")
  })

  it("registers without session callbacks and serves connected, scope-matching sessions", async () => {
    expect(provider.getSessions).toBeUndefined()
    const owner = createAuthAPI("host-owner", allow)
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

  it("creates sessions through connectProvider and applies the consumer transition policy", async () => {
    const owner = createAuthAPI("host-owner", allow)
    const session = await owner.getSession(providerId, ["read"], { createIfNone: true })
    expect(session?.accessToken).toBe("host-secret")
    expect(provider.exchange).toHaveBeenCalledTimes(1)
    const consumer = createAuthAPI("host-transition-consumer", allow)
    const warn = jest.spyOn(loggers.plugin, "warn").mockImplementation(() => {})
    await expect(consumer.getSession(providerId, ["read"])).resolves.toEqual(session)
    await expect(consumer.getSessions(providerId, ["read"])).resolves.toEqual([session])
    expect(warn).toHaveBeenCalledTimes(1)
    const audit = getPermissionGuard().getAuditLog({
      pluginId: "host-transition-consumer",
      action: "check",
    })
    expect(audit).toHaveLength(2)
    expect(JSON.stringify(audit)).not.toContain("host-secret")
    await expect(
      createAuthAPI("host-denied-consumer", allow, "deny").getSession(providerId, [])
    ).rejects.toBeInstanceOf(ConsumerTokenReadDenied)
    await expect(
      createAuthAPI("host-owner", allow, "deny").getSession(providerId, [])
    ).resolves.toEqual(session)
  })

  it("tombstones before revoking and removes the legacy session", async () => {
    const session = await createAuthAPI("host-owner", allow).getSession(providerId, [], {
      createIfNone: true,
    })
    await removeSession(providerId, session!.id)
    expect(provider.revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({ accessToken: "host-secret" }),
      })
    )
    expect(await getAuthConnection(session!.id)).toMatchObject({ status: "revoked", revision: 2 })
    expect(await createAuthAPI("host-owner", allow).getSessions(providerId)).toEqual([])
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
    const owner = createAuthAPI("host-owner", allow)
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

  it("injects a granted consumer request through ctx.integrations without a session read", async () => {
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
    jest.mocked(proxyFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: ["one"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
    const sessionRead = jest.spyOn(
      listProviders().find((item) => item.id === providerId)!,
      "getSessions"
    )
    expect(await api.authenticatedRequest(account.id, "https://issuer.test/items")).toMatchObject({
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
  const connections = createAuthAPI("consumer", deny).connections
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
    placement: "basic" as const,
  }
  beforeEach(() => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(true)
  })
  it("uses the trusted gateway and returns only the token response", async () => {
    const response = { status: 200, body: { access_token: "token" } }
    jest.mocked(invokePluginApi).mockResolvedValueOnce(response)
    await expect(createAuthAPI("owner", allow).exchangeConfidential(request)).resolves.toEqual(
      response
    )
    expect(invokePluginApi).toHaveBeenLastCalledWith("owner", "auth:exchange", request)
  })
  it.each(["auth:provide", "network:fetch"])(
    "requires %s before calling the gateway",
    async (permission) => {
      jest.mocked(invokePluginApi).mockClear()
      await expect(
        createAuthAPI("owner", { hasPermission: (p) => p !== permission }).exchangeConfidential(
          request
        )
      ).rejects.toThrow(permission)
      expect(invokePluginApi).not.toHaveBeenCalled()
    }
  )
  it("fails closed without a trusted runtime", async () => {
    jest.mocked(isPluginGatewayAvailable).mockReturnValue(false)
    jest.mocked(invokePluginApi).mockClear()
    const result = createAuthAPI("owner", allow).exchangeConfidential(request)
    await expect(result).rejects.toBeInstanceOf(PluginGatewayError)
    await expect(result).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      details: { reason: "confidential-exchange-unavailable" },
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
  const result = await createAuthAPI("legacy-owner", {
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
  const api = createAuthAPI("owner", { ...allow, network: { fetch } })
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
  const flow = createAuthAPI("owner", { ...allow, network: { fetch } }).createPkceFlow({
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
      const owner = createAuthAPI("owner", allow)
      owner.registerProvider(fakeProvider({ id: `transition-${method}` }))
      const api = createAuthAPI(`transition-consumer-${method}`, allow)
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
      const owner = createAuthAPI("owner", allow, "deny")
      owner.registerProvider(fakeProvider())
      await expect(
        createAuthAPI("consumer", allow, "deny")[method]("acme", [])
      ).rejects.toBeInstanceOf(ConsumerTokenReadDenied)
      const result = await owner[method]("acme", [])
      expect(method === "getSession" ? result : (result as AuthSession[])[0]).toMatchObject({
        accessToken: "tok",
      })
    }
  )

  describe("permission gating", () => {
    it("requires auth:consume to subscribe", () => {
      expect(() => createAuthAPI("p", deny).onDidChangeSessions(() => {})).toThrow(/auth:consume/)
    })
    it("registerProvider requires auth:provide", () => {
      const api = createAuthAPI("p", deny)
      expect(() => api.registerProvider(fakeProvider())).toThrow(/auth:provide/)
    })

    it("getSession/getSessions require auth:consume", async () => {
      const api = createAuthAPI("p", { hasPermission: (perm) => perm === "auth:provide" })
      api.registerProvider(fakeProvider())
      await expect(api.getSession("acme", ["repo"])).rejects.toThrow(/auth:consume/)
      await expect(api.getSessions("acme")).rejects.toThrow(/auth:consume/)
    })

    it("createPkceFlow requires auth:provide", async () => {
      const api = createAuthAPI("p", deny)
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
    const dispose = createAuthAPI("owner", allow).registerProvider(fakeProvider())
    dispose()
    __resetAuthRegistryForTesting()
    expect(() => createAuthAPI("squatter", allow).registerProvider(fakeProvider())).toThrow(
      /owned by another plugin/
    )
    expect(() => createAuthAPI("owner", allow).registerProvider(fakeProvider())).not.toThrow()
  })

  it("rechecks permission for each event delivery", async () => {
    const guard = getPermissionGuard()
    guard.registerPlugin("consumer", ["auth:consume"])
    const consumer = createAuthAPI("consumer", {
      hasPermission: (permission) => guard.check("consumer", permission as "auth:consume"),
    })
    const listener = jest.fn()
    consumer.onDidChangeSessions(listener)
    const owner = createAuthAPI("owner", allow)
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
      createAuthAPI("p", allow).createPkceFlow({
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
      createAuthAPI("p", {
        hasPermission: (permission) => permission === "auth:provide",
        network: { fetch },
      }).createPkceFlow(config)
    ).rejects.toThrow(/network:fetch/)
    expect(fetch).not.toHaveBeenCalled()
    expect(config.openUrl).not.toHaveBeenCalled()
  })

  it("never falls back to global fetch without a host transport", async () => {
    await expect(createAuthAPI("p", allow).createPkceFlow(pkceConfig())).rejects.toThrow(
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
      const api = createAuthAPI("provider", { ...allow, network: { fetch } })
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
        await createAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
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
      await createAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
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
      await createAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
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
      await createAuthAPI("provider", { ...allow, network: { fetch } }).createPkceFlow({
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
      const api = createAuthAPI("p", { hasPermission: () => allowed })
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
      const api = createAuthAPI("p", { hasPermission: (p) => !revoked.has(p), network: { fetch } })
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
      const api = createAuthAPI("p", { hasPermission: (p) => !revoked.has(p), network: { fetch } })
      await expect(api.createPkceFlow(pkceConfig())).rejects.toThrow(permission)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it("filters session notifications by provider without relying on session ids", async () => {
    const api = createAuthAPI("p", allow)
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
    const api = createAuthAPI("p", allow)
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
    const api = createAuthAPI("plugin-a", allow)
    api.registerProvider(fakeProvider())
    const [p] = listProviders()
    expect(p).toMatchObject({ id: "acme", pluginId: "plugin-a" })
  })

  it("cannot replace an authentication provider owned by another plugin", () => {
    const owner = createAuthAPI("provider-owner", allow)
    owner.registerProvider(fakeProvider())
    const intruder = createAuthAPI("another-plugin", allow)
    expect(() => intruder.registerProvider(fakeProvider())).toThrow(/owned by another plugin/)
    expect(listProviders()[0].pluginId).toBe("provider-owner")
  })

  it("getSessions delegates to the provider (silent)", async () => {
    const api = createAuthAPI("p", allow)
    const getSessions = jest.fn(async () => [
      __makeSession({ accessToken: "t", account: { id: "u", label: "U" }, scopes: [] }),
    ])
    api.registerProvider(fakeProvider({ getSessions }))
    const sessions = await api.getSessions("acme", ["repo"])
    expect(sessions).toHaveLength(1)
    expect(getSessions).toHaveBeenCalledWith(["repo"], { silent: true })
  })

  it("getSessions throws for an unknown provider", async () => {
    const api = createAuthAPI("p", allow)
    await expect(api.getSessions("nope")).rejects.toThrow(/No auth provider/)
  })

  it("getSession returns an existing matching session", async () => {
    const api = createAuthAPI("p", allow)
    api.registerProvider(fakeProvider())
    const session = await api.getSession("acme", ["repo"])
    expect(session?.accessToken).toBe("tok")
  })

  it("onDidChangeSessions observes session changes", async () => {
    const api = createAuthAPI("p", allow)
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
    const pending = createAuthAPI("cleanup-owner", { ...allow, network: { fetch } }).createPkceFlow(
      pkceConfig()
    )
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
      createAuthAPI("storage-owner", { ...allow, network: { fetch } }).createPkceFlow(pkceConfig())
    ).rejects.toBe(failure)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    consume.mockRestore()
  }
})
