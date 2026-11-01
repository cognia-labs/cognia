/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getPlugin } from "@/lib/db/plugins"
import { getAuthConnection } from "@/lib/db/auth-connections"
import { openExternal } from "@/lib/tauri/opener"
import {
  registerAuthenticationProvider,
  __resetAuthRegistryForTesting,
} from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import type { AuthenticationProvider } from "./auth-provider-registry"
import { connectProvider } from "./connect"
import { acceptCallback } from "./callback-acceptor"
import { AuthConnectionManager, getConnectionManager } from "./connection-manager"
import { ConnectionCredentialStore, setHostAuthBackend } from "./connection-credentials"
import { withNamedLock } from "@/lib/locks/named-lock"
import { PluginGatewayError } from "@/lib/plugin/core/transport"
import { subscribeConnectionPrompts, resolveConnectionPrompt } from "./connection-prompts"
import { registerLegacySessionMigration } from "./legacy-session-migrations"
import { detectPlatform } from "@/lib/platform/detect"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(() => "web"),
}))
import { HOST_BACKGROUND, pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("./connection-manager", () => ({
  ...jest.requireActual("./connection-manager"),
  getConnectionManager: jest.fn(jest.requireActual("./connection-manager").getConnectionManager),
}))
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
let provider: AuthenticationProvider
let secrets: Map<string, Map<string, string>>
beforeEach(() => {
  jest
    .mocked(getConnectionManager)
    .mockImplementation(jest.requireActual("./connection-manager").getConnectionManager)
  jest.mocked(detectPlatform).mockReturnValue("web")
  __resetAuthRegistryForTesting()
  secrets = new Map()
  setHostAuthBackend({
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
    storeFor(namespace) {
      const values = secrets.get(namespace) ?? new Map<string, string>()
      secrets.set(namespace, values)
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
      authProviders: [
        {
          id: "acme",
          label: "Acme",
          methods: ["oauth-pkce", "client-credentials"],
          issuers: ["https://issuer.test"],
        },
      ],
      providesServices: { "auth.acme": "1.0.0" },
    },
  } as never)
  provider = {
    id: "acme",
    label: "Acme",
    pluginId: "owner",
    authorization: { clientId: "client", issuer: "https://issuer.test" },
    getSessions: async () => [],
    createSession: jest.fn(),
    removeSession: jest.fn(),
    authorize: jest.fn(async (attempt) => ({
      url: `https://issuer.test/authorize?state=${attempt.attemptId}`,
    })),
    exchange: jest.fn(async () => ({ accessToken: "secret", scopes: ["read"] })),
    describe: jest.fn(async (credentials) => ({
      issuer: "https://issuer.test",
      clientId: "client",
      principal: { id: "user", kind: "user" as const },
      accountLabel: "Account",
      scopes: credentials.scopes,
    })),
    revoke: jest.fn(async () => {}),
  }
  registerAuthenticationProvider(provider)
  jest
    .mocked(openExternal)
    .mockReset()
    .mockImplementation(async (raw) => {
      const state = new URL(raw).searchParams.get("state")!
      expect(await acceptCallback({ state, code: "code" }, "broadcast")).toBe(true)
      expect(await acceptCallback({ state, code: "replay" }, "broadcast")).toBe(false)
    })
})
afterEach(() => {
  __resetAuthRegistryForTesting()
  setHostAuthBackend(null)
  jest.useRealTimers()
})

it.each([
  HOST_BACKGROUND,
  { executionRunId: "sign-in-service" },
  { localAuthorization: LOCAL_PERSON_RUN } as const,
])(
  "binds auth provider callbacks to the exact Host sign-in identity: %p",
  async (credentialContext) => {
    const seen: unknown[] = []
    for (const name of ["authorize", "exchange", "describe"] as const) {
      const original = provider[name]!
      Object.assign(provider, {
        [name]: async (...args: unknown[]) => {
          await Promise.resolve()
          seen.push(pluginExecutionContext("owner"))
          expect(args[0]).not.toHaveProperty("credentialContext")
          return Reflect.apply(original, provider, args)
        },
      })
    }
    await connectProvider({ providerId: "acme", scopes: ["read"], credentialContext })
    expect(seen).toEqual([credentialContext, credentialContext, credentialContext])
    expect(pluginExecutionContext("owner")).toBeUndefined()
  }
)

it("creates a PKCE connection through authorize, single acceptance, exchange and describe", async () => {
  const ref = await connectProvider({ providerId: "acme", scopes: ["read"] })
  expect(provider.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "oauth-pkce",
      clientId: "client",
      codeChallenge: expect.any(String),
      codeVerifier: expect.any(String),
      redirectUri: `${window.location.origin}/plugin-auth/callback`,
    })
  )
  expect(provider.exchange).toHaveBeenCalledWith(
    expect.objectContaining({ attemptId: expect.any(String) }),
    { state: expect.any(String), code: "code", error: undefined, errorDescription: undefined }
  )
  expect(await getAuthConnection(ref)).toMatchObject({
    status: "connected",
    revision: 1,
    credentialRevision: 1,
  })
  const attempt = jest.mocked(provider.authorize!).mock.calls[0][0]
  expect(await acceptCallback({ state: attempt.attemptId, code: "late" }, "message")).toBe(false)
})

