import type { PluginAuthProvider, PluginContext } from "@cognia/plugin-sdk"

export const FEISHU_PROVIDER_ID = "feishu-user-oauth"
export const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info"
const RECORD_PREFIX = "oauth-session:"
const STATE_PREFIX = "cognia-plugin:feishu-auth:"
type Session = Awaited<ReturnType<PluginAuthProvider["createSession"]>>
type SessionOptions = Parameters<PluginAuthProvider["createSession"]>[1]

interface Configuration {
  clientId: string
  clientSecret: string
  redirectUri: string
}

interface SessionRecord {
  version: 1
  session: Session
  configuration: Configuration
  refreshToken: string
  expiresAt: number
  refreshExpiresAt: number
}

interface TokenResponse extends Record<string, unknown> {
  access_token: string
  refresh_token: string
  expires_in: number
  refresh_token_expires_in: number
  scope: string
}

export class FeishuAuthError extends Error {
  constructor(
    public readonly reason: string,
    public readonly code?: number
  ) {
    super(`Feishu authentication failed (${reason}${code === undefined ? "" : `: ${code}`}).`)
    this.name = "FeishuAuthError"
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuAuthError("invalid-response")
  }
  return value as Record<string, unknown>
}

function configurationOf(options: SessionOptions): Configuration {
  const input = options?.configuration ?? {}
  const required = (key: string) => {
    const value = input[key]
    if (typeof value !== "string" || !value.trim()) throw new FeishuAuthError(`missing-${key}`)
    return value.trim()
  }
  const config = {
    clientId: required("clientId"),
    clientSecret: required("clientSecret"),
    redirectUri: required("redirectUri"),
  }
  let redirect: URL
  try {
    redirect = new URL(config.redirectUri)
  } catch {
    throw new FeishuAuthError("invalid-redirect")
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
  if (
    (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && local)) ||
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    redirect.search ||
    !/\/plugin-auth\/callback\/?$/.test(redirect.pathname)
  ) {
    throw new FeishuAuthError("invalid-redirect")
  }
  return config
}

function tokenResponse(value: unknown): TokenResponse {
  const data = object(value)
  if (data.error || (data.code !== undefined && data.code !== 0)) {
    throw new FeishuAuthError(
      data.error === "invalid_grant" ? "invalid-grant" : "token-rejected",
      typeof data.code === "number" ? data.code : undefined
    )
  }
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    typeof data.refresh_token !== "string" ||
    !data.refresh_token ||
    typeof data.scope !== "string" ||
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0 ||
    typeof data.refresh_token_expires_in !== "number" ||
    !Number.isFinite(data.refresh_token_expires_in) ||
    data.refresh_token_expires_in <= 0
  ) {
    throw new FeishuAuthError("invalid-token-response")
  }
  return data as TokenResponse
}

function grantedScopes(raw: string): string[] {
  return [...new Set(raw.split(/\s+/).filter(Boolean))].sort()
}

