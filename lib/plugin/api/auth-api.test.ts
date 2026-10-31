/** @jest-environment jsdom */

import { createAuthAPI, type PluginAuthProvider } from "./auth-api"
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
    waitForCode: async () => ({ code: "code", state: "state" }),
  }
}

function fakeProvider(over?: Partial<PluginAuthProvider>): PluginAuthProvider {
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

describe("createAuthAPI", () => {
  beforeEach(() => {
    localStorage.clear()
    resetPermissionGuard()
  })
  afterEach(() => __resetAuthRegistryForTesting())

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
          waitForCode: async () => {
            revoked.add(permission)
            return { code: "code", state: "state" }
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
