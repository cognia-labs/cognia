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
import { setHostAuthBackend } from "./connection-credentials"
import { withNamedLock } from "@/lib/locks/named-lock"

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

it("requires a declared manifest authorization binding for Host-managed providers", async () => {
  provider.management = "host"
  await expect(connectProvider({ providerId: "acme", scopes: [] })).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    reason: "authorization-configuration-missing",
  })
  expect(provider.exchange).not.toHaveBeenCalled()
})

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
