import {
  AuthRefreshRejected,
  defineAuthProvider,
  type AuthCredentialSet,
  type PluginContext,
} from "@cognia/plugin-sdk"

export const FEISHU_PROVIDER_ID = "feishu-user-oauth"
export const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"

export class FeishuAuthError extends Error {
  constructor(
    readonly reason: string,
    readonly code?: number | string
  ) {
    super(`Feishu authentication failed (${reason}).`)
    this.name = "FeishuAuthError"
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FeishuAuthError("invalid-response")
  return value as Record<string, unknown>
}

/** Matches the built-in Lark issuer identity without importing Host implementation code. */
function deployment(issuer: string) {
  if (!["https://accounts.feishu.cn", "https://accounts.larksuite.com"].includes(issuer))
    throw new FeishuAuthError("invalid-issuer")
  return { issuer, apiBase: issuer.replace("https://accounts.", "https://open.") }
}

/** Only Host-coordinated callbacks see tokens. No storage, callbacks or refresh scheduler lives here. */
export function createFeishuAuthProvider(
  ctx: Pick<PluginContext, "auth" | "network">,
  options: { now?: () => number } = {}
) {
  const now = options.now ?? Date.now
  async function exchange(
    binding: { clientId: string; issuer: string },
    kind: "user" | "bot",
    params: Record<string, string>,
    scopes: string[]
  ): Promise<AuthCredentialSet> {
    const { apiBase, issuer } = deployment(binding.issuer)
    const response = await ctx.auth.exchangeConfidential({
      providerId: FEISHU_PROVIDER_ID,
      tokenUrl: `${apiBase}${kind === "bot" ? "/open-apis/auth/v3/tenant_access_token/internal" : "/open-apis/authen/v2/oauth/token"}`,
      clientId: binding.clientId,
      issuer,
      placement: "json",
      params,
    })
    const body = object(response.body)
    if (body.error === "invalid_grant") throw new AuthRefreshRejected()
    if (body.error || (body.code !== undefined && body.code !== 0))
      throw new FeishuAuthError(
        "token-rejected",
        typeof body.code === "number" ? body.code : undefined
      )
    if (response.status < 200 || response.status >= 300)
      throw new FeishuAuthError("token-http", response.status)
    const accessToken = kind === "bot" ? body.tenant_access_token : body.access_token
    const expiresIn = kind === "bot" ? body.expire : body.expires_in
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      typeof expiresIn !== "number" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0 ||
      (kind === "user" &&
        (typeof body.scope !== "string" ||
          typeof body.refresh_token !== "string" ||
          !body.refresh_token))
    )
      throw new FeishuAuthError("invalid-token-response")
    const granted =
      kind === "user"
        ? [...new Set((body.scope as string).split(/\s+/).filter(Boolean))].sort()
        : [...scopes]
    if (!scopes.every((scope) => granted.includes(scope)))
      throw new FeishuAuthError("missing-granted-scopes")
    return {
      accessToken,
      ...(kind === "user" ? { refreshToken: body.refresh_token as string } : {}),
      expiresAt: new Date(now() + expiresIn * 1000).toISOString(),
      scopes: granted,
      // Public binding, kept with credentials in the Host, lets describe remain stateless.
      extra: { clientId: binding.clientId, issuer, principalKind: kind },
    }
  }

  return defineAuthProvider({
    management: "host",
    id: FEISHU_PROVIDER_ID,
    label: "Feishu user OAuth",
    async authorize(attempt) {
      deployment(attempt.issuer)
      if (attempt.method !== "oauth-pkce" || !attempt.redirectUri || !attempt.codeChallenge)
        throw new FeishuAuthError("pkce-attempt-required")
      const url = new URL(`${attempt.issuer}/open-apis/authen/v1/authorize`)
      url.search = new URLSearchParams({
        client_id: attempt.clientId,
        response_type: "code",
        redirect_uri: attempt.redirectUri,
        state: attempt.attemptId,
        code_challenge: attempt.codeChallenge,
        code_challenge_method: "S256",
        scope: [...new Set([...attempt.scopes, "offline_access"])].join(" "),
      }).toString()
      return { url: url.href }
    },
    async exchange(attempt, callback) {
      if (attempt.method === "client-credentials")
        return exchange(attempt, "bot", {}, attempt.scopes)
      if (
        attempt.method !== "oauth-pkce" ||
        !callback.code ||
        !attempt.codeVerifier ||
        !attempt.redirectUri
      )
        throw new FeishuAuthError("accepted-pkce-callback-required")
      return exchange(
        attempt,
        "user",
        {
          grant_type: "authorization_code",
          code: callback.code,
          code_verifier: attempt.codeVerifier,
          redirect_uri: attempt.redirectUri,
        },
        [...new Set([...attempt.scopes, "offline_access"])]
      )
    },
    async refresh(lineage) {
      lineage.signal?.throwIfAborted()
      const kind = lineage.identity.principal.kind
      if (kind !== "bot" && (kind !== "user" || !lineage.credentials.refreshToken))
        throw new AuthRefreshRejected()
      const tokens = await exchange(
        lineage.identity,
        kind,
        kind === "bot"
          ? {}
          : {
              grant_type: "refresh_token",
              refresh_token: lineage.credentials.refreshToken!,
            },
        lineage.credentials.scopes
      )
      lineage.signal?.throwIfAborted()
      return tokens
    },
    async describe(tokens) {
      const clientId = tokens.extra?.clientId
      const issuer = tokens.extra?.issuer
      const kind = tokens.extra?.principalKind
      if (!clientId || !issuer || (kind !== "user" && kind !== "bot"))
        throw new FeishuAuthError("identity-binding-missing")
      const { apiBase } = deployment(issuer)
      const response = await ctx.network.get<unknown>(
        `${apiBase}${kind === "bot" ? "/open-apis/tenant/v2/tenant/query" : "/open-apis/authen/v1/user_info"}`,
        {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }
      )
      if (kind === "bot" && [403, 404].includes(response.status))
        throw new FeishuAuthError("tenant-scope-required", "AUTH_TENANT_SCOPE_REQUIRED")
      const envelope = object(response.data)
      if (kind === "bot" && [1184001, 1184000].includes(Number(envelope.code)))
        throw new FeishuAuthError("tenant-scope-required", "AUTH_TENANT_SCOPE_REQUIRED")
      if (!response.ok || envelope.code !== 0) throw new FeishuAuthError("identity-unavailable")
      const data = object(envelope.data)
      const identity = kind === "bot" ? object(data.tenant) : data
      if (
        typeof identity.tenant_key !== "string" ||
        !identity.tenant_key ||
        (kind === "user" && (typeof identity.open_id !== "string" || !identity.open_id)) ||
        typeof identity.name !== "string" ||
        !identity.name
      )
        throw new FeishuAuthError("identity-unavailable")
      return {
        clientId,
        issuer,
        principal: { id: kind === "bot" ? clientId : (identity.open_id as string), kind },
        tenantId: identity.tenant_key,
        ...(kind === "bot" ? { tenantLabel: identity.name } : {}),
        accountLabel: identity.name,
        scopes: [...tokens.scopes],
      }
    },
    // Feishu has no generic revocation endpoint. The Host writes a local tombstone.
  })
}
