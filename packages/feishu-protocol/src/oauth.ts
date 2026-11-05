/**
 * Feishu authorization requests: the OAuth 2.0 authorize URL, the v2 token
 * endpoint (code exchange and refresh), the connected user's identity, and the
 * tenant access token for a bot.
 *
 * OAuth 2.0 flow (Feishu's current authorization-code spec):
 *  1. `buildLarkOAuthUrl` builds the authorize URL on the deployment's issuer
 *     with `client_id`, `response_type=code`, `scope`, `state` and a PKCE
 *     `code_challenge`.
 *  2. The user approves; Feishu redirects to `redirect_uri?code=...&state=...`.
 *  3. The caller verifies `state`, then `exchangeCodeForUserAccessToken` swaps
 *     the code (with `client_secret` and the PKCE `code_verifier`) for a user
 *     access token and refresh token at `authen/v2/oauth/token`.
 *  4. `refreshUserAccessToken` renews it. A `refresh_token` is only issued when
 *     `offline_access` is granted (see `LARK_SENDAS_SCOPES`).
 *  5. The token endpoint returns tokens only; `fetchLarkUserInfo` resolves who
 *     the user is.
 *
 * Every request goes through the caller's transport, and nothing is cached:
 * keeping tokens, refreshing them and publishing rotations is the credential
 * holder's job.
 */

import { larkDeployment, type FeishuBrand } from "./deployment"
import { CODE_CHALLENGE_METHOD } from "./pkce"
import { FEISHU_JSON_HEADERS, type FeishuTransport } from "./transport"

// ---------------------------------------------------------------------------
// Tenant access token
// ---------------------------------------------------------------------------

export interface TenantAccessToken {
  token: string
  /** Seconds the token stays valid (Feishu's default is 7200). */
  expiresInSec: number
}

interface TenantTokenResponse {
  code: number
  tenant_access_token?: string
  expire?: number
  msg?: string
}

/**
 * Request a tenant access token for an internal app
 * (`auth/v3/tenant_access_token/internal`). Throws when Feishu returns a
 * non-zero code.
 */
export async function requestTenantAccessToken(opts: {
  transport: FeishuTransport
  appId: string
  appSecret: string
  brand?: FeishuBrand
}): Promise<TenantAccessToken> {
  const resp = await opts.transport({
    url: `${larkDeployment(opts.brand).apiBase}/open-apis/auth/v3/tenant_access_token/internal`,
    method: "POST",
    headers: { ...FEISHU_JSON_HEADERS },
    body: JSON.stringify({ app_id: opts.appId, app_secret: opts.appSecret }),
  })
  const parsed = JSON.parse(resp.body) as TenantTokenResponse
  if (parsed.code !== 0 || !parsed.tenant_access_token) {
    throw new Error(
      `Lark tenant_access_token failed: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`
    )
  }
  return { token: parsed.tenant_access_token, expiresInSec: parsed.expire ?? 7200 }
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export interface LarkOAuthUrlInput {
  brand?: FeishuBrand
  /** The app's App ID — sent as the OAuth 2.0 `client_id`. */
  appId: string
  redirectUri: string
  state: string
  /** Space-separated scopes (e.g. `LARK_SENDAS_SCOPES`). */
  scope?: string
  /** PKCE challenge = base64url(SHA-256(verifier)); pairs with S256. */
  codeChallenge?: string
}

/**
 * Build the OAuth 2.0 authorization URL. After the user approves, Feishu
 * redirects to `redirectUri?code=<code>&state=<state>`; the caller verifies
 * `state` on redirect.
 */
export function buildLarkOAuthUrl(input: LarkOAuthUrlInput): string {
  const params = new URLSearchParams()
  params.set("client_id", input.appId)
  params.set("response_type", "code")
  params.set("redirect_uri", input.redirectUri)
  params.set("state", input.state)
  if (input.scope) params.set("scope", input.scope)
  if (input.codeChallenge) {
    params.set("code_challenge", input.codeChallenge)
    params.set("code_challenge_method", CODE_CHALLENGE_METHOD)
  }
  return `${larkDeployment(input.brand).issuer}/open-apis/authen/v1/authorize?${params.toString()}`
}

// ---------------------------------------------------------------------------
// v2 token endpoint
// ---------------------------------------------------------------------------

/** Tokens returned by `authen/v2/oauth/token`. Identity comes from `fetchLarkUserInfo`. */
export interface LarkUserAccessTokenResult {
  accessToken: string
  refreshToken: string
  /** Seconds until `accessToken` expires (Feishu's default is 7200 s). */
  expiresInSec: number
  /** Seconds until `refreshToken` expires (Feishu's default is 31104000 s — 360 d). */
  refreshExpiresInSec: number
  tokenType: string
  scope?: string
}

/** Connected-user identity resolved from `fetchLarkUserInfo`. */
export interface LarkUserInfo {
  openId: string
  tenantKey?: string
  unionId?: string
  name?: string
  avatarUrl?: string
  email?: string
  enterpriseEmail?: string
}

/**
 * `authen/v2/oauth/token` response. OAuth 2.0-flat: tokens at the top level,
 * with a Feishu `code` (0 = success) and `error`/`error_description` on failure.
 */
interface LarkTokenV2Response {
  code?: number
  error?: string
  error_description?: string
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
}

interface LarkUserInfoResponse {
  code: number
  msg?: string
  data?: {
    open_id?: string
    tenant_key?: string
    union_id?: string
    name?: string
    avatar_url?: string
    email?: string
    enterprise_email?: string
  }
}

/** A failed exchange or refresh, with Feishu's OAuth `error` as `code` (e.g. `invalid_grant`). */
export class LarkOAuthError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string
  ) {
    super(message)
    this.name = "LarkOAuthError"
  }
}