it("exchanges client credentials without opening a browser", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  await connectProvider({ providerId: "acme", scopes: ["read"], method: "client-credentials" })
  expect(provider.authorize).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
  expect(provider.exchange).toHaveBeenCalledWith(
    expect.objectContaining({ method: "client-credentials" }),
    { state: expect.any(String) }
  )
})

it("uses the manifest authorization binding for Host-managed providers", async () => {
  provider.management = "host"
  provider.authorization = { clientId: "wrong-client", issuer: "https://wrong.test" }
  const plugin = (await getPlugin("owner"))!
  const manifest = plugin.manifest as { authProviders: Array<Record<string, unknown>> }
  manifest.authProviders[0].authorization = { clientId: "client", issuer: "https://issuer.test" }
  await connectProvider({ providerId: "acme", scopes: ["read"] })
  expect(provider.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ clientId: "client", issuer: "https://issuer.test" })
  )
})

it("refuses to exchange until the registered legacy migration succeeds", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  provider.management = "host"
  const plugin = (await getPlugin("owner"))!
  const manifest = plugin.manifest as { authProviders: Array<Record<string, unknown>> }
  manifest.authProviders[0].authorization = { clientId: "client", issuer: "https://issuer.test" }
  const migrate = jest.fn(async () => {
    throw new Error("migration failed")
  })
  const dispose = registerLegacySessionMigration("owner", provider.id, {
    migrate,
    aliases: async () => new Map(),
  })
  try {
    await expect(
      connectProvider({ providerId: provider.id, scopes: ["read"], method: "client-credentials" })
    ).rejects.toMatchObject({ reason: "provider-or-storage-failed" })
    expect(migrate).toHaveBeenCalledWith(provider)
    expect(provider.exchange).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it("requires a declared manifest authorization binding for Host-managed providers", async () => {
  provider.management = "host"
  await expect(connectProvider({ providerId: "acme", scopes: [] })).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    reason: "authorization-configuration-missing",
  })
  expect(provider.exchange).not.toHaveBeenCalled()
})

it("resolves the configured App ID without exposing Host configuration to attempt callbacks", async () => {
  provider.management = "host"
  const plugin = (await getPlugin("owner"))!
  const definition = (plugin.manifest.authProviders as Array<Record<string, unknown>>)[0]
  definition.authorization = {
    clientIdFrom: { configuration: "appId" },
    issuer: "https://issuer.test",
  }
  definition.configurationSchema = {
    type: "object",
    properties: { appId: { type: "string" } },
    required: ["appId"],
  }
  await connectProvider({
    providerId: "acme",
    scopes: [],
    configuration: {
      appId: "client",
      clientId: "ignored",
      redirectUri: "https://callback.test/plugin-auth/callback",
    },
  })
  expect(provider.exchange).toHaveBeenCalledWith(
    expect.objectContaining({
      clientId: "client",
      redirectUri: "https://callback.test/plugin-auth/callback",
    }),
    expect.anything()
  )
  const attempt = jest.mocked(provider.authorize!).mock.calls[0][0]
  expect(attempt).not.toHaveProperty("configuration")
  expect(attempt).not.toHaveProperty("clientIdFrom")
})

