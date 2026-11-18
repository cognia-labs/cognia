import { createHash, timingSafeEqual } from "node:crypto"
import http from "node:http"
import https from "node:https"
import { Readable, type Duplex } from "node:stream"
import tls from "node:tls"

import WebSocket from "ws"

import type { AuthFetcher } from "@/lib/tauri/companion-auth"
import type { PinnedFetchInit } from "@/lib/tauri/pinned-fetch"

import { CONNECT_TIMEOUT_CODE, HostConnectError } from "../util/connect-phase"

import type { WorkerWebSocket } from "./worker-connect"

export class CompanionWorkerTransportError extends Error {
  constructor(
    readonly code: "tls_pin_mismatch" | "tls_peer_certificate_missing" | "transport_error",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "CompanionWorkerTransportError"
  }
}

export function normalizeSpkiFingerprint(value: string): Buffer {
  const normalized = value
    .trim()
    .replace(/^sha256[:/-]?/i, "")
    .replace(/:/g, "")
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new CompanionWorkerTransportError(
      "tls_pin_mismatch",
      "server fingerprint must be a SHA-256 SPKI hex digest"
    )
  }
  return Buffer.from(normalized, "hex")
}

export function verifyPinnedPeer(socket: tls.TLSSocket, expectedFingerprint: string): void {
  const certificate = socket.getPeerX509Certificate()
  if (!certificate?.publicKey) {
    throw new CompanionWorkerTransportError(
      "tls_peer_certificate_missing",
      "TLS peer did not provide an X.509 certificate"
    )
  }
  const actual = createHash("sha256")
    .update(certificate.publicKey.export({ type: "spki", format: "der" }))
    .digest()
  const expected = normalizeSpkiFingerprint(expectedFingerprint)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new CompanionWorkerTransportError(
      "tls_pin_mismatch",
      "TLS peer SPKI fingerprint does not match the enrolled server"
    )
  }
}

class PinnedHttpsAgent extends https.Agent {
  /**
   * Sockets still connecting or handshaking. The request only receives its
   * socket once the pin is verified, so until then aborting the request
   * cannot reach the socket: `abortPending` can.
   */
  private readonly pending = new Set<tls.TLSSocket>()

  constructor(
    private readonly fingerprint: string,
    /** Give up connecting (TCP, TLS and the pin check) after this long. */
    private readonly connectTimeoutMs?: number
  ) {
    super({ keepAlive: false })
  }

  abortPending(error: Error): void {
    for (const socket of this.pending) socket.destroy(error)
  }

  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const connectionOptions = {
      ...options,
      host: typeof options.host === "string" ? options.host : undefined,
      port:
        typeof options.port === "number"
          ? options.port
          : typeof options.port === "string"
            ? Number(options.port)
            : undefined,
      rejectUnauthorized: false,
    } as tls.ConnectionOptions
    const socket = tls.connect(connectionOptions)
    this.pending.add(socket)
    let settled = false
    const timer = this.connectTimeoutMs
      ? setTimeout(
          () =>
            settle(
              new HostConnectError(
                `no connection to ${connectionOptions.host ?? "the host"} within ${this.connectTimeoutMs} ms`,
                CONNECT_TIMEOUT_CODE
              )
            ),
          this.connectTimeoutMs
        )
      : undefined
    // Until the pin is verified the request has not been handed the socket,
    // so nothing was written: every failure here is one the request never sent.
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      this.pending.delete(socket)
      if (error) {
        // A pin refusal keeps its own type: callers tell it apart from a
        // retryable failure, and its code already reads as never sent.
        const unsent =
          error instanceof HostConnectError || error instanceof CompanionWorkerTransportError
            ? error
            : new HostConnectError(error.message, codeOf(error) ?? "COGNIA_CONNECT_FAILED", {
                cause: error,
              })
        socket.destroy(unsent)
        callback?.(unsent, socket)
      } else {
        callback?.(null, socket)
      }
    }
    socket.once("secureConnect", () => {
      try {
        verifyPinnedPeer(socket, this.fingerprint)
        settle()
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.once("error", settle)
    return callback ? undefined : socket
  }
}

function responseFromNode(
  status: number,
  statusText: string,
  headers: http.IncomingHttpHeaders,
  body: Readable
): Response {
  const responseBody = [204, 205, 304].includes(status)
    ? null
    : (Readable.toWeb(body) as ReadableStream<Uint8Array>)
  return new Response(responseBody, {
    status,
    statusText,
    headers: Object.fromEntries(
      Object.entries(headers).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]
      )
    ),
  })
}