/**
 * Parse and validate a v2 token response. Throws with Feishu's own
 * `error_description`/`error`/code when the exchange failed.
 */
function parseTokenV2Response(rawBody: string, context: string): LarkUserAccessTokenResult {
  const parsed = JSON.parse(rawBody) as LarkTokenV2Response
  if (
    (parsed.code !== undefined && parsed.code !== 0) ||
    !parsed.access_token ||
    !parsed.refresh_token
  ) {
    const detail =
      parsed.error_description ??
      parsed.error ??
      (parsed.code !== undefined ? `code=${parsed.code}` : "unknown")
    throw new LarkOAuthError(parsed.error, `Lark ${context} failed: ${detail}`)
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresInSec: parsed.expires_in ?? 7200,
    refreshExpiresInSec: parsed.refresh_token_expires_in ?? 31_104_000,
    tokenType: parsed.token_type ?? "Bearer",
    scope: parsed.scope,
  }
}

/**
 * Exchange the authorization `code` for a `user_access_token` and
 * `refresh_token` at the v2 token endpoint. `client_id` and `client_secret`
 * go in the JSON body (no tenant token); `redirect_uri` must match the one sent
 * to the authorize endpoint, and `code_verifier` the PKCE challenge.
 */
export async function exchangeCodeForUserAccessToken(opts: {
  transport: FeishuTransport
  brand?: FeishuBrand
  /** Authorization code from the redirect URL. */
  code: string
  appId: string
  appSecret: string
  /** Must match the redirect_uri sent to the authorize endpoint. */
  redirectUri: string
  /** PKCE verifier matching the challenge sent to authorize. */
  codeVerifier?: string
}): Promise<LarkUserAccessTokenResult> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: opts.appId,
    client_secret: opts.appSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  }
  if (opts.codeVerifier) body.code_verifier = opts.codeVerifier
  const resp = await opts.transport({
    url: `${larkDeployment(opts.brand).apiBase}/open-apis/authen/v2/oauth/token`,
    method: "POST",
    headers: { ...FEISHU_JSON_HEADERS },
    body: JSON.stringify(body),
  })
  return parseTokenV2Response(resp.body, "oauth/token access")
}

/**
 * Refresh a `user_access_token` with its `refresh_token`. Feishu may rotate the
 * refresh token; the caller must persist whatever comes back rather than reuse
 * the old one.
 */
export async function refreshUserAccessToken(opts: {
  transport: FeishuTransport
  brand?: FeishuBrand
  refreshToken: string
  appId: string
  appSecret: string
}): Promise<LarkUserAccessTokenResult> {
  const resp = await opts.transport({
    url: `${larkDeployment(opts.brand).apiBase}/open-apis/authen/v2/oauth/token`,
    method: "POST",
    headers: { ...FEISHU_JSON_HEADERS },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: opts.appId,
      client_secret: opts.appSecret,
      refresh_token: opts.refreshToken,
    }),
  })
  return parseTokenV2Response(resp.body, "oauth/token refresh")
}

/**
 * Resolve the connected user's identity from a `user_access_token` via
 * `authen/v1/user_info`. Sensitive fields (email, enterprise_email) are only
 * present when the app was granted the matching scope.
 */
export async function fetchLarkUserInfo(opts: {
  transport: FeishuTransport
  accessToken: string
  brand?: FeishuBrand
}): Promise<LarkUserInfo> {
  const resp = await opts.transport({
    url: `${larkDeployment(opts.brand).apiBase}/open-apis/authen/v1/user_info`,
    method: "GET",
    headers: { ...FEISHU_JSON_HEADERS, Authorization: `Bearer ${opts.accessToken}` },
  })
  const parsed = JSON.parse(resp.body) as LarkUserInfoResponse
  if (parsed.code !== 0 || !parsed.data) {
    throw new Error(`Lark user_info failed: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`)
  }
  const d = parsed.data
  return {
    openId: d.open_id ?? "",
    tenantKey: d.tenant_key,
    unionId: d.union_id,
    name: d.name,
    avatarUrl: d.avatar_url,
    email: d.email,
    enterpriseEmail: d.enterprise_email,
  }
}
