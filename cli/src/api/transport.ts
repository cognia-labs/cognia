import { directEvents, type WatchOptions } from "./events"
import { AsyncLocalStorage } from "node:async_hooks"
/**
 * The two wires a Cognia Host answers on, behind one `execute(name, args)`.
 *
 * `internal` is `POST /internal/_rpc/{name}` with a loopback service token.
 * The host treats a loopback service principal as the policy authority for
 * the Brain plane, so this wire carries every command and neither capability
 * grants nor approval leases apply. It is the headless server's own wire.
 *
 * `device` is `POST /api/_rpc/{name}` with a DPoP-bound device session. Only
 * `execution` and `host-admin` commands are admitted, every capability grant
 * is checked, and `interactive` / `signed-policy` commands need a lease or a
 * policy. It is the wire a paired device uses, local or remote.
 *
 * Nothing here decides *which* wire to use. That is the resolver's job
 * (`cli/src/host/resolve.ts`), so this module stays a pure protocol layer.
 */

import { CompanionApiError, createCompanionSession, signerFromJwk } from "@cognia/companion-client"

import type { FailureCause } from "../cli/errors"

export const INTERNAL_RPC_PREFIX = "/internal/_rpc"
export const DEVICE_RPC_PREFIX = "/api/_rpc"
export const INTERNAL_OPERATION_PREFIX = "/internal/operations"
export const DEVICE_OPERATION_PREFIX = "/api/operations"

export type HostWire = "internal" | "http"

export interface CommandSuccess {
  ok: true
  result: unknown
  /** The host answered 202: the work is running and `operationId` tracks it. */
  accepted?: boolean
  operationId?: string
  metadata?: Record<string, unknown>
}

export interface CommandFailure {
  ok: false
  cause: FailureCause
  message: string
  details?: string[]
  status?: number
  /** The host's own error code, e.g. `unknown_command`. */
  code?: string
  requestId?: string
  problem?: Record<string, unknown>
  retryable?: boolean
  retryAfter?: string
  retryAfterMs?: number
  operationId?: string
}

export type CommandOutcome = CommandSuccess | CommandFailure

export interface RequestOptions {
  timeoutMs?: number
  /** Idempotency key for commands the manifest marks `required`. */
  idempotencyKey?: string
  signal?: AbortSignal
  responseMode?: "json" | "text" | "bytes" | "stream"
  rawBody?: BodyInit
  headers?: Record<string, string>
  onChunk?: (chunk: Uint8Array) => void
  maxBytes?: number
}

export interface HostTransport {
  watch?: (options: WatchOptions) => Promise<CommandOutcome>
  wire: HostWire
  /** One human line naming the plane, for the report header and Inspect block. */
  label: string
  execute(
    name: string,
    args?: Record<string, unknown>,
    options?: RequestOptions
  ): Promise<CommandOutcome>
  /** Raw escape hatch for the routes that are not RPC commands. */
  request(
    method: string,
    routePath: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<CommandOutcome>
  /**
   * Release whatever the transport holds open beyond a single request, such
   * as a relay room's socket, which would otherwise keep the process alive.
   */
  close?(): void
}

/** Injected so tests never open a socket, and so TLS pinning can wrap it. */
export type TransportFetch = (url: string, init: RequestInit) => Promise<Response>

/** Cancel this waiter even when another call owns the shared authentication work. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("request stopped", "AbortError"))
    promise.then(resolve, reject)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  }).finally(() => signal.removeEventListener("abort", abort))
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "")
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed
  } catch {
    // A gateway error page in place of the real response. Keep the body so the
    // Details block can show what actually came back.
    return { __nonJsonBody: text.slice(0, 500) }
  }
}

function stringField(body: unknown, ...keys: string[]): string | undefined {
  if (!body || typeof body !== "object") return undefined
  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** Map an HTTP answer onto a cause the failure block can classify. */
export function classifyStatus(status: number, code?: string): FailureCause {
  if (status === 404 || code === "unknown_command") return "unknown-command"
  if (status === 401 || status === 403) {
    return code === "interactive_approval_required" ||
      code === "signed_policy_required" ||
      code === "command_transport_forbidden"
      ? "refused"
      : "auth"
  }
  if (status === 408 || status === 504) return "timeout"
  if (status === 400 || status === 422) return "invalid-request"
  if (status === 428) return "refused"
  if (status >= 500) return "failed"
  return "refused"
}

export function failureFromResponse(status: number, value: unknown): CommandFailure {
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const code = stringField(body, "code", "error")
  // The Host answers one problem document (ADR-0175), whose `detail` is the
  // message. `message` and `error_description` are what older Hosts and the
  // OAuth-shaped routes wrote.
  const message =
    stringField(body, "detail", "message", "error_description") ??
    `the host answered HTTP ${status}`
  const nonJson = body.__nonJsonBody
  return {
    ok: false,
    cause: classifyStatus(status, code),
    message,
    status,
    problem: body,
    ...(typeof body.retryable === "boolean" ? { retryable: body.retryable } : {}),
    ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}),
    ...(code ? { code } : {}),
    ...(stringField(body, "requestId", "request_id")
      ? { requestId: stringField(body, "requestId", "request_id") }
      : {}),
    ...(typeof body.details === "object" && body.details !== null
      ? { details: [JSON.stringify(body.details)] }
      : {}),
    ...(typeof nonJson === "string" ? { details: [`non-JSON body: ${nonJson}`] } : {}),
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "name" in error && error.name === "AbortError"
  )
}

