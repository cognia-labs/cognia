/**
 * Shared Lark OpenAPI request helpers (W2 chat management).
 *
 * The adapter factory's `sendHttp`/`doRequest` are private closures inside
 * `createLarkAdapter` (index.ts) — deliberately untouched. This module is the
 * exported equivalent for code that needs authenticated Lark calls OUTSIDE
 * the factory closure (chat-management.ts), reusing the same building blocks:
 * `connectorsHttpRequest` (Rust CORS-bypass bridge), `getTenantAccessToken` /
 * `getUserAccessToken`, `withTatRefresh` / `withUserTokenRefresh`, and
 * `LarkApiError`. Adds `PUT` (chat update needs it; the closures never did).
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import type { TenantTokenPurposeV1 } from "@cognia/plugin-contract/types/execution/acting-identity"
import { getTenantToken, getUserAccessToken } from "./auth"
import { LarkApiError, withTatRefresh, withUserTokenRefresh } from "./auth-retry"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"
import { assertLarkActingIdentity } from "@/lib/skills/built-in/lark/acting-identity"
import type { BuiltInSkillContext } from "@/lib/skills/built-in/types"

const LARK_API_BASE = "https://open.feishu.cn/open-apis"

export type LarkHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface LarkCredentials {
  appId: string
  appSecret: string
}

/** One authenticated call with an explicit bearer token (no refresh retry). */
async function rawRequest(
  method: LarkHttpMethod,
  urlPath: string,
  body: unknown,
  token: string,
  avatarPolicy = false
): Promise<unknown> {
  const resp = await connectorsHttpRequest({
    url: `${LARK_API_BASE}${urlPath}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(avatarPolicy ? { "X-Cognia-Avatar-Policy": "1" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (resp.status >= 400) {
    throw new LarkApiError({
      status: resp.status,
      headers: resp.headers,
      code: extractLarkCode(resp.body),
      message: `Lark API ${method} ${urlPath} → ${resp.status}: ${resp.body}`,
    })
  }
  const parsed = resp.body ? (JSON.parse(resp.body) as { code?: number; msg?: string }) : null
  if (parsed && typeof parsed.code === "number" && parsed.code !== 0) {
    throw new LarkApiError({
      status: resp.status,
      headers: resp.headers,
      code: parsed.code,
      message: `Lark API error: code=${parsed.code}, msg=${parsed.msg ?? "unknown"}`,
    })
  }
  return parsed
}

/**
 * Best-effort extraction of the Lark business error code from an HTTP
 * response body. Lark surfaces its error code inside the JSON body even on
 * HTTP >= 400 responses (e.g. `{"code":99991663,...}` in a 400), so callers
 * that classify errors (TAT refresh, retryability mapping) must read it from
 * here rather than relying on the HTTP status alone.
 */
export function extractLarkCode(body: string | undefined | null): number | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return typeof parsed.code === "number" ? parsed.code : null
  } catch {
    return null
  }
}

/**
 * Tenant-token (bot identity) request with the standard invalidation retry.
 */
export async function larkTenantRequest(
  creds: LarkCredentials,
  method: LarkHttpMethod,
  urlPath: string,
  body: unknown,
  purpose: TenantTokenPurposeV1,
  options?: { avatarPolicy?: boolean }
): Promise<unknown> {
  return withTatRefresh(creds, purpose, async () => {
    const tat = await getTenantToken(creds, purpose)
    return rawRequest(method, urlPath, body, tat, options?.avatarPolicy)
  })
}

/** Injected requests retain the required purpose argument of the labelled entry. */
export type LarkTenantRequest = typeof larkTenantRequest

/**
 * User-token (connected user identity) request with refresh-once retry.
 * Returns `null` when the adapter has NO stored user token — callers decide
 * whether that's an error (name search) or a silent skip.
 */
export async function larkUserRequest(
  adapterId: string,
  creds: LarkCredentials,
  method: LarkHttpMethod,
  urlPath: string,
  body?: unknown,
  context?: BuiltInSkillContext
): Promise<unknown | null> {
  const verified = await assertLarkActingIdentity(adapterId, context)
  const userToken = verified?.accessToken ?? (await getUserAccessToken(adapterId).catch(() => null))
  if (!userToken) return null
  let firstAttempt = true
  return withUserTokenRefresh(
    { adapterId, ...creds, expectedAuthorizationEpoch: verified?.authorizationEpoch },
    (token) => {
      const requestToken = verified && firstAttempt ? verified.accessToken : token
      firstAttempt = false
      return rawRequest(method, urlPath, body, requestToken)
    }
  )
}

/**
 * Lark permission-denied error codes → typed scope error.
 * 99991672 is the canonical "app has no permission (scope)" family; a bare
 * HTTP 403 from the gateway means the same thing with less detail.
 */
export const LARK_PERMISSION_CODES: ReadonlySet<number> = new Set([99991672, 99991679, 1248006])

export function classifyScopeError(
  err: unknown,
  requiredScope: string
): ChatManagementScopeError | null {
  if (!(err instanceof LarkApiError)) return null
  const permissionDenied =
    err.status === 403 || (err.code !== null && LARK_PERMISSION_CODES.has(err.code))
  if (!permissionDenied) return null
  return new ChatManagementScopeError(
    `Lark app is missing scope ${requiredScope} — enable it in the Lark developer console → Permissions, then re-publish the app. (${err.message})`,
    requiredScope,
    "lark"
  )
}