it.each([undefined, "", 42])(
  "rejects a missing or invalid configured App ID %p before authorization",
  async (appId) => {
    provider.management = "host"
    const plugin = (await getPlugin("owner"))!
    const definition = (plugin.manifest.authProviders as Array<Record<string, unknown>>)[0]
    definition.authorization = {
      clientIdFrom: { configuration: "appId" },
      issuer: "https://issuer.test",
    }
    definition.configurationSchema = {
      type: "object",
      properties: { appId: { type: "string" } },
      required: ["appId"],
    }
    await expect(
      connectProvider({ providerId: "acme", scopes: [], configuration: { appId } })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(provider.authorize).not.toHaveBeenCalled()
  }
)

it("asks the Host configuration form and uses its selected method", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  provider.management = "host"
  const plugin = (await getPlugin("owner"))!
  const definition = (plugin.manifest.authProviders as Array<Record<string, unknown>>)[0]
  definition.authorization = {
    clientIdFrom: { configuration: "appId" },
    issuer: "https://issuer.test",
  }
  definition.configurationSchema = {
    type: "object",
    properties: { appId: { type: "string" } },
    required: ["appId"],
  }
  const dispose = subscribeConnectionPrompts(({ current }) => {
    if (current?.kind === "configure")
      resolveConnectionPrompt(current.id, {
        kind: "configured",
        method: "client-credentials",
        configuration: { appId: "client", issuer: "https://issuer.test" },
      })
  })
  try {
    await connectProvider({ providerId: "acme", scopes: [] })
    expect(provider.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "client", method: "client-credentials" }),
      expect.anything()
    )
    expect(openExternal).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it("binds Host form client selection to the attempt and connection", async () => {
  provider.management = "host"
  provider.describe = async (credentials) => ({
    issuer: "https://issuer.test",
    clientId: "second-client",
    principal: { id: "user", kind: "user" },
    accountLabel: "Account",
    scopes: credentials.scopes,
  })
  const ref = await connectProvider({
    providerId: "acme",
    scopes: [],
    configuration: { clientId: "second-client", issuer: "https://issuer.test" },
  })
  expect(provider.exchange).toHaveBeenCalledWith(
    expect.objectContaining({ clientId: "second-client", issuer: "https://issuer.test" }),
    expect.anything()
  )
  expect(await getAuthConnection(ref)).toMatchObject({
    clientId: "second-client",
    issuer: "https://issuer.test",
  })
})

it("asks for client-secret re-entry when legacy ownership is ambiguous", async () => {
  provider.exchange = async () => {
    throw new PluginGatewayError({
      code: "NOT_FOUND",
      message: "client-secret-ambiguous",
      details: { reason: "client-secret-ambiguous" },
      api: "auth:exchange",
      pluginId: "owner",
      requestId: "request",
    })
  }
  await expect(connectProvider({ providerId: "acme", scopes: [] })).rejects.toMatchObject({
    code: "CLIENT_SECRET_REQUIRED",
    reason: "client-secret-reentry-required",
  })
})

it.each([null, 42, ""])(
  "refuses invalid Host client secret configuration %p",
  async (clientSecret) => {
    provider.management = "host"
    const plugin = (await getPlugin("owner"))!
    const manifest = plugin.manifest as { authProviders: Array<Record<string, unknown>> }
    manifest.authProviders[0].authorization = { clientId: "client", issuer: "https://issuer.test" }
    await expect(
      connectProvider({ providerId: "acme", scopes: [], configuration: { clientSecret } })
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      reason: "invalid-client-secret-configuration",
    })
    expect(provider.authorize).not.toHaveBeenCalled()
    expect(provider.exchange).not.toHaveBeenCalled()
  }
)