/** The rejection an aborted request settles with, like `fetch`'s. */
function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof Error) return reason
  return new DOMException("This operation was aborted", "AbortError")
}

function codeOf(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

async function pinnedRequest(
  url: URL,
  init: PinnedFetchInit,
  fingerprint: string,
  connectTimeoutMs?: number
): Promise<Response> {
  if (url.protocol !== "https:") {
    throw new CompanionWorkerTransportError(
      "transport_error",
      "SPKI pinning requires an HTTPS Companion URL"
    )
  }
  const signal = init.signal ?? undefined
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const agent = new PinnedHttpsAgent(fingerprint, connectTimeoutMs)
    // Abort reaches a socket that is still connecting (an unroutable address
    // otherwise holds the request, and the process, for the OS connect
    // timeout) as well as one already handed to the request.
    const onAbort = () => {
      const error = abortError(signal)
      agent.abortPending(error)
      request.destroy(error)
      reject(error)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const request = https.request(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined,
        agent,
      },
      (response) => {
        response.once("close", () => signal?.removeEventListener("abort", onAbort))
        resolve(
          responseFromNode(
            response.statusCode ?? 0,
            response.statusMessage ?? "",
            response.headers,
            response
          )
        )
      }
    )
    request.once("error", (error) => {
      signal?.removeEventListener("abort", onAbort)
      reject(error)
    })
    if (init.body == null) request.end()
    else if (typeof init.body === "string" || Buffer.isBuffer(init.body)) request.end(init.body)
    else {
      const error = new CompanionWorkerTransportError("transport_error", "unsupported request body")
      request.destroy(error)
      reject(error)
    }
  })
}

/** Node-only transport for Companion enrollment/tickets and worker WSS. */
export class CompanionWorkerTransport {
  readonly fetch: AuthFetcher = async (url, init) => {
    if (!init.serverFingerprint) {
      const { serverFingerprint: _fingerprint, ...standard } = init
      return fetch(url, standard)
    }
    return pinnedRequest(new URL(url), init, init.serverFingerprint)
  }

  /**
   * {@link fetch} to a pinned host, giving up after `connectTimeoutMs` of
   * connecting with a {@link HostConnectError}: the request was never sent.
   */
  fetchPinned(
    url: string,
    init: PinnedFetchInit & { serverFingerprint: string },
    connectTimeoutMs?: number
  ): Promise<Response> {
    return pinnedRequest(new URL(url), init, init.serverFingerprint, connectTimeoutMs)
  }

  openWebSocket(url: string, serverFingerprint?: string): WorkerWebSocket {
    const parsed = new URL(url)
    if (serverFingerprint && parsed.protocol !== "wss:") {
      throw new CompanionWorkerTransportError(
        "transport_error",
        "SPKI pinning requires a WSS Companion URL"
      )
    }
    const socket = new WebSocket(url, {
      ...(serverFingerprint
        ? { agent: new PinnedHttpsAgent(serverFingerprint), rejectUnauthorized: false }
        : {}),
      maxPayload: 32 * 1024 * 1024,
    })
    return new WsWorkerSocket(socket)
  }
}

class WsWorkerSocket implements WorkerWebSocket {
  constructor(private readonly socket: WebSocket) {}

  get bufferedAmount(): number {
    return this.socket.bufferedAmount
  }

  send(data: string): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; error?: unknown }) => void
  ): void {
    if (type === "message") {
      this.socket.on("message", (data, isBinary) =>
        listener({ data: isBinary ? data : data.toString("utf8") })
      )
      return
    }
    if (type === "error") {
      this.socket.on("error", (error) => listener({ error }))
      return
    }
    this.socket.on(type, () => listener({}))
  }
}
