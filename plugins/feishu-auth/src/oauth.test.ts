import type { PluginContext } from "@cognia/plugin-sdk"
import { createFeishuAuthProvider, FEISHU_TOKEN_URL, FeishuAuthError } from "./oauth"

const NONCE = "0123456789abcdef0123456789abcdef"
const CONFIG = {
  clientId: "cli_test",
  clientSecret: "secret-value",
  redirectUri: "https://cognia.example/plugin-auth/callback",
}
const TOKEN = {
  code: 0,
  access_token: "u-initial",
  refresh_token: "r-initial",
  expires_in: 7200,
  refresh_token_expires_in: 86400,
  scope: "offline_access calendar:calendar:readonly",
}

function fixture() {
  const secrets = new Map<string, string>()
  const lifecycle = new AbortController()
  let uri: Parameters<PluginContext["uri"]["registerHandler"]>[0] | undefined
  const unregister = jest.fn()
  const post = jest.fn(
    async (
      _url: string,
      _body?: unknown,
      _options?: unknown
    ): Promise<{
      ok: boolean
      status: number
      statusText: string
      headers: Record<string, string>
      data: unknown
    }> => ({ ok: true, status: 200, statusText: "OK", headers: {}, data: { ...TOKEN } })
  )
  const get = jest.fn(async (_url: string, _options?: unknown) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    data: { code: 0, data: { open_id: "ou_one", name: "Person" } },
  }))
  const open = jest.fn(async () => {
    await uri?.handle({
      pluginId: "feishu-auth",
      path: "oauth-callback",
      query: { code: "auth-code", state: `cognia-plugin:feishu-auth:${NONCE}` },
      raw: "",
    })
  })
  const pkce = jest.fn(async (config: Parameters<PluginContext["auth"]["createPkceFlow"]>[0]) => {
    await config.openUrl("https://accounts.feishu.cn/authorize")
    const callback = await config.waitForCode({
      redirectUri: config.redirectUri,
      state: config.state!,
      codeVerifier: "verifier",
    })
    if (callback.state !== config.state) throw new Error("state mismatch")
    // Stand-in for the Host: plugins cannot supply a transport, and the token
    // request goes through the plugin's governed network with the flow's signal.
    if ("fetchImpl" in config) throw new Error("ctx.auth.createPkceFlow does not allow fetchImpl")
    expect(config.tokenRequestEncoding).toBe("json")
    expect(config.signal).toBeInstanceOf(AbortSignal)
    const response = await post(
      config.tokenUrl,
      {
        grant_type: "authorization_code",
        code: callback.code,
        code_verifier: "verifier",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        ...config.extraTokenParams,
      },
      { headers: { "Content-Type": "application/json" }, signal: config.signal }
    )
    if (!response.ok)
      throw new Error(`OAuth token exchange failed: ${response.status} ${response.statusText}`)
    const raw = response.data as Record<string, string>
    return { accessToken: raw.access_token, refreshToken: raw.refresh_token, raw }
  })
  const context = {
    lifecycle: { signal: lifecycle.signal },
    secrets: {
      get: jest.fn(async (key: string) => secrets.get(key) ?? null),
      store: jest.fn(async (key: string, value: string) => {
        secrets.set(key, value)
      }),
      delete: jest.fn(async (key: string) => {
        secrets.delete(key)
      }),
      keys: jest.fn(async () => [...secrets.keys()]),
    },
    auth: { createPkceFlow: pkce },
    shell: { open },
    network: { get, post },
    uri: {
      registerHandler: jest.fn((handler) => {
        uri = handler
        return unregister
      }),
    },
  } as unknown as PluginContext
  return {
    context,
    secrets,
    lifecycle,
    open,
    pkce,
    post,
    get,
    unregister,
    callback: (query: Record<string, string>, path = "oauth-callback") =>
      uri?.handle({ pluginId: "feishu-auth", path, query, raw: "" }),
  }
}

