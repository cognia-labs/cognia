/**
 * Lark tenant-access-token refresh wrapper.
 *
 * The TAT cache in `auth.ts` keys on `appId:appSecret` and refreshes only
 * when its local TTL expires (7200 s by default). When the Lark server
 * invalidates the token early — credentials rotated, security audit,
 * app re-installed — every subsequent call fails with HTTP 401 or the
 * Lark error code 99991663 ("invalid access_token") until the cache
 * naturally expires, which can leave the adapter dead for nearly two
 * hours.
 *
 * `withTatRefresh` wraps a Lark API invocation: on TAT invalidation, it
 * clears the cache entry for the same `(appId, appSecret)` pair and
 * retries the call exactly once. Anything else propagates unchanged.
 *
 * What counts as an invalidation is the protocol library's
 * (`@cognia/feishu-protocol`: `isLarkTatInvalidation`,
 * `isLarkUserTokenInvalidation`); these wrappers own the retry, because they
 * hold the token cache and the user's refresh token.
 */

import type { TenantTokenPurposeV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import { isLarkTatInvalidation, isLarkUserTokenInvalidation } from "@cognia/feishu-protocol"
import { clearTokenCache, refreshUserToken } from "./auth"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { throwIfRequestAborted, withRequestAbort } from "@/lib/network/request-abort"

export interface TatRefreshContext {
  appId: string
  appSecret: string
}

/**
 * Run `fn` once. If it throws an error matching `isLarkTatInvalidation`,
 * clear the cached tenant access token for this `(appId, appSecret)`
 * pair and retry exactly once. The retry's outcome (success or failure)
 * is returned / propagated unchanged — we never retry more than once,
 * to avoid masking persistent credential failures.
 */
export async function withTatRefresh<T>(
  ctx: TatRefreshContext,
  purpose: TenantTokenPurposeV1,
  fn: () => Promise<T>
): Promise<T> {
  void purpose
  try {
    return await fn()
  } catch (err) {
    if (!isLarkTatInvalidation(err)) throw err
    clearTokenCache(ctx.appId, ctx.appSecret)
    return await fn()
  }
}

// ---------------------------------------------------------------------------
// User access token refresh (send-as-user path)
// ---------------------------------------------------------------------------

export interface UserTokenRefreshContext {
  brand?: "feishu" | "lark"
  credentialContext?: import("@/lib/execution/personal-credential").PersonalCredentialContext
  adapterId: string
  appId: string
  appSecret: string
  expectedAuthorizationEpoch?: string
  signal?: AbortSignal
}

/**
 * Run `fn` once. If it throws a user-token-invalidation error, refresh the
 * user access token (rotating + persisting it) and retry exactly once. Any
 * other error — or a failure on the retry — propagates so the caller can
 * decide whether to fall back to the bot (tenant) identity.
 */
export async function withUserTokenRefresh<T>(
  ctx: UserTokenRefreshContext,
  fn: (accessToken: string, authorizationEpoch: string) => Promise<T>
): Promise<T> {
  const capture = async (expectedEpoch?: string) => {
    const current = await withRequestAbort(ctx.signal, () =>
      connectorsLarkUserAuth({ action: "snapshot", adapterId: ctx.adapterId })
    )
    throwIfRequestAborted(ctx.signal)
    if (
      !current.configured ||
      !current.accessToken ||
      (expectedEpoch !== undefined && current.authorizationEpoch !== expectedEpoch)
    ) {
      throw new Error("lark_auth_stale")
    }
    return { authorizationEpoch: current.authorizationEpoch, accessToken: current.accessToken }
  }
  const captured = await capture(ctx.expectedAuthorizationEpoch)
  throwIfRequestAborted(ctx.signal)
  const invoke = async (current: typeof captured) => {
    const result = await fn(current.accessToken, current.authorizationEpoch)
    await capture(current.authorizationEpoch)
    throwIfRequestAborted(ctx.signal)
    return result
  }
  try {
    return await invoke(captured)
  } catch (err) {
    throwIfRequestAborted(ctx.signal)
    if (!isLarkUserTokenInvalidation(err)) throw err
    await refreshUserToken({ ...ctx, expectedAuthorizationEpoch: captured.authorizationEpoch })
    const current = await capture(captured.authorizationEpoch)
    throwIfRequestAborted(ctx.signal)
    // Pass the atomically captured token with its epoch; callbacks must not
    // reread a token belonging to a replacement authorization.
    return await invoke(current)
  }
}
