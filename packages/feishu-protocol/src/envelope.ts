/**
 * Feishu's JSON response envelope: `{ code, msg, data }`, where `code` 0 is
 * success and anything else is a business error, even on HTTP 200.
 */

import { LarkApiError } from "./errors"
import type { FeishuHttpResponse } from "./transport"

export interface LarkEnvelope<T> {
  code: number
  msg?: string
  data?: T
}

/**
 * The `data` of a successful response. A non-JSON body, an HTTP error or a
 * non-zero `code` throws `LarkApiError` with the status, the Feishu code when
 * there is one, and `path` in the message.
 */
export function readLarkEnvelope<T>(resp: FeishuHttpResponse, path: string): T {
  let parsed: LarkEnvelope<T> | null = null
  try {
    parsed = resp.body ? (JSON.parse(resp.body) as LarkEnvelope<T>) : null
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
  return parsed.data as T
}