it.each(["https://foreign.test/authorize", "http://issuer.test/authorize", "javascript:alert(1)"])(
  "rejects unsafe authorization URL %s before opening",
  async (url) => {
    provider.authorize = jest.fn(async () => ({ url }))
    await expect(connectProvider({ providerId: "acme", scopes: [] })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    expect(openExternal).not.toHaveBeenCalled()
    expect(provider.exchange).not.toHaveBeenCalled()
  }
)

it.each(["cancel", "timeout"])(
  "rejects a late callback after %s and cancels its attempt",
  async (reason) => {
    jest.useFakeTimers()
    const controller = new AbortController()
    let opened!: () => void
    const opening = new Promise<void>((resolve) => {
      opened = resolve
    })
    jest.mocked(openExternal).mockImplementation(async () => {
      opened()
    })
    const pending = connectProvider({ providerId: "acme", scopes: [], signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({
      code: reason === "timeout" ? "TIMEOUT" : "CANCELLED",
    })
    await opening
    if (reason === "cancel") controller.abort()
    else await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)
    await rejected
    const state = jest.mocked(provider.authorize!).mock.calls[0][0].attemptId
    expect(await acceptCallback({ state, code: "late" }, "deep-link")).toBe(false)
    expect(await getDb().authAttempts.get(state)).toMatchObject({ outcome: "cancelled" })
    expect(provider.exchange).not.toHaveBeenCalled()
  }
)

it("adapts a legacy provider session into a connection", async () => {
  provider.describe = undefined
  jest.mocked(provider.createSession).mockResolvedValue({
    id: "legacy-session",
    accessToken: "legacy-secret",
    account: { id: "legacy-user", label: "Legacy" },
    scopes: ["read"],
  })
  const ref = await connectProvider({ providerId: "acme", scopes: ["read"] })
  expect(await getAuthConnection(ref)).toMatchObject({
    legacySessionId: "legacy-session",
    status: "connected",
  })
  expect(provider.exchange).not.toHaveBeenCalled()
})

it.each(["exchange", "describe"] as const)(
  "times out during %s and revokes a late result without storing it",
  async (stage) => {
    jest.useFakeTimers()
    let started!: () => void
    let resume!: () => void
    let revoked!: () => void
    const starting = new Promise<void>((resolve) => {
      started = resolve
    })
    const resuming = new Promise<void>((resolve) => {
      resume = resolve
    })
    const revoking = new Promise<void>((resolve) => {
      revoked = resolve
    })
    provider.revoke = jest.fn(async () => {
      revoked()
    })
    if (stage === "exchange") {
      const exchange = provider.exchange!
      provider.exchange = async (...args) => {
        started()
        await resuming
        return exchange(...args)
      }
    } else {
      const describe = provider.describe!
      provider.describe = async (...args) => {
        started()
        await resuming
        return describe(...args)
      }
    }
    const pending = connectProvider({ providerId: "acme", scopes: [] })
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" })
    await starting
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)
    await rejected
    resume()
    await revoking
    expect(await getDb().authConnections.count()).toBe(0)
  }
)

it("reconnects through the coordinator with the same ref and incremented credentials", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  const ref = await connectProvider({
    providerId: "acme",
    scopes: ["read"],
    method: "client-credentials",
  })
  expect(
    await connectProvider({
      providerId: "acme",
      scopes: ["read"],
      method: "client-credentials",
      reconnect: ref,
    })
  ).toBe(ref)
  expect(await getAuthConnection(ref)).toMatchObject({ revision: 1, credentialRevision: 2 })
  await getConnectionManager().disconnect(ref)
  const next = await connectProvider({
    providerId: "acme",
    scopes: ["read"],
    method: "client-credentials",
    reconnect: ref,
  })
  expect(next).not.toBe(ref)
  expect(await getAuthConnection(next)).toMatchObject({ revision: 1, credentialRevision: 1 })
})

it("returns the committed result if cancellation arrives after publication starts", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  let started!: () => void
  let resume!: () => void
  const publishing = new Promise<void>((resolve) => {
    started = resolve
  })
  const resuming = new Promise<void>((resolve) => {
    resume = resolve
  })
  const manager = new AuthConnectionManager({
    store: {
      get: getAuthConnection,
      find: async (key) => getDb().authConnections.where("identityKey").equals(key).first(),
      list: async () => getDb().authConnections.toArray(),
      put: async (row) => {
        started()
        await resuming
        await getDb().authConnections.put(row)
      },
    },
  })
  jest.mocked(getConnectionManager).mockReturnValueOnce(manager)
  const controller = new AbortController()
  const pending = connectProvider({
    providerId: "acme",
    scopes: ["read"],
    method: "client-credentials",
    signal: controller.signal,
  })
  await publishing
  controller.abort()
  resume()
  const ref = await pending
  expect(await getAuthConnection(ref)).toMatchObject({ status: "connected" })
})