async function login(f: ReturnType<typeof fixture>, now = () => 1_000_000) {
  const auth = createFeishuAuthProvider(f.context, { now, nonce: () => NONCE, timeoutMs: 100 })
  const session = await auth.provider.createSession(["calendar:calendar:readonly"], {
    configuration: CONFIG,
  })
  return { ...auth, session }
}

describe("Feishu shared OAuth provider", () => {
  it("registers its callback before browser open, exchanges JSON and persists only through secrets", async () => {
    const f = fixture()
    const { provider, session, dispose } = await login(f)
    expect(f.context.uri.registerHandler).toHaveBeenCalled()
    expect(f.post).toHaveBeenCalledWith(
      FEISHU_TOKEN_URL,
      expect.objectContaining({
        code: "auth-code",
        code_verifier: "verifier",
        client_secret: CONFIG.clientSecret,
      }),
      expect.objectContaining({ headers: { "Content-Type": "application/json" } })
    )
    expect(session.account.id).toBe("cli_test:ou_one")
    expect(session.scopes).toEqual(["calendar:calendar:readonly", "offline_access"])
    expect(f.secrets.size).toBe(1)
    expect(f.unregister).toHaveBeenCalledTimes(1)
    expect(await provider.getSessions(["calendar:calendar:readonly"], { silent: true })).toEqual([
      session,
    ])
    expect(await provider.getSessions(["ungranted"], { silent: true })).toEqual([])
    dispose()
  })

  it("hydrates sessions after a provider restart", async () => {
    const f = fixture()
    const first = await login(f)
    first.dispose()
    const second = createFeishuAuthProvider(f.context, { now: () => 1_000_000 })
    expect(await second.provider.getSessions(undefined, { silent: true })).toEqual([first.session])
    second.dispose()
  })

  it("single-flights token refresh and persists rotating refresh tokens", async () => {
    const f = fixture()
    let time = 1_000_000
    const auth = await login(f, () => time)
    time += 7_190_000
    f.post.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { ...TOKEN, access_token: "u-new", refresh_token: "r-new" },
    })
    const [a, b] = await Promise.all([
      auth.provider.getSessions(undefined, { silent: true }),
      auth.provider.getSessions(undefined, { silent: true }),
    ])
    expect(a[0].accessToken).toBe("u-new")
    expect(b).toEqual(a)
    expect(f.post).toHaveBeenCalledTimes(2)
    expect(f.post.mock.calls[1][1]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "r-initial",
    })
    expect(JSON.parse([...f.secrets.values()][0]).refreshToken).toBe("r-new")
    auth.dispose()
  })

  it("does not invent granted scopes", async () => {
    const f = fixture()
    f.post.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { ...TOKEN, scope: "offline_access" },
    })
    await expect(login(f)).rejects.toMatchObject({ reason: "missing-granted-scopes" })
    expect(f.secrets.size).toBe(0)
  })

  it("rejects HTTP-200 token errors without leaking provider error descriptions", async () => {
    const f = fixture()
    f.post.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { code: 20001, error_description: "secret-user-content" },
    })
    await expect(login(f)).rejects.toMatchObject({ reason: "token-rejected", code: 20001 })
    expect(f.secrets.size).toBe(0)
  })

  it("maps a failed Host token exchange to token-http and stores nothing", async () => {
    const f = fixture()
    f.post.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: {},
      data: { error: "invalid_grant" },
    })
    await expect(login(f)).rejects.toMatchObject({ reason: "token-http", code: 400 })
    expect(f.secrets.size).toBe(0)
  })

  it("passes its cancellation signal to the Host token exchange", async () => {
    const f = fixture()
    await login(f)
    const [, , options] = f.post.mock.calls[0] as [string, unknown, { signal?: AbortSignal }]
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(f.pkce.mock.calls[0][0]).not.toHaveProperty("fetchImpl")
  })

  it("propagates consent denial and cleans listeners", async () => {
    const f = fixture()
    f.open.mockImplementation(async () => {
      await f.callback({ state: `cognia-plugin:feishu-auth:${NONCE}`, error: "access_denied" })
    })
    await expect(login(f)).rejects.toMatchObject({ reason: "authorization-denied" })
    expect(f.unregister).toHaveBeenCalledTimes(1)
    expect(f.post).not.toHaveBeenCalled()
  })

  it("ignores a callback for another state or callback path", async () => {
    const f = fixture()
    f.open.mockImplementation(async () => {
      await f.callback({ state: "wrong-state", code: "bad-code" })
      await f.callback({ state: `cognia-plugin:feishu-auth:${NONCE}`, code: "bad-code" }, "other")
    })
    const auth = createFeishuAuthProvider(f.context, { timeoutMs: 5, nonce: () => NONCE })
    await expect(auth.provider.createSession([], { configuration: CONFIG })).rejects.toMatchObject({
      reason: "authorization-timeout",
    })
    expect(f.post).not.toHaveBeenCalled()
    expect(f.unregister).toHaveBeenCalledTimes(1)
    auth.dispose()
  })

  it("cancels an outstanding authorization on disable", async () => {
    const f = fixture()
    f.open.mockImplementation(async () => {
      f.lifecycle.abort()
    })
    await expect(login(f)).rejects.toMatchObject({ reason: "cancelled" })
    expect(f.unregister).toHaveBeenCalledTimes(1)
  })

  it.each([
    "javascript:alert(1)",
    "http://remote.example/plugin-auth/callback",
    "https://user:pass@cognia.example/plugin-auth/callback",
    "https://cognia.example/plugin-auth/callback?next=bad",
    "https://cognia.example/other",
  ])("rejects an unsafe redirect %s", async (redirectUri) => {
    const f = fixture()
    const auth = createFeishuAuthProvider(f.context)
    await expect(
      auth.provider.createSession([], { configuration: { ...CONFIG, redirectUri } })
    ).rejects.toBeInstanceOf(FeishuAuthError)
    expect(f.open).not.toHaveBeenCalled()
    auth.dispose()
  })

  it("keeps multiple accounts isolated and logout does not remove sibling sessions", async () => {
    const f = fixture()
    const auth = await login(f)
    f.get.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { code: 0, data: { open_id: "ou_two", name: "Other" } },
    })
    const other = await auth.provider.createSession([], { configuration: CONFIG })
    await auth.provider.removeSession(auth.session.id)
    expect(await auth.provider.getSessions(undefined, { silent: true })).toEqual([other])
    auth.dispose()
  })

  it("does not return expired sessions when refresh authorization has expired", async () => {
    const f = fixture()
    let time = 1_000_000
    const auth = await login(f, () => time)
    time += 86_400_000
    expect(await auth.provider.getSessions(undefined, { silent: true })).toEqual([])
    expect(f.post).toHaveBeenCalledTimes(1)
    auth.dispose()
  })

  it("clears a definitively revoked refresh grant but retains credentials on transient failure", async () => {
    const f = fixture()
    let time = 1_000_000
    const auth = await login(f, () => time)
    time += 7_190_000
    f.post.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      headers: {},
      data: {},
    })
    await expect(auth.provider.getSessions(undefined, { silent: true })).rejects.toMatchObject({
      reason: "token-http",
    })
    expect(f.secrets.size).toBe(1)
    f.post.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: {},
      data: { error: "invalid_grant" },
    })
    expect(await auth.provider.getSessions(undefined, { silent: true })).toEqual([])
    expect(f.secrets.size).toBe(0)
    auth.dispose()
  })

  it("logout cannot be undone by an in-flight refresh", async () => {
    const f = fixture()
    let time = 1_000_000
    const auth = await login(f, () => time)
    time += 7_190_000
    let finish!: (value: Awaited<ReturnType<typeof f.post>>) => void
    f.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = auth.provider.getSessions(undefined, { silent: true })
    while (!finish) await Promise.resolve()
    const logout = auth.provider.removeSession(auth.session.id)
    finish({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { ...TOKEN, access_token: "u-new", refresh_token: "r-new" },
    })
    await logout
    expect(await pending).toEqual([])
    expect(f.secrets.size).toBe(0)
    auth.dispose()
  })
})
