/**
 * Authenticated Feishu/Lark OpenAPI harness shared by every non-IM reader.
 *
 * Extracted verbatim from `lib/twin/ingest/lark-doc-fetcher.ts`, which was the
 * only caller until the remote-document providers (ADR-0134) needed the same
 * three things for sheets and Bitable:
 *
 *   1. the Rust `connectors_http_request` bridge (open.feishu.cn sends no CORS
 *      headers, so a browser fetch can never work);
 *   2. the bound adapter's app credentials out of the OS keyring;
 *   3. an explicitly selected user or bot identity, with refresh within that
 *      identity only. Missing or expired user authorization never selects a bot.
 *
 * Error policy: this module throws `LarkAccessError` for the pre-flight
 * failures it can name (wrong host / no adapter / no credentials) and lets
 * `LarkApiError` out unchanged, optionally passed through the caller's
 * `mapError` at exactly the two points the original code mapped. Callers own
 * their own localized error taxonomy; this module owns none.
 */

import { observeTenantServiceData } from "@/lib/execution/acting-authority"
import { isTauri } from "@/lib/tauri"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  connectorsHttpRequest,
  connectorsKeyringGet,
  connectorsLarkUserAuth,
} from "@/lib/connectors/tauri/commands"
import { throwIfRequestAborted, withRequestAbort } from "@/lib/network/request-abort"
import { getTenantToken, getUserAccessToken } from "./auth"
import {
  LarkApiError,
  isLarkUserTokenInvalidation,
  withTatRefresh,
  withUserTokenRefresh,
} from "./auth-retry"

export const LARK_API_BASE = "https://open.feishu.cn"

type HttpImpl = typeof connectorsHttpRequest

/** Pre-flight failures that are about the account, not the request. */
export type LarkAccessErrorCode = "browserUnsupported" | "noAccount" | "notAuthorized"

export class LarkAccessError extends Error {
  readonly code: LarkAccessErrorCode
  /** Adapter display name, when one was resolved before the failure. */
  readonly account?: string

  constructor(code: LarkAccessErrorCode, account?: string) {
    super(account ? `${code}: ${account}` : code)
    this.name = "LarkAccessError"
    this.code = code
    this.account = account
  }
}

interface LarkEnvelope<T> {
  code: number
  msg?: string
  data?: T
}

/** JSON calls bound to one resolved identity. Paths are absolute (`/open-apis/...`). */
export interface LarkAuthedApi {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
  /**
   * Task v2 and Bitable writes (issue tracker sync, spec 2026-09-06 D10).
   * Optional on the type so the read-only fakes older callers build keep
   * their shape. `withLarkAuthedApi` always provides all three.
   */
  patch?<T>(path: string, body: unknown): Promise<T>
  put?<T>(path: string, body: unknown): Promise<T>
  delete?<T>(path: string): Promise<T>
}

type LarkWriteMethod = "POST" | "PATCH" | "PUT" | "DELETE"

export interface LarkAuthedApiAccount {
  adapterId: string
  displayName: string
}

export interface WithLarkAuthedApiOptions {
  /** Optional observation context; never used to select an identity. */
  sessionId?: string
  /** Bound Lark adapter instance id (`cai_...`) whose credentials to use. */
  adapterId: string
  expectedAuthorizationEpoch?: string
  signal?: AbortSignal
  maxResponseBytes?: number
  /** Test seam — overrides the `connectorsHttpRequest` transport. */
  httpImpl?: HttpImpl
  /** Required identity; credentials never cross from user to tenant on failure. */
  identity: "user" | "bot"
  /** Maps authenticated API errors; account failures retain LarkAccessError codes. */
  mapError?: (err: unknown, account: string) => unknown
}

/**
 * Resolve the explicitly selected Lark identity for `adapterId` and run `fn` with a
 * JSON API bound to it.
 */