it("rejects unsupported device-code and sanitizes provider failures", async () => {
  await expect(
    connectProvider({ providerId: "acme", scopes: [], method: "device-code" })
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED" })
  provider.authorize = async () => {
    throw new Error("private-token-DO-NOT-EXPOSE")
  }
  await expect(connectProvider({ providerId: "acme", scopes: [] })).rejects.toMatchObject({
    name: "AuthConnectError",
    code: "INTERNAL",
    message: expect.not.stringContaining("private-token"),
  })
})

it("stores an API key through the connection coordinator without exchange or refresh", async () => {
  // Pin the coordinator to this test's newly installed secret backend.
  jest.mocked(getConnectionManager).mockReturnValue(new AuthConnectionManager())
  const plugin = (await getPlugin("owner"))!
  ;(plugin.manifest.authProviders as Array<Record<string, unknown>>)[0].methods = ["api-key"]
  provider.exchange = undefined
  provider.refresh = jest.fn()
  const ref = await connectProvider({
    providerId: "acme",
    scopes: ["read"],
    method: "api-key",
    configuration: { apiKey: "host-key" },
  })
  expect(provider.describe).toHaveBeenCalledWith({ accessToken: "host-key", scopes: ["read"] })
  expect(
    await getConnectionManager().getCredentials(ref, {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
    })
  ).toEqual({
    accessToken: "host-key",
    scopes: ["read"],
  })
  expect(provider.refresh).not.toHaveBeenCalled()
  expect(openExternal).not.toHaveBeenCalled()
  expect(await getAuthConnection(ref)).toMatchObject({ status: "connected", credentialRevision: 1 })
  expect((await new ConnectionCredentialStore().read(ref)).authMethod).toBe("api-key")
  expect(
    await connectProvider({
      providerId: "acme",
      scopes: ["read"],
      method: "api-key",
      reconnect: ref,
      configuration: { apiKey: "replacement-key" },
    })
  ).toBe(ref)
  expect(await getAuthConnection(ref)).toMatchObject({ credentialRevision: 2 })
  expect(provider.refresh).not.toHaveBeenCalled()
})

it("never revokes a user-supplied API key when connecting fails", async () => {
  jest.mocked(getConnectionManager).mockReturnValue(new AuthConnectionManager())
  const plugin = (await getPlugin("owner"))!
  ;(plugin.manifest.authProviders as Array<Record<string, unknown>>)[0].methods = ["api-key"]
  provider.exchange = undefined
  const ref = await connectProvider({
    providerId: "acme",
    scopes: [],
    method: "api-key",
    configuration: { apiKey: "first-key" },
  })
  // A key for another account reaches identity checks and is rejected there;
  // that key belongs to the user and may be live elsewhere.
  provider.describe = jest.fn(async (credentials) => ({
    issuer: "https://issuer.test",
    clientId: "client",
    principal: { id: "someone-else", kind: "user" as const },
    accountLabel: "Other",
    scopes: credentials.scopes,
  }))
  await expect(
    connectProvider({
      providerId: "acme",
      scopes: [],
      method: "api-key",
      reconnect: ref,
      configuration: { apiKey: "other-account-key" },
    })
  ).rejects.toMatchObject({ name: "ReconnectIdentityMismatch" })
  expect(provider.describe).toHaveBeenCalled()
  expect(provider.revoke).not.toHaveBeenCalled()
  expect(
    await getConnectionManager().getCredentials(ref, {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
    })
  ).toMatchObject({
    accessToken: "first-key",
  })
})

it("does not let a confidential token endpoint block API-key sign-in in the browser", async () => {
  jest.mocked(getConnectionManager).mockReturnValue(new AuthConnectionManager())
  jest.mocked(detectPlatform).mockReturnValue("web")
  const plugin = (await getPlugin("owner"))!
  const definition = (plugin.manifest.authProviders as Array<Record<string, unknown>>)[0]
  definition.methods = ["oauth-pkce", "api-key"]
  definition.tokenEndpoints = [{ url: "https://auth.example.com/token", clientSecret: "form" }]
  provider.exchange = undefined
  const ref = await connectProvider({
    providerId: "acme",
    scopes: [],
    method: "api-key",
    configuration: { apiKey: "browser-key" },
  })
  expect(
    await getConnectionManager().getCredentials(ref, {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
    })
  ).toMatchObject({
    accessToken: "browser-key",
  })
  await expect(
    connectProvider({ providerId: "acme", scopes: [], method: "oauth-pkce" })
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED", reason: "confidential-exchange-unavailable" })
})

it("runs confidential authorization-code flow without a PKCE verifier", async () => {
  jest.mocked(detectPlatform).mockReturnValue("tauri")
  const plugin = (await getPlugin("owner"))!
  ;(plugin.manifest.authProviders as Array<Record<string, unknown>>)[0].methods = [
    "oauth-confidential",
  ]
  await connectProvider({ providerId: "acme", scopes: [], method: "oauth-confidential" })
  expect(provider.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "oauth-confidential",
      codeVerifier: undefined,
      codeChallenge: undefined,
      redirectUri: "cognia://auth/callback",
    })
  )
  expect(provider.exchange).toHaveBeenCalledWith(
    expect.objectContaining({ method: "oauth-confidential" }),
    expect.objectContaining({ code: "code" })
  )
  expect(jest.mocked(provider.exchange!).mock.calls[0][0]).not.toHaveProperty("codeVerifier")
})

