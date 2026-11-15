/**
 * Fetch-compatible buffered HTTP bridge for the Cognia desktop proxy policy.
 *
 * The renderer never decides direct-vs-proxy and never handles proxy
 * credentials. In Tauri every request crosses the native command, where the
 * initialized runtime policy applies bypass, authentication, and fail-closed
 * routing. Browser builds continue to use the browser's ordinary fetch.
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

interface ProxiedRequestInput {
  requestId: string
  admissionToken?: string
  url: string
  method: string
  headers?: Record<string, string>
  bodyBase64?: string
  timeoutMs?: number
  redirect: RequestRedirect
  blockPrivate?: boolean
  downloadPolicy?: BinaryDownloadPolicy
}

interface ProxiedRequestOutput {
  status: number
  bodyBase64: string
  headers: Record<string, string>
}

export interface ProxyFetchOptions extends RequestInit {
  /** Native request timeout in milliseconds. */
  timeout?: number
  /** Reject private/loopback/link-local targets in the native boundary. */
  blockPrivateHosts?: boolean
  /** Native-enforced, HTTPS/public-only, bounded binary download. */
  downloadPolicy?: BinaryDownloadPolicy
}

export interface BinaryDownloadPolicy {
  allowedOrigins: readonly string[]
  maxBytes: number
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `proxy-${Date.now()}-${Math.random()}`
}

function abortError(): Error {
  if (typeof DOMException !== "undefined")
    return new DOMException("The operation was aborted", "AbortError")
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return buffer
}

/**
 * HTTP statuses that MUST NOT carry a body. The `Response` constructor throws
 * a `TypeError` for any non-null body on these — and a zero-length
 * `ArrayBuffer` is still a body, so decoding an empty payload was enough to
 * blow up. The throw happened inside the try below and got rewrapped as an
 * opaque "Proxy request failed", pointing the reader at the network instead of
 * at the line above.
 *
 * This matters well beyond cosmetics: 304 is the whole point of an ETag
 * conditional request (`lib/github/pr-observe/fetch.ts`, and now the GitHub
 * issue mirror), and 204 is what GitHub's DELETE endpoints return. Both were
 * unreachable through this transport.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

function nullBodyFor(status: number, bodyBase64: string): ArrayBuffer | null {
  return NULL_BODY_STATUSES.has(status) ? null : base64ToArrayBuffer(bodyBase64)
}

function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "proxy-authorization") {
      throw new Error("Proxy-Authorization is reserved for the native proxy connector")
    }
    result[key] = value
  })
  return result
}

async function bodyBase64(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined
  const bytes = new Uint8Array(await request.clone().arrayBuffer())
  return bytes.length > 0 ? bytesToBase64(bytes) : undefined
}

async function tauriProxiedFetch(
  input: RequestInfo | URL,
  init: ProxyFetchOptions = {}
): Promise<Response> {
  const { timeout, blockPrivateHosts, downloadPolicy, ...requestInit } = init
  const request = new Request(input, requestInit)
  if (request.signal.aborted) throw abortError()
  const id = requestId()
  let admissionToken: string | undefined
  let legacyDispatched = false
  let released = false
  const cancelNative = () => {
    if (!admissionToken && !legacyDispatched) return
    void invoke("proxy_http_cancel", {
      requestId: id,
      ...(admissionToken ? { admissionToken } : {}),
    }).catch(() => undefined)
  }

  let rejectAborted: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject
  })
  const onAbort = () => {
    cancelNative()
    rejectAborted?.(abortError())
  }
  request.signal.addEventListener("abort", onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        cancelNative()
        reject(new Error(downloadPolicy ? "download_timed_out" : "request timed out"))
      },
      downloadPolicy
        ? Math.min(Math.max(timeout ?? 60_000, 1), 60_000)
        : Math.max(timeout ?? 30_000, 1)
    )
  })

  try {
    const encodedBody = await Promise.race([bodyBase64(request), aborted, deadline])
    const payload: ProxiedRequestInput = {
      requestId: id,
      url: request.url,
      method: request.method,
      headers: headerRecord(request.headers),
      bodyBase64: encodedBody,
      timeoutMs: timeout,
      redirect: request.redirect,
      ...(blockPrivateHosts ? { blockPrivate: true } : {}),
      ...(downloadPolicy ? { downloadPolicy } : {}),
    }
    const capabilities = await Promise.race([
      invoke<{ downloadPolicyVersion?: number; requestAdmissionVersion?: number }>(
        "proxy_get_active"
      ),
      aborted,
      deadline,
    ])
    const admitted = capabilities?.requestAdmissionVersion === 1
    if (capabilities?.requestAdmissionVersion !== undefined && !admitted) {
      throw new Error("request_admission_unsupported")
    }
    if (downloadPolicy && (capabilities?.downloadPolicyVersion !== 2 || !admitted)) {
      throw new Error("download_policy_unsupported")
    }
    if (admitted) {
      const preparation = invoke<string>("proxy_http_prepare", { requestId: id }).then((token) => {
        if (typeof token !== "string" || !token || token.length > 128)
          throw new Error("request_admission_invalid")
        admissionToken = token
        if (released || request.signal.aborted) cancelNative()
        return token
      })
      payload.admissionToken = await Promise.race([preparation, aborted, deadline])
    }
    if (request.signal.aborted) throw abortError()
    legacyDispatched = !admitted
    const native = invoke<ProxiedRequestOutput>("proxy_http_request", { input: payload })
    const result = await Promise.race([native, aborted, deadline])
    const responseHeaders = new Headers(result.headers)
    return new Response(nullBodyFor(result.status, result.bodyBase64), {
      status: result.status,
      headers: responseHeaders,
    })
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Proxy request failed: ${message}`, { cause: error })
  } finally {
    released = true
    if (admissionToken) cancelNative()
    if (timer !== undefined) clearTimeout(timer)
    request.signal.removeEventListener("abort", onAbort)
  }
}

async function browserFetch(
  input: RequestInfo | URL,
  init: ProxyFetchOptions = {}
): Promise<Response> {
  const { timeout, blockPrivateHosts: _blockPrivateHosts, downloadPolicy, ...requestInit } = init
  if (downloadPolicy) throw new Error("download_policy_unsupported")
  if (!timeout) return fetch(input, requestInit)

  const request = new Request(input, requestInit)
  if (request.signal.aborted) throw abortError()
  const controller = new AbortController()
  const propagateAbort = () => controller.abort()
  request.signal.addEventListener("abort", propagateAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(request, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener("abort", propagateAbort)
  }
}

/** Create the canonical proxy-aware fetch implementation. */
export function createProxyFetch() {
  return async (input: RequestInfo | URL, init?: ProxyFetchOptions): Promise<Response> => {
    if (!isTauri()) return browserFetch(input, init)
    return tauriProxiedFetch(input, init)
  }
}

export const proxyFetch = createProxyFetch()
export default proxyFetch
