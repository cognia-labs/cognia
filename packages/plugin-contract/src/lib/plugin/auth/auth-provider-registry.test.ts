import {
  __makeSession,
  __resetAuthRegistryForTesting,
  getProvider,
  getSession,
  hydrateFromSecrets,
  listProviders,
  onDidChangeSessions,
  registerAuthenticationProvider,
  removeSession,
  setSecretsAdapter,
  unregisterAuthenticationProvider,
  unregisterProvidersByPlugin,
  waitForProvider,
  type AuthSession,
  type AuthSessionOptions,
  type AuthenticationProvider,
  type SecretsAdapter,
} from "./auth-provider-registry"

function makeMemorySecretsAdapter(): SecretsAdapter {
  const store = new Map<string, string>()
  return {
    async get(key) {
      return store.get(key)
    },
    async set(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

function makeProvider(overrides: Partial<AuthenticationProvider> = {}): AuthenticationProvider {
  const sessions: AuthSession[] = []
  const provider: AuthenticationProvider = {
    id: "github",
    label: "GitHub",
    pluginId: "vscode.github-authentication",
    getSessions: jest.fn(
      async (scopes: readonly string[] | undefined, _options: AuthSessionOptions) => {
        if (!scopes) return sessions
        return sessions.filter((s) => scopes.every((scope) => s.scopes.includes(scope)))
      }
    ),
    createSession: jest.fn(async (scopes: readonly string[]) => {
      const session = __makeSession({
        accessToken: "gho_test_token",
        account: { id: "1", label: "octocat" },
        scopes,
      })
      sessions.push(session)
      return session
    }),
    removeSession: jest.fn(async (sessionId: string) => {
      const idx = sessions.findIndex((s) => s.id === sessionId)
      if (idx >= 0) sessions.splice(idx, 1)
    }),
    ...overrides,
  }
  return provider
}

describe("auth provider registry", () => {
  beforeEach(() => {
    __resetAuthRegistryForTesting()
  })

  describe("provider registration", () => {
    it("retains optional Host-coordinated callbacks without invoking them on registration", () => {
      const credentials = { accessToken: "t", scopes: ["read"] }
      const provider = makeProvider({
        exchange: jest.fn(async () => credentials),
        refresh: jest.fn(async () => credentials),
        revoke: jest.fn(async () => {}),
        describe: jest.fn(async () => ({
          issuer: "https://auth.example",
          clientId: "acme-client",
          principal: { id: "u", kind: "user" as const },
          accountLabel: "Acme user",
          scopes: ["read"],
        })),
      })
      const dispose = registerAuthenticationProvider(provider)
      expect(getProvider(provider.id)).toBe(provider)
      for (const key of ["exchange", "refresh", "revoke", "describe"] as const) {
        expect(provider[key]).not.toHaveBeenCalled()
      }
      dispose()
    })

    it("registers and lists a provider", () => {
      const dispose = registerAuthenticationProvider(makeProvider())
      expect(listProviders().map((p) => p.id)).toEqual(["github"])
      expect(getProvider("github")?.label).toBe("GitHub")
      dispose()
      expect(getProvider("github")).toBeUndefined()
    })

    it("warns on duplicate id and overrides", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerAuthenticationProvider(makeProvider({ id: "x", label: "A", pluginId: "p1" }))
        registerAuthenticationProvider(makeProvider({ id: "x", label: "B", pluginId: "p2" }))
        expect(getProvider("x")?.label).toBe("B")
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/replaced/))
      } finally {
        warn.mockRestore()
      }
    })

    it("bulk-unregisters providers by plugin id", () => {
      registerAuthenticationProvider(makeProvider({ id: "a", pluginId: "p1" }))
      registerAuthenticationProvider(makeProvider({ id: "b", pluginId: "p1" }))
      registerAuthenticationProvider(makeProvider({ id: "c", pluginId: "p2" }))
      const removed = unregisterProvidersByPlugin("p1")
      expect(removed).toBe(2)
      expect(listProviders().map((p) => p.id)).toEqual(["c"])
    })

    it("idempotent unregister", () => {
      registerAuthenticationProvider(makeProvider({ id: "x" }))
      unregisterAuthenticationProvider("x")
      expect(() => unregisterAuthenticationProvider("x")).not.toThrow()
    })
  })

  describe("getSession", () => {
    it("throws when the provider is unknown", async () => {
      await expect(getSession("nope", ["scope"])).rejects.toThrow(/No auth provider/)
    })

    it("returns undefined when neither createIfNone nor an existing session matches", async () => {
      registerAuthenticationProvider(makeProvider())
      const session = await getSession("github", ["repo"])
      expect(session).toBeUndefined()
    })

    it("returns an existing session when one matches the scopes", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      // Seed an existing session by triggering createIfNone first.
      await getSession("github", ["repo"], { createIfNone: true })
      const existing = await getSession("github", ["repo"])
      expect(existing).toBeDefined()
      expect(existing?.scopes).toContain("repo")
    })

    it("creates a new session when createIfNone is true and none exists", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      const session = await getSession("github", ["read:user"], { createIfNone: true })
      expect(session).toBeDefined()
      expect(provider.createSession).toHaveBeenCalledTimes(1)
    })

    it("passes host-owned configuration to interactive session creation", async () => {
      const provider = makeProvider({ id: "configured-provider" })
      registerAuthenticationProvider(provider)

      await getSession("configured-provider", ["repo"], {
        createIfNone: true,
        configuration: { installationId: "42" },
      })

      expect(provider.createSession).toHaveBeenCalledWith(["repo"], {
        createIfNone: true,
        configuration: { installationId: "42" },
      })
    })

    it("creates a fresh session when forceNewSession is true even if one exists", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      await getSession("github", ["x"], { createIfNone: true })
      const session2 = await getSession("github", ["x"], { forceNewSession: true })
      expect(session2).toBeDefined()
      expect(provider.createSession).toHaveBeenCalledTimes(2)
    })
  })

  describe("removeSession", () => {
    it("calls provider.removeSession and emits a removed event", async () => {
      const provider = makeProvider()
      registerAuthenticationProvider(provider)
      const adapter = makeMemorySecretsAdapter()
      setSecretsAdapter(adapter)
      const session = await getSession("github", ["x"], { createIfNone: true })

      const events: AuthSession[][] = []
      onDidChangeSessions((e) => events.push(e.removed))
      await removeSession("github", session!.id)
      await new Promise((r) => setTimeout(r, 0))
      expect(provider.removeSession).toHaveBeenCalledWith(session!.id)
      expect(events.flat().map((s) => s.id)).toContain(session!.id)
    })

    it("is a silent no-op for an unknown provider", async () => {
      await expect(removeSession("nope", "sid")).resolves.toBeUndefined()
    })
  })

  describe("deprecated inert persistence", () => {
    it("never calls the legacy adapter for create, hydrate or remove", async () => {
      const adapter = { get: jest.fn(), set: jest.fn(), delete: jest.fn(), list: jest.fn() }
      setSecretsAdapter(adapter)
      const session = __makeSession({
        accessToken: "secret",
        account: { id: "u", label: "U" },
        scopes: [],
      })
      registerAuthenticationProvider(
        makeProvider({ getSessions: async () => [session], createSession: async () => session })
      )
      await getSession("github", [], { forceNewSession: true })
      expect(await hydrateFromSecrets()).toBe(0)
      await removeSession("github", session.id)
      for (const fn of Object.values(adapter)) expect(fn).not.toHaveBeenCalled()
    })
  })

  describe("listeners", () => {
    it("tags internal events with the provider while retaining the host session", async () => {
      registerAuthenticationProvider(makeProvider())
      const listener = jest.fn()
      onDidChangeSessions(listener)
      const session = await getSession("github", ["repo"], { createIfNone: true })
      expect(listener).toHaveBeenCalledWith({
        providerId: "github",
        added: [session],
        removed: [],
        changed: [],
      })
      expect(listener.mock.calls[0][0].added[0].accessToken).toBe("gho_test_token")
    })
    it("survives a listener that throws", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        registerAuthenticationProvider(makeProvider())
        onDidChangeSessions(() => {
          throw new Error("listener boom")
        })
        await getSession("github", ["x"], { createIfNone: true })
        await new Promise((r) => setTimeout(r, 0))
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})

describe("waitForProvider", () => {
  beforeEach(() => {
    __resetAuthRegistryForTesting()
  })

  it("answers at once for a registered provider", async () => {
    const provider = makeProvider()
    registerAuthenticationProvider(provider)
    await expect(waitForProvider(provider.id, 10)).resolves.toBe(provider)
  })

  it("answers when the provider is registered, for every waiter", async () => {
    const provider = makeProvider()
    const first = waitForProvider(provider.id, 1_000)
    const second = waitForProvider(provider.id, 1_000)
    registerAuthenticationProvider(provider)
    await expect(first).resolves.toBe(provider)
    await expect(second).resolves.toBe(provider)
  })

  it("gives up after the timeout", async () => {
    jest.useFakeTimers()
    try {
      const waiting = waitForProvider("never", 500)
      jest.advanceTimersByTime(500)
      await expect(waiting).resolves.toBeUndefined()
      // A late registration finds no one waiting.
      registerAuthenticationProvider(makeProvider({ id: "never" }))
      expect(getProvider("never")).toBeDefined()
    } finally {
      jest.useRealTimers()
    }
  })
})

it("a stale provider disposer cannot unregister its replacement", () => {
  __resetAuthRegistryForTesting()
  const first = registerAuthenticationProvider(makeProvider())
  const replacement = makeProvider()
  registerAuthenticationProvider(replacement)
  first()
  expect(getProvider(replacement.id)).toBe(replacement)
  __resetAuthRegistryForTesting()
})

it("exports a structured refresh rejection without depending on message text", async () => {
  const { AuthRefreshRejected } = await import("./auth-provider-registry")
  const failure = new AuthRefreshRejected("Vendor-specific description")
  expect((await import("../api/auth-api")).AuthRefreshRejected).toBe(AuthRefreshRejected)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).toMatchObject({
    name: "AuthRefreshRejected",
    code: "invalid_grant",
    message: "Vendor-specific description",
  })
})