function networkFailure(error: unknown, aborted = false): CommandFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (aborted || isAbortError(error)) {
    return { ok: false, cause: "timeout", message: "the request exceeded its timeout budget" }
  }
  return { ok: false, cause: "network", message }
}

function successFromResponse(status: number, body: unknown): CommandSuccess {
  if (status === 202) {
    // The 202 body is the Operation document (ADR-0175 B3): `id` is the
    // operation. Older hosts wrote `operationId`.
    const operationId = stringField(body, "id", "operationId", "operation_id")
    return { ok: true, accepted: true, result: body, ...(operationId ? { operationId } : {}) }
  }
  return { ok: true, result: body }
}

interface HttpCallInput {
  fetchImpl: TransportFetch
  endpoint: string
  method: string
  routePath: string
  body?: unknown
  headers: Record<string, string>
  options?: RequestOptions
}

async function httpCall(input: HttpCallInput): Promise<CommandOutcome> {
  const controller = new AbortController()
  const timeoutMs = input.options?.timeoutMs
  const timer =
    timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  const forwarded = input.options?.signal
  const onAbort = () => controller.abort()
  if (forwarded?.aborted) controller.abort()
  forwarded?.addEventListener("abort", onAbort)
  try {
    controller.signal.throwIfAborted()
    const headers = new Headers(input.headers)
    for (const [name, value] of new Headers(input.options?.headers)) headers.set(name, value)
    if (input.options?.idempotencyKey) headers.set("idempotency-key", input.options.idempotencyKey)
    const response = await input.fetchImpl(`${input.endpoint}${input.routePath}`, {
      method: input.method,
      headers: Object.fromEntries(headers),
      ...(input.options?.rawBody !== undefined
        ? { body: input.options.rawBody }
        : input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
      redirect: "error",
      signal: controller.signal,
    })
    controller.signal.throwIfAborted()
    if (!response.ok) {
      const failed = failureFromResponse(
        response.status,
        await untilAborted(readBody(response), controller.signal)
      )
      controller.signal.throwIfAborted()
      return {
        ...failed,
        ...(response.headers?.get?.("retry-after")
          ? { retryAfter: response.headers.get("retry-after")! }
          : {}),
      }
    }
    const mode = input.options?.responseMode ?? "json"
    if (mode === "bytes" || mode === "stream") {
      const chunks: Uint8Array[] = []
      const reader = response.body?.getReader()
      if (!reader)
        return { ok: false, cause: "failed", message: "response has no readable byte stream" }
      let bytes = 0
      try {
        while (true) {
          if (controller.signal.aborted) throw new DOMException("request stopped", "AbortError")
          const chunk = await untilAborted(reader.read(), controller.signal)
          if (controller.signal.aborted) throw new DOMException("request stopped", "AbortError")
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > (input.options?.maxBytes ?? 64 * 1024 * 1024))
            throw new Error("response exceeds --max-bytes")
          if (mode === "stream") input.options?.onChunk?.(chunk.value)
          else chunks.push(chunk.value)
        }
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      return { ok: true, result: mode === "bytes" ? Buffer.concat(chunks) : { bytes } }
    }
    if (mode === "text") {
      const result = await untilAborted(response.text(), controller.signal)
      controller.signal.throwIfAborted()
      return { ok: true, result }
    }
    const body = await untilAborted(readBody(response), controller.signal)
    if (controller.signal.aborted) throw new DOMException("request stopped", "AbortError")
    if (body && typeof body === "object" && "__nonJsonBody" in body)
      return {
        ok: false,
        cause: "failed",
        message: "host returned non-JSON; use --response text, bytes or stream",
      }
    return successFromResponse(response.status, body)
  } catch (error) {
    return networkFailure(error, controller.signal.aborted)
  } finally {
    if (timer) clearTimeout(timer)
    forwarded?.removeEventListener("abort", onAbort)
  }
}

export interface InternalTransportOptions {
  endpoint: string
  serviceToken: string
  fetchImpl?: TransportFetch
}

/** Headless wire. The service token is only ever sent to the host that issued it. */
export function internalTransport(options: InternalTransportOptions): HostTransport {
  const endpoint = options.endpoint.replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const headers = (extra: Record<string, string> = {}) => ({
    "content-type": "application/json",
    authorization: `Bearer ${options.serviceToken}`,
    ...extra,
  })
  return {
    wire: "internal",
    watch: (optionsForWatch) =>
      directEvents({ endpoint, serviceToken: options.serviceToken }, optionsForWatch),
    label: `cognia-server (${endpoint})`,
    execute(name, args = {}, requestOptions) {
      return httpCall({
        fetchImpl,
        endpoint,
        method: "POST",
        routePath: `${INTERNAL_RPC_PREFIX}/${encodeURIComponent(name)}`,
        body: args,
        headers: headers(
          requestOptions?.idempotencyKey ? { "idempotency-key": requestOptions.idempotencyKey } : {}
        ),
        options: requestOptions,
      })
    },
    request(method, routePath, body, requestOptions) {
      return httpCall({
        fetchImpl,
        endpoint,
        method: method.toUpperCase(),
        routePath,
        body,
        headers: headers(),
        options: requestOptions,
      })
    },
  }
}

export interface DeviceTransportOptions {
  endpoint: string
  tenantId: string
  deviceId: string
  privateKeyJwk: JsonWebKey
  /** Pins the host's TLS SubjectPublicKeyInfo when the record carries one. */
  serverFingerprint?: string
  fetchImpl?: TransportFetch
}

/**
 * Device wire. Each request carries a fresh DPoP proof bound to the five-minute
 * access token, so the session is built once and reused across calls rather
 * than re-authenticating per command.
 */
export async function deviceTransport(options: DeviceTransportOptions): Promise<HostTransport> {
  const endpoint = options.endpoint.replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const signer = await signerFromJwk(options.deviceId, options.privateKeyJwk)
  const authContext = new AsyncLocalStorage<AbortSignal>()
  const session = createCompanionSession({
    baseUrl: endpoint,
    tenantId: options.tenantId,
    signer,
    fetchImpl: (input, init) => {
      const signal = authContext.getStore() ?? init?.signal
      signal?.throwIfAborted()
      return fetchImpl(input, { ...init, signal })
    },
  })
  let authentication: { controller: AbortController; waiters: number } | undefined

  async function authorizationHeaders(method: string, routePath: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const shared = (authentication ??= { controller: new AbortController(), waiters: 0 })
    shared.waiters++
    const authorize = () =>
      authContext.run(shared.controller.signal, () =>
        session.authorizationHeaders(method, routePath)
      )
    try {
      try {
        return await untilAborted(authorize(), signal)
      } catch (error) {
        signal.throwIfAborted()
        // A new waiter may encounter the previous group's aborted refresh
        // before the session has cleared it. Retry only that auth-only work.
        if (!isAbortError(error)) throw error
        return await untilAborted(authorize(), signal)
      }
    } finally {
      shared.waiters--
      if (shared.waiters === 0) {
        shared.controller.abort()
        if (authentication === shared) authentication = undefined
      }
    }
  }

  async function call(
    method: string,
    routePath: string,
    body: unknown,
    requestOptions?: RequestOptions,
    extraHeaders: Record<string, string> = {}
  ): Promise<CommandOutcome> {
    const budget = new AbortController()
    const timer = requestOptions?.timeoutMs
      ? setTimeout(() => budget.abort(), requestOptions.timeoutMs)
      : undefined
    const signal = requestOptions?.signal
      ? AbortSignal.any([budget.signal, requestOptions.signal])
      : budget.signal
    try {
      return await authContext.run(signal, async () => {
        signal.throwIfAborted()
        requestOptions = { ...requestOptions, signal }
        let authorization: Record<string, string>
        try {
          // The proof is bound to the method and path, so it is minted per call
          // and cannot be replayed against a different route.
          authorization = await authorizationHeaders(method, routePath, signal)
        } catch (error) {
          signal.throwIfAborted()
          const message = error instanceof Error ? error.message : String(error)
          // The host refusing the device is an auth failure. The token exchange
          // never reaching the host is not: that is the host being unreachable,
          // which the relay fallback (ADR-0224 A4) has to be able to see.
          if (error instanceof CompanionApiError) {
            return { ok: false, cause: "auth", message, status: error.status, code: error.code }
          }
          if (/malformed/.test(message)) return { ok: false, cause: "auth", message }
          return networkFailure(error)
        }
        signal.throwIfAborted()
        const outcome = await httpCall({
          fetchImpl,
          endpoint,
          method,
          routePath,
          body,
          headers: { "content-type": "application/json", ...authorization, ...extraHeaders },
          options: requestOptions,
        })
        // A token that the host no longer accepts is worth exactly one retry with
        // a fresh one. Anything past that is a real authorization problem.
        if (!outcome.ok && outcome.status === 401) {
          session.invalidate()
          const retryAuthorization = await authorizationHeaders(method, routePath, signal).catch(
            () => null
          )
          signal.throwIfAborted()
          if (retryAuthorization) {
            return httpCall({
              fetchImpl,
              endpoint,
              method,
              routePath,
              body,
              headers: {
                "content-type": "application/json",
                ...retryAuthorization,
                ...extraHeaders,
              },
              options: requestOptions,
            })
          }
        }
        return outcome
      })
    } catch (error) {
      return networkFailure(error, signal.aborted)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    wire: "http",
    watch: (watchOptions) =>
      directEvents(
        {
          endpoint,
          fingerprint: options.serverFingerprint,
          ticket: () =>
            call("POST", "/api/auth/socket-ticket", { channel: "events" }, watchOptions),
        },
        watchOptions
      ),
    label: `Cognia Host (${endpoint}, device ${options.deviceId})`,
    execute(name, args = {}, requestOptions) {
      return call(
        "POST",
        `${DEVICE_RPC_PREFIX}/${encodeURIComponent(name)}`,
        args,
        requestOptions,
        requestOptions?.idempotencyKey ? { "idempotency-key": requestOptions.idempotencyKey } : {}
      ).then((outcome) => {
        if (
          !outcome.ok ||
          outcome.accepted ||
          !outcome.result ||
          typeof outcome.result !== "object"
        )
          return outcome
        const body = outcome.result as Record<string, unknown>
        return "requestId" in body && "result" in body
          ? {
              ...outcome,
              result: body.result,
              metadata: { requestId: body.requestId, operationId: body.operationId },
            }
          : outcome
      })
    },
    request(method, routePath, body, requestOptions) {
      return call(method.toUpperCase(), routePath, body, requestOptions)
    },
  }
}

/** Where an accepted command's receipt lives, per wire. */
export function operationPath(wire: HostWire, operationId: string): string {
  const prefix = wire === "internal" ? INTERNAL_OPERATION_PREFIX : DEVICE_OPERATION_PREFIX
  return `${prefix}/${encodeURIComponent(operationId)}`
}

/** The relay half `withRelayFallback` needs. See `./relay-transport.ts`. */
export interface RelayCommandLane {
  watch?: (options: WatchOptions) => Promise<CommandOutcome>
  getOperation?: (operationId: string, options?: RequestOptions) => Promise<CommandOutcome>
  execute(
    name: string,
    args: Record<string, unknown>,
    options?: RequestOptions
  ): Promise<CommandOutcome>
  close(): void
}

/** Whether a direct failure means the host was not reached at all. */
function unreachable(outcome: CommandOutcome): outcome is CommandFailure {
  return !outcome.ok && outcome.cause === "network" && outcome.status === undefined
}

/** A route switch spends the same request budget instead of starting another one. */
function routeAttempts<T extends RequestOptions | undefined>(options: T) {
  const deadline = options?.timeoutMs ? Date.now() + options.timeoutMs : Infinity
  return async (send: (remaining: T) => Promise<CommandOutcome>): Promise<CommandOutcome> => {
    const remaining = deadline - Date.now()
    if (options?.signal?.aborted || remaining <= 0) return networkFailure(undefined, true)
    return send((Number.isFinite(deadline) ? { ...options, timeoutMs: remaining } : options) as T)
  }
}

/**
 * A device transport that falls back to the host's relay room when its
 * address does not answer (ADR-0224 A4). Direct is tried first because it
 * is the shorter path on a LAN or tunnel; once the relay has carried a
 * command, later commands in the same process go there first, so a host that
 * is only reachable through the relay does not cost a failed connection per
 * command.
 *
 * Only commands fall back. `request` is the raw HTTP escape hatch, which has
 * no relay form, so its failure says so instead of pretending.
 */
export function withRelayFallback(direct: HostTransport, relay: RelayCommandLane): HostTransport {
  let relayFirst = false
  return {
    wire: direct.wire,
    watch: async (options) => {
      if (!direct.watch)
        return relay.watch
          ? relay.watch(options)
          : { ok: false, cause: "network", message: "no event route available" }
      let since = options.since
      let emitted = 0
      const watched = {
        ...options,
        reconnects: relay.watch ? 0 : options.reconnects,
        onCursor: (seq: number) => {
          since = seq
          options.onCursor?.(seq)
        },
        onEvent: (event: import("./events").HostEvent) => {
          options.onEvent(event)
          since = event.seq
          emitted++
        },
      }
      const attempt = routeAttempts(watched)
      const outcome = await attempt((remaining) => direct.watch!(remaining))
      return unreachable(outcome) && relay.watch && !options.signal?.aborted
        ? attempt((remaining) =>
            relay.watch!({
              ...options,
              timeoutMs: remaining.timeoutMs,
              since,
              ...(options.maxEvents !== undefined
                ? { maxEvents: Math.max(1, options.maxEvents - emitted) }
                : {}),
            })
          )
        : outcome
    },
    label: `${direct.label}, relay fallback`,
    async execute(name, args = {}, options) {
      const attempt = routeAttempts(options)
      if (relayFirst) {
        const viaRelay = await attempt((remaining) => relay.execute(name, args, remaining))
        if (!unreachable(viaRelay)) return viaRelay
        relayFirst = false
      }
      const viaDirect = await attempt((remaining) => direct.execute(name, args, remaining))
      if (!unreachable(viaDirect)) return viaDirect
      const viaRelay = await attempt((remaining) => relay.execute(name, args, remaining))
      if (!unreachable(viaRelay)) {
        relayFirst = true
        return viaRelay
      }
      return {
        ...viaDirect,
        details: [
          ...(viaDirect.details ?? []),
          `direct: ${viaDirect.message}`,
          `relay: ${viaRelay.message}`,
        ],
        message: "the host answered neither on its address nor through its relay room",
      }
    },
    async request(method, routePath, body, options) {
      const attempt = routeAttempts(options)
      const operationPrefix = operationPath(direct.wire, "")
      if (
        method.toUpperCase() === "GET" &&
        routePath.startsWith(operationPrefix) &&
        relay.getOperation
      ) {
        const id = routePath.slice(operationPrefix.length)
        if (/^[0-9a-f-]{36}$/i.test(id)) {
          if (relayFirst) return attempt((remaining) => relay.getOperation!(id, remaining))
          const outcome = await attempt((remaining) =>
            direct.request(method, routePath, body, remaining)
          )
          return unreachable(outcome)
            ? attempt((remaining) => relay.getOperation!(id, remaining))
            : outcome
        }
      }
      const outcome = await attempt((remaining) =>
        direct.request(method, routePath, body, remaining)
      )
      if (!unreachable(outcome)) return outcome
      return {
        ...outcome,
        details: [
          ...(outcome.details ?? []),
          "commands reach this host through its relay room, but raw HTTP routes have no relay form",
        ],
      }
    },
    close() {
      direct.close?.()
      relay.close()
    },
  }
}
