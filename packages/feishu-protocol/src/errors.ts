/**
 * Feishu's error vocabulary: the typed API error, the business codes that mean
 * a token or a permission is gone, and the readers that classify a failure.
 * Refresh and retry policy belong to whoever holds the credentials; this file
 * only says what a failure is.
 */

/** Feishu error codes signalling the tenant access token is no longer valid. */
export const TAT_INVALIDATION_CODES: ReadonlySet<number> = new Set([
  99991663, // invalid access_token (most common)
  99991664, // invalid app_id (returned when token signature is rejected)
  99991668, // app_access_token expired (variant code)
])

/** Feishu error codes signalling the user access token is no longer valid. */
export const USER_TOKEN_INVALIDATION_CODES: ReadonlySet<number> = new Set([
  99991677, // invalid user access token
  99991668, // access token expired (variant)
])

/**
 * Permission-denied codes. 99991672 is the canonical "app has no permission
 * (scope)" family; a bare HTTP 403 from the gateway means the same thing with
 * less detail.
 */
export const LARK_PERMISSION_CODES: ReadonlySet<number> = new Set([99991672, 99991679, 1248006])

export interface LarkApiErrorInit {
  status: number
  code: number | null
  message: string
  headers?: Record<string, string>
}

/**
 * Typed error for a failed Feishu call, so callers can tell HTTP-layer
 * failures from Feishu business-error codes. A rate-limited response (HTTP 429
 * or code 99991400) carries the gateway's reset hint as `retryAfterMs`.
 */
export class LarkApiError extends Error {
  readonly status: number
  readonly code: number | null
  readonly retryAfterMs?: number

  constructor(init: LarkApiErrorInit) {
    super(init.message)
    this.name = "LarkApiError"
    this.status = init.status
    this.code = init.code
    if (init.status === 429 || init.code === 99991400) {
      const reset = Object.entries(init.headers ?? {})
        .find(([name]) => name.toLowerCase() === "x-ogw-ratelimit-reset")?.[1]
        ?.trim()
      const milliseconds = reset ? Number(reset) * 1000 : Number.NaN
      if (Number.isFinite(milliseconds) && milliseconds >= 0) {
        this.retryAfterMs = Math.ceil(milliseconds)
      }
    }
  }
}

/**
 * Best-effort extraction of the Feishu business error code from an HTTP
 * response body. Feishu surfaces its error code inside the JSON body even on
 * HTTP >= 400 responses (e.g. `{"code":99991663,...}` in a 400), so callers
 * that classify errors must read it from here rather than the status alone.
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
 * Matches HTTP 401, a code in `codes`, and the same code embedded in a plain
 * `Error` message (which is how the desktop's upload commands surface it).
 */
function isInvalidation(err: unknown, codes: ReadonlySet<number>): boolean {
  if (err instanceof LarkApiError) {
    if (err.status === 401) return true
    return err.code !== null && codes.has(err.code)
  }
  if (err instanceof Error) {
    const msg = err.message
    if (/(^|\s)401(\b|\D)/.test(msg)) return true
    for (const code of codes) {
      if (msg.includes(`code=${code}`) || msg.includes(`code: ${code}`)) return true
    }
  }
  return false
}

/** True when the error looks like the tenant access token was invalidated server-side. */
export function isLarkTatInvalidation(err: unknown): boolean {
  return isInvalidation(err, TAT_INVALIDATION_CODES)
}

/** True when the error looks like the USER access token was invalidated. */
export function isLarkUserTokenInvalidation(err: unknown): boolean {
  return isInvalidation(err, USER_TOKEN_INVALIDATION_CODES)
}

/** True when a Feishu call failed because the app lacks a permission (scope). */
export function isLarkPermissionDenied(err: unknown): err is LarkApiError {
  if (!(err instanceof LarkApiError)) return false
  return err.status === 403 || (err.code !== null && LARK_PERMISSION_CODES.has(err.code))
}
