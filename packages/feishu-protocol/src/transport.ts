/**
 * The HTTP transport this library sends through. It holds no client of its
 * own: `open.feishu.cn` sends no CORS headers, so the host passes a transport
 * that can reach it (the desktop's Rust bridge, a server's fetch, a test fake).
 * Bodies are text, as Feishu's JSON API needs.
 */

export interface FeishuHttpRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  /** Upper bound the transport enforces on the response body, when it can. */
  maxResponseBytes?: number
}

export interface FeishuHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type FeishuTransport = (request: FeishuHttpRequest) => Promise<FeishuHttpResponse>

/** Headers every JSON request carries. */
export const FEISHU_JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
})