it("uses the native callback on mobile", async () => {
  jest.mocked(detectPlatform).mockReturnValue("mobile")
  await connectProvider({ providerId: "acme", scopes: [] })
  expect(provider.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ redirectUri: "cognia://auth/callback" })
  )
})

it("refuses headless PKCE with a recovery reason before authorization", async () => {
  jest.mocked(detectPlatform).mockReturnValue("headless")
  await expect(
    connectProvider({ providerId: "acme", scopes: [], method: "oauth-pkce" })
  ).rejects.toMatchObject({
    code: "NOT_SUPPORTED",
    reason: "no-interactive-browser",
    details: { recovery: ["use-another-method"] },
  })
  expect(provider.authorize).not.toHaveBeenCalled()
})

it("refuses unsupported methods before invoking legacy migration", async () => {
  provider.management = "host"
  const migrate = jest.fn(async () => {})
  const dispose = registerLegacySessionMigration("owner", provider.id, {
    migrate,
    aliases: async () => new Map(),
  })
  try {
    await expect(
      connectProvider({ providerId: "acme", scopes: [], method: "client-credentials" })
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      reason: "confidential-exchange-unavailable",
      details: { recovery: ["pair-with-desktop", "use-always-on-host"] },
    })
    expect(migrate).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

it("maps a locked persistent credential store to unlock-vault without describing the API key", async () => {
  const plugin = (await getPlugin("owner"))!
  ;(plugin.manifest.authProviders as Array<Record<string, unknown>>)[0].methods = ["api-key"]
  setHostAuthBackend({
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
    storeFor: () => ({
      load: async () => null,
      save: async () => {},
      delete: async () => {},
      isPersistent: () => false,
    }),
  })
  await expect(
    connectProvider({
      providerId: "acme",
      method: "api-key",
      scopes: [],
      configuration: { apiKey: "secret" },
    })
  ).rejects.toMatchObject({
    code: "UNAVAILABLE",
    reason: "non-persistent-until-vault-unlock",
    details: { recovery: ["unlock-vault"] },
  })
  expect(provider.describe).not.toHaveBeenCalled()
})

it("preserves a client-secret gateway refusal as a recoverable connect error", async () => {
  provider.exchange = jest.fn(async () => {
    throw new PluginGatewayError({
      code: "NOT_SUPPORTED",
      message: "trusted Host required",
      details: {
        reason: "confidential-exchange-unavailable",
        recovery: ["pair-with-desktop", "use-always-on-host"],
      },
      pluginId: "owner",
      api: "auth:exchange",
      requestId: "request",
    })
  })
  await expect(connectProvider({ providerId: "acme", scopes: [] })).rejects.toMatchObject({
    code: "NOT_SUPPORTED",
    reason: "confidential-exchange-unavailable",
    details: { recovery: ["pair-with-desktop", "use-always-on-host"] },
  })
})