export async function withLarkAuthedApi<T>(
  opts: WithLarkAuthedApiOptions,
  fn: (api: LarkAuthedApi, account: LarkAuthedApiAccount) => Promise<T>
): Promise<T> {
  throwIfRequestAborted(opts.signal)
  if (opts.identity !== "user" && opts.identity !== "bot")
    throw new LarkAccessError("notAuthorized")
  const result = await withRequestAbort(opts.signal, async () => {
    let authorizationEpoch = opts.expectedAuthorizationEpoch
    const assertCurrent = async () => {
      throwIfRequestAborted(opts.signal)
      if (opts.identity === "bot") return
      const current = await connectorsLarkUserAuth({
        action: "snapshot",
        adapterId: opts.adapterId,
      }).catch(() => {
        throwIfRequestAborted(opts.signal)
        throw new LarkAccessError("notAuthorized")
      })
      if (
        !current.configured ||
        (authorizationEpoch !== undefined && current.authorizationEpoch !== authorizationEpoch)
      )
        throw new LarkAccessError("notAuthorized")
      authorizationEpoch ??= current.authorizationEpoch
      throwIfRequestAborted(opts.signal)
    }
    const http = opts.httpImpl
    if (!http && !isTauri()) {
      // open.feishu.cn sends no CORS headers — a browser fetch can never work.
      throw new LarkAccessError("browserUnsupported")
    }
    const httpImpl = http ?? connectorsHttpRequest

    const row = await getAdapterInstance(opts.adapterId).catch(() => undefined)
    throwIfRequestAborted(opts.signal)
    if (!row || row.type !== "lark" || !row.enabled) {
      throw new LarkAccessError("noAccount")
    }
    await assertCurrent()
    throwIfRequestAborted(opts.signal)
    const [appId, appSecret] = await Promise.all([
      connectorsKeyringGet(opts.adapterId, "appId"),
      connectorsKeyringGet(opts.adapterId, "appSecret"),
    ]).catch(() => {
      throwIfRequestAborted(opts.signal)
      throw new LarkAccessError("notAuthorized", row.displayName)
    })
    throwIfRequestAborted(opts.signal)
    if (!appId || !appSecret) {
      throw new LarkAccessError("notAuthorized", row.displayName)
    }
    await assertCurrent()
    throwIfRequestAborted(opts.signal)

    const call = async <R>(
      path: string,
      authHeader: string,
      init?: { method: LarkWriteMethod; body?: unknown }
    ): Promise<R> => {
      await assertCurrent()
      throwIfRequestAborted(opts.signal)
      if (opts.identity === "bot") observeTenantServiceData(opts.sessionId, opts.adapterId, path)
      const resp = await httpImpl({
        url: `${LARK_API_BASE}${path}`,
        method: init?.method ?? "GET",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json; charset=utf-8",
        },
        ...(init && init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
      })
      await assertCurrent()
      throwIfRequestAborted(opts.signal)
      let parsed: LarkEnvelope<R> | null = null
      try {
        parsed = resp.body ? (JSON.parse(resp.body) as LarkEnvelope<R>) : null
      } catch {
        // Non-JSON body — fall through to the status check below.
      }
      if (resp.status >= 400 || !parsed || parsed.code !== 0) {
        throw new LarkApiError({
          status: resp.status,
          headers: resp.headers,
          code: parsed?.code ?? null,
          message: `Lark ${path} failed: code=${parsed?.code ?? "?"}, msg=${parsed?.msg ?? resp.body?.slice(0, 200) ?? "unknown"}`,
        })
      }
      return parsed.data as R
    }

    const bindApi = (authHeader: string): LarkAuthedApi => ({
      get: <R>(path: string) => call<R>(path, authHeader),
      post: <R>(path: string, body: unknown) => call<R>(path, authHeader, { method: "POST", body }),
      patch: <R>(path: string, body: unknown) =>
        call<R>(path, authHeader, { method: "PATCH", body }),
      put: <R>(path: string, body: unknown) => call<R>(path, authHeader, { method: "PUT", body }),
      delete: <R>(path: string) => call<R>(path, authHeader, { method: "DELETE" }),
    })

    const account: LarkAuthedApiAccount = {
      adapterId: opts.adapterId,
      displayName: row.displayName,
    }
    const rethrow = (err: unknown): never => {
      throw opts.mapError ? opts.mapError(err, row.displayName) : err
    }

    const ctx = {
      adapterId: opts.adapterId,
      appId,
      appSecret,
      expectedAuthorizationEpoch: authorizationEpoch,
      signal: opts.signal,
    }
    if (opts.identity === "user") {
      let userToken: string | null
      try {
        userToken = await getUserAccessToken(opts.adapterId)
      } catch {
        throw new LarkAccessError("notAuthorized", row.displayName)
      }
      throwIfRequestAborted(opts.signal)
      if (!userToken) throw new LarkAccessError("notAuthorized", row.displayName)
      let lastCallError: unknown
      try {
        return await withUserTokenRefresh(ctx, async (token) => {
          await assertCurrent()
          throwIfRequestAborted(opts.signal)
          try {
            return await fn(bindApi(`Bearer ${token}`), account)
          } catch (err) {
            lastCallError = err
            throw err
          }
        })
      } catch (err) {
        throwIfRequestAborted(opts.signal)
        await assertCurrent()
        // A failure outside fn is token capture/refresh, not an API scope error.
        if (err !== lastCallError || isLarkUserTokenInvalidation(err)) {
          throw new LarkAccessError("notAuthorized", row.displayName)
        }
        return rethrow(err)
      }
    }
    try {
      return await withTatRefresh(ctx, "service-data", async () => {
        await assertCurrent()
        throwIfRequestAborted(opts.signal)
        const tat = await getTenantToken({ appId, appSecret }, "service-data")
        throwIfRequestAborted(opts.signal)
        const value = await fn(bindApi(`Bearer ${tat}`), account)
        await assertCurrent()
        throwIfRequestAborted(opts.signal)
        return value
      })
    } catch (err) {
      return rethrow(err)
    }
  })
  throwIfRequestAborted(opts.signal)
  return result
}