/** The shared provider owns tokens; consumer Integrations hold only its session id. */
export function createFeishuAuthProvider(
  ctx: PluginContext,
  options: { now?: () => number; timeoutMs?: number; nonce?: () => string } = {}
): { provider: PluginAuthProvider; dispose: () => void } {
  const now = options.now ?? Date.now
  const controller = new AbortController()
  const refreshing = new Map<string, Promise<Session | undefined>>()
  const removed = new Set<string>()
  let authorizing = false
  const assertActive = () => {
    if (controller.signal.aborted || ctx.lifecycle.signal.aborted)
      throw new FeishuAuthError("cancelled")
  }
  const onLifecycleAbort = () => controller.abort()
  ctx.lifecycle.signal.addEventListener("abort", onLifecycleAbort, { once: true })

  async function requestToken(body: Record<string, unknown>): Promise<TokenResponse> {
    assertActive()
    const response = await ctx.network.post<unknown>(FEISHU_TOKEN_URL, body, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) {
      if (
        response.data &&
        typeof response.data === "object" &&
        (response.data as Record<string, unknown>).error === "invalid_grant"
      )
        throw new FeishuAuthError("invalid-grant")
      throw new FeishuAuthError("token-http", response.status)
    }
    return tokenResponse(response.data)
  }

  async function readRecord(id: string): Promise<SessionRecord | undefined> {
    const raw = await ctx.secrets.get(`${RECORD_PREFIX}${id}`)
    if (!raw) return undefined
    let value: Record<string, unknown>
    try {
      value = object(JSON.parse(raw))
    } catch {
      throw new FeishuAuthError("invalid-stored-session")
    }
    const record = value as unknown as SessionRecord
    if (
      record.version !== 1 ||
      record.session?.id !== id ||
      typeof record.session.accessToken !== "string" ||
      !record.session.account?.id ||
      !Number.isFinite(record.expiresAt) ||
      !Number.isFinite(record.refreshExpiresAt) ||
      typeof record.refreshToken !== "string" ||
      !record.configuration?.clientSecret ||
      !record.configuration.clientId ||
      !Array.isArray(record.session.scopes) ||
      !record.session.scopes.every((scope) => typeof scope === "string")
    ) {
      throw new FeishuAuthError("invalid-stored-session")
    }
    return record
  }

  async function save(record: SessionRecord): Promise<void> {
    assertActive()
    await ctx.secrets.store(`${RECORD_PREFIX}${record.session.id}`, JSON.stringify(record))
  }

  function refreshedRecord(previous: SessionRecord, token: TokenResponse): SessionRecord {
    return {
      ...previous,
      session: {
        ...previous.session,
        accessToken: token.access_token,
        scopes: grantedScopes(token.scope),
      },
      refreshToken: token.refresh_token,
      expiresAt: now() + token.expires_in * 1000,
      refreshExpiresAt: now() + token.refresh_token_expires_in * 1000,
    }
  }

  async function sessionFor(id: string): Promise<Session | undefined> {
    const pending = refreshing.get(id)
    if (pending) return pending
    const task = (async () => {
      if (removed.has(id)) return undefined
      const record = await readRecord(id)
      if (!record) return undefined
      if (record.expiresAt > now() + 60_000) return record.session
      if (record.refreshExpiresAt <= now()) return undefined
      let token: TokenResponse
      try {
        token = await requestToken({
          grant_type: "refresh_token",
          client_id: record.configuration.clientId,
          client_secret: record.configuration.clientSecret,
          refresh_token: record.refreshToken,
        })
      } catch (error) {
        if (error instanceof FeishuAuthError && error.reason === "invalid-grant") {
          await ctx.secrets.delete(`${RECORD_PREFIX}${id}`)
          return undefined
        }
        throw error
      }
      // Logout may finish while a refresh request is in flight; never resurrect it.
      if (removed.has(id) || !(await ctx.secrets.get(`${RECORD_PREFIX}${id}`))) return undefined
      const updated = refreshedRecord(record, token)
      await save(updated)
      return updated.session
    })()
    refreshing.set(id, task)
    try {
      return await task
    } finally {
      refreshing.delete(id)
    }
  }

  async function createSession(
    scopes: readonly string[],
    sessionOptions?: SessionOptions
  ): Promise<Session> {
    assertActive()
    if (authorizing) throw new FeishuAuthError("authorization-in-progress")
    const configuration = configurationOf(sessionOptions)
    const requested = [...new Set([...scopes, "offline_access"])].sort()
    const nonce = options.nonce?.() ?? crypto.randomUUID().replace(/-/g, "")
    if (!/^[a-f0-9]{32}$/.test(nonce)) throw new FeishuAuthError("invalid-state")
    const state = `${STATE_PREFIX}${nonce}`
    authorizing = true
    let detach: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbort: (() => void) | undefined
    let broadcast: BroadcastChannel | undefined
    let removeMessage: (() => void) | undefined
    let rejectCallback: ((error: Error) => void) | undefined
    const callback = new Promise<{ code: string; state: string }>((resolve, reject) => {
      rejectCallback = reject
      const receive = (payload: Record<string, unknown>) => {
        if (payload.state !== state) return
        if (typeof payload.error === "string" && payload.error)
          return reject(new FeishuAuthError("authorization-denied"))
        if (typeof payload.code === "string" && payload.code) resolve({ code: payload.code, state })
      }
      // Register before opening the browser: fast redirects cannot race the listener.
      detach = ctx.uri.registerHandler({
        id: "feishu-oauth",
        handle: (uri) => {
          if (uri.pluginId === "feishu-auth" && uri.path === "oauth-callback") receive(uri.query)
        },
      })
      if (
        typeof window !== "undefined" &&
        window.location.origin === new URL(configuration.redirectUri).origin
      ) {
        const onMessage = (event: MessageEvent) => {
          if (event.origin === window.location.origin && event.data?.__pluginAuth === true)
            receive(object(event.data))
        }
        window.addEventListener("message", onMessage)
        removeMessage = () => window.removeEventListener("message", onMessage)
        if (typeof BroadcastChannel !== "undefined") {
          broadcast = new BroadcastChannel("plugin-auth")
          broadcast.onmessage = (event) => {
            if (event.data?.__pluginAuth === true) receive(object(event.data))
          }
        }
      }
      const onAbort = () => reject(new FeishuAuthError("cancelled"))
      controller.signal.addEventListener("abort", onAbort, { once: true })
      removeAbort = () => controller.signal.removeEventListener("abort", onAbort)
      timer = setTimeout(
        () => reject(new FeishuAuthError("authorization-timeout")),
        options.timeoutMs ?? 5 * 60_000
      )
    })
    // Opening or exchanging may fail before waitForCode observes the promise.
    void callback.catch(() => undefined)
    try {
      // The Host sends the token request through this plugin's governed
      // ctx.network (network:fetch + networkAccess rules); Feishu's v2 token
      // endpoint takes a JSON body.
      const token = await ctx.auth
        .createPkceFlow({
          authorizeUrl: AUTHORIZE_URL,
          tokenUrl: FEISHU_TOKEN_URL,
          clientId: configuration.clientId,
          redirectUri: configuration.redirectUri,
          scopes: requested,
          state,
          extraTokenParams: { client_secret: configuration.clientSecret },
          tokenRequestEncoding: "json",
          signal: controller.signal,
          openUrl: (url) => ctx.shell.open(url),
          waitForCode: () => callback,
        })
        .catch((error: unknown) => {
          if (error instanceof FeishuAuthError) throw error
          if (controller.signal.aborted) throw new FeishuAuthError("cancelled")
          const status = /OAuth token exchange failed: (\d+)/.exec(
            error instanceof Error ? error.message : ""
          )?.[1]
          if (status) throw new FeishuAuthError("token-http", Number(status))
          throw error
        })
      assertActive()
      const raw = tokenResponse(token.raw)
      const granted = grantedScopes(raw.scope)
      if (!requested.every((scope) => granted.includes(scope)))
        throw new FeishuAuthError("missing-granted-scopes")
      const identity = await ctx.network.get<unknown>(USER_INFO_URL, {
        headers: { Authorization: `Bearer ${raw.access_token}` },
        signal: controller.signal,
      })
      const envelope = object(identity.data)
      const user = object(envelope.data)
      if (!identity.ok || envelope.code !== 0 || typeof user.open_id !== "string" || !user.open_id)
        throw new FeishuAuthError("identity-unavailable")
      const session: Session = {
        id: crypto.randomUUID(),
        accessToken: raw.access_token,
        account: {
          id: `${configuration.clientId}:${user.open_id}`,
          label: typeof user.name === "string" && user.name ? user.name : user.open_id,
        },
        scopes: granted,
      }
      await save({
        version: 1,
        session,
        configuration,
        refreshToken: raw.refresh_token,
        expiresAt: now() + raw.expires_in * 1000,
        refreshExpiresAt: now() + raw.refresh_token_expires_in * 1000,
      })
      return session
    } finally {
      rejectCallback?.(new FeishuAuthError("cancelled"))
      if (timer) clearTimeout(timer)
      detach?.()
      removeAbort?.()
      removeMessage?.()
      broadcast?.close()
      authorizing = false
    }
  }

  const provider: PluginAuthProvider = {
    id: FEISHU_PROVIDER_ID,
    label: "Feishu user OAuth",
    createSession,
    async getSessions(scopes) {
      assertActive()
      const keys = await ctx.secrets.keys()
      const sessions = await Promise.all(
        keys
          .filter((key) => key.startsWith(RECORD_PREFIX))
          .map((key) => sessionFor(key.slice(RECORD_PREFIX.length)))
      )
      return sessions.filter(
        (session): session is Session =>
          !!session && (!scopes || scopes.every((scope) => session.scopes.includes(scope)))
      )
    },
    // Feishu v2 has no documented generic token-revocation endpoint. This logs
    // out locally; users revoke application consent in Feishu's authorized apps.
    async removeSession(id) {
      removed.add(id)
      // A pending write must finish before deletion, otherwise it can restore
      // a credential after logout even though its network request was cancelled.
      await refreshing.get(id)?.catch(() => undefined)
      await ctx.secrets.delete(`${RECORD_PREFIX}${id}`)
    },
  }
  return {
    provider,
    dispose() {
      controller.abort()
      ctx.lifecycle.signal.removeEventListener("abort", onLifecycleAbort)
    },
  }
}
