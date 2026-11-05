/**
 * The host's Feishu/Lark credentials: the tenant access token cache, and the
 * connected user's access token with its refresh and rotation.
 *
 * The protocol itself (deployments, scopes, the authorize URL, the token and
 * user-info requests, their errors) is `@cognia/feishu-protocol`. This file
 * binds it to the desktop's HTTP bridge (`connectorsHttpRequest`; open.feishu.cn
 * sends no CORS headers) and to the host keyring, which hold what the protocol
 * library must not: tokens and state.
 */

import type { TenantTokenPurposeV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import {
  LarkOAuthError,
  exchangeCodeForUserAccessToken as requestCodeExchange,
  fetchLarkUserInfo as requestUserInfo,
  refreshUserAccessToken as requestTokenRefresh,
  requestTenantAccessToken,
  type FeishuBrand,
  type LarkUserAccessTokenResult,
  type LarkUserInfo,
} from "@cognia/feishu-protocol"
import { connectorsHttpRequest, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { throwIfRequestAborted, withRequestAbort } from "@/lib/network/request-abort"

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

interface TokenCacheEntry {
  token: string
  expiresAtMs: number
}

// In-memory cache keyed by "appId:appSecret"
const tokenCache = new Map<string, TokenCacheEntry>()

/**
 * Fetch and cache a Lark tenant access token.
 *
 * Re-uses a cached token if it has more than 60 s remaining.
 * Otherwise fetches a fresh one via POST to /auth/v3/tenant_access_token/internal.
 *
 * @param opts.appId      Lark App ID (cli_...)
 * @param opts.appSecret  Lark App Secret
 * @returns The tenant access token string
 * @throws Error if the Lark API returns a non-zero code
 */
export async function getTenantAccessToken(
  opts: { appId: string; appSecret: string; brand?: FeishuBrand },
  purpose: TenantTokenPurposeV1
): Promise<string> {
  void purpose
  const cacheKey = `${opts.brand ?? "feishu"}:${opts.appId}:${opts.appSecret}`
  const now = Date.now()

  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAtMs - now > 60_000) {
    return cached.token
  }

  const fresh = await requestTenantAccessToken({ ...opts, transport: connectorsHttpRequest })
  const entry: TokenCacheEntry = {
    token: fresh.token,
    expiresAtMs: now + fresh.expiresInSec * 1000,
  }
  tokenCache.set(cacheKey, entry)

  return entry.token
}

/** The only production entry to the token cache. Purpose is a label, never a cache key. */
export function getTenantToken(
  opts: { appId: string; appSecret: string; brand?: FeishuBrand },
  purpose: TenantTokenPurposeV1
): Promise<string> {
  // Deliberately no policy, logging, or purpose-specific credential selection.
  return getTenantAccessToken(opts, purpose)
}

/**
 * Clear the token cache entry for a given app.
 *
 * Useful in tests or when credentials are rotated.
 */
export function clearTokenCache(appId: string, appSecret: string): void {
  for (const brand of ["feishu", "lark"]) tokenCache.delete(`${brand}:${appId}:${appSecret}`)
}

// ---------------------------------------------------------------------------
// OAuth requests over the host transport
// ---------------------------------------------------------------------------

/**
 * Exchange the authorization `code` for a user token pair. The caller
 * (`oauth-handler.ts`) stores the pair in the host keyring.
 */
export function exchangeCodeForUserAccessToken(opts: {
  brand?: FeishuBrand
  code: string
  appId: string
  appSecret: string
  redirectUri: string
  codeVerifier?: string
}): Promise<LarkUserAccessTokenResult> {
  return requestCodeExchange({ ...opts, transport: connectorsHttpRequest })
}

/** Refresh a user access token; the caller must persist the rotated pair. */
export function refreshUserAccessToken(opts: {
  brand?: FeishuBrand
  refreshToken: string
  appId: string
  appSecret: string
}): Promise<LarkUserAccessTokenResult> {
  return requestTokenRefresh({ ...opts, transport: connectorsHttpRequest })
}

/** Resolve the connected user's identity for the UI ("Connected as Alice"). */
export function fetchLarkUserInfo(accessToken: string, brand?: FeishuBrand): Promise<LarkUserInfo> {
  return requestUserInfo({ accessToken, brand, transport: connectorsHttpRequest })
}

// ---------------------------------------------------------------------------
// User access token — send-as-user path (ADR-0009 v41 / A4 completion)
//
// `oauth-handler.ts` persists `user_token` + `user_refresh_token` in the
// keyring after the OAuth exchange. Until now nothing read them. These helpers
// resolve + silently refresh the user access token so the adapter's `send()`
// can act on behalf of the connected user (opt-in via `settings.sendAsUser`).
// ---------------------------------------------------------------------------

/**
 * Read the host-owned token on every call. A renderer-local cold-read cache
 * cannot observe another window's reauthorization or credential revocation.
 */
export async function getUserAccessToken(
  adapterId: string,
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
): Promise<string | null> {
  const { admitPersonalCredential } = await import("@/lib/execution/personal-credential")
  const admission = await admitPersonalCredential(credentialContext, {
    source: "lark-user",
    person: adapterId,
  })
  if (!admission.ok) return null
  const snapshot = await connectorsLarkUserAuth({ action: "snapshot", adapterId })
  return snapshot.configured && snapshot.authorizationEpoch ? (snapshot.accessToken ?? null) : null
}

/**
 * Refresh the user access token for `adapterId` using the persisted
 * `user_refresh_token` via the v2 token endpoint (`client_id` + `client_secret`
 * in the body — no tenant token needed). Conditionally publishes the rotated
 * pair through the existing host keyring authority.
 * Throws when no refresh token is stored or Lark rejects it.
 */
export async function refreshUserToken(opts: {
  brand?: FeishuBrand
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
  connectionAuthorization?: import("@/lib/plugin/auth/connection-manager").HostConnectionCredentialAuthorization
  adapterId: string
  appId: string
  appSecret: string
  expectedAuthorizationEpoch?: string
  signal?: AbortSignal
}): Promise<string> {
  const { admitPersonalCredential, PersonalCredentialRefusedError } =
    await import("@/lib/execution/personal-credential")
  if (opts.connectionAuthorization) {
    const { assertHostConnectionCredentialAuthorization } =
      await import("@/lib/plugin/auth/connection-manager")
    await assertHostConnectionCredentialAuthorization(opts.connectionAuthorization, opts.adapterId)
  } else {
    const admission = await admitPersonalCredential(opts.credentialContext, {
      source: "lark-user",
      person: opts.adapterId,
    })
    if (!admission.ok) throw new PersonalCredentialRefusedError(admission)
  }
  const captured = await withRequestAbort(opts.signal, () =>
    connectorsLarkUserAuth({ action: "snapshot", adapterId: opts.adapterId })
  )
  throwIfRequestAborted(opts.signal)
  if (
    !captured.configured ||
    !captured.accessToken ||
    (opts.expectedAuthorizationEpoch !== undefined &&
      captured.authorizationEpoch !== opts.expectedAuthorizationEpoch)
  ) {
    throw new Error("lark_auth_stale")
  }
  if (!captured.refreshToken || !captured.refreshRevision) {
    throw new Error(`Lark user token refresh: no refresh token stored for ${opts.adapterId}`)
  }
  let tokens: LarkUserAccessTokenResult
  try {
    tokens = await refreshUserAccessToken({
      refreshToken: captured.refreshToken,
      appId: opts.appId,
      appSecret: opts.appSecret,
      brand: opts.brand,
    })
  } catch (error) {
    if (error instanceof LarkOAuthError && error.code === "invalid_grant") {
      const { markLarkNeedsReauth } = await import("./host-auth")
      await markLarkNeedsReauth(
        opts.adapterId,
        captured.authorizationEpoch,
        captured.refreshRevision
      )
    }
    throw error
  }
  // Once dispatched, finish conditional publication even if this caller aborts:
  // dropping a rotated refresh token would break the still-connected account.
  try {
    const committed = await connectorsLarkUserAuth({
      action: "refresh",
      adapterId: opts.adapterId,
      expectedAuthorizationEpoch: captured.authorizationEpoch,
      expectedRefreshRevision: captured.refreshRevision,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    })
    if (!committed.accessToken) throw new Error("lark_auth_stale")
    const { reconcileLarkConnection } = await import("./host-auth")
    await reconcileLarkConnection(opts.adapterId, {
      expiresAt: new Date(Date.now() + tokens.expiresInSec * 1000).toISOString(),
      onlyExisting: true,
    })
    return committed.accessToken
  } catch (error) {
    if (!String(error).includes("lark_auth_stale")) throw error
    const current = await connectorsLarkUserAuth({ action: "snapshot", adapterId: opts.adapterId })
    // A concurrent refresh of the same authorization may have won. A changed
    // account/authorization must never be silently substituted or overwritten.
    if (current.authorizationEpoch === captured.authorizationEpoch && current.accessToken)
      return current.accessToken
    throw new Error("lark_auth_stale")
  }
}
