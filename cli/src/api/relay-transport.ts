import { channelMatches, type HostEvent, type WatchOptions } from "./events"
/**
 * Commands over a device's relay room (ADR-0224 A4).
 *
 * `cognia-agent host login --invitation 'cgnp4|…'` can pair with a host that
 * only the relay reaches: a Mac mini behind a home router, a VPS with no open
 * port. Registration hands back a relay room of the CLI's own (`rendezvousId`,
 * the signed room descriptor, the device's signaling key), and the host joins
 * it for as long as the pairing lives. Until now the CLI threw that away and
 * sent every later command to the host's address, so a host paired from
 * another network accepted the pairing and then could not be used.
 *
 * This joins that room the way the app's companion transport does when its
 * direct route fails: relay only, no WebRTC negotiation (Node has none), and
 * end-to-end encrypted to the host, so the relay sees only ciphertext. The
 * host authenticates the room against the pairing, so the lane carries the
 * device's own grants and no bearer token.
 *
 * Commands, authenticated operation observations and event subscriptions use
 * the relay. Arbitrary HTTP/file routes still require the direct address.
 */

import { importSigningPrivateKey, type RoomDescriptor } from "@/lib/signaling/crypto"
import { DEFAULT_SIGNALING_URL } from "@/lib/signaling/types"
import { TransportRtc, type TransportRtcOptions } from "@/lib/tauri/transport-rtc"

import type { FailureCause } from "../cli/errors"
import type { CommandOutcome, RequestOptions } from "./transport"

/** What a host record keeps to reach the host through its relay room. */
export interface RelayRouteRecord {
  /** Absent means the public signaling service. */
  signalingUrl?: string
  rendezvousId: string
  roomDescriptor: RoomDescriptor
  signalingPrivateKeyJwk: JsonWebKey
}

/**
 * How long joining the room may take. The host is already subscribed to it,
 * so this is one signaling round trip plus the room's key exchange.
 */
export const RELAY_HANDSHAKE_TIMEOUT_MS = 15_000

export interface RelayCommandChannel {
  watch?: (options: WatchOptions) => Promise<CommandOutcome>
  getOperation?: (operationId: string, options?: RequestOptions) => Promise<CommandOutcome>
  execute: (
    name: string,
    args: Record<string, unknown>,
    options?: RequestOptions
  ) => Promise<CommandOutcome>
  close: () => void
}

export interface RelayCommandChannelOptions {
  route: RelayRouteRecord
  deviceId: string
  handshakeTimeoutMs?: number
  /** Test injection. */
  transportFactory?: (options: TransportRtcOptions) => TransportRtc
}

/**
 * The relay lane answers with the host's own problem codes and no HTTP
 * status, so the cause is read from the code, in the same vocabulary
 * `classifyStatus` uses for the direct wire.
 */
export function classifyRelayCode(code: string | undefined): FailureCause {
  switch (code) {
    case "unknown_command":
      return "unknown-command"
    case "interactive_approval_required":
    case "signed_policy_required":
    case "command_transport_forbidden":
    case "rate_limited":
      return "refused"
    case "device_revoked":
    case "unauthorized":
    case "forbidden":
    case "missing_grant":
      return "auth"
    case "invalid_request":
    case "invalid_params":
    case "validation_failed":
      return "invalid-request"
    case "timeout":
      return "timeout"
    default:
      return "failed"
  }
}

function isHostError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string"
}

/** Join the room lazily, on the first command, and reuse it after that. */
export function relayCommandChannel(options: RelayCommandChannelOptions): RelayCommandChannel {
  const factory = options.transportFactory ?? ((o: TransportRtcOptions) => new TransportRtc(o))
  const timeoutMs = options.handshakeTimeoutMs ?? RELAY_HANDSHAKE_TIMEOUT_MS
  let opening: Promise<TransportRtc> | null = null
  let activeRtc: TransportRtc | undefined
  let closed = false
  let watching: WatchOptions | undefined
  let received: (event: HostEvent) => void = () => {}
  let observeFailure: (outcome: CommandOutcome) => void = () => {}
  let subscribed: (channels: unknown) => void = () => {}

  const closeRoute = () => {
    closed = true
    activeRtc?.close()
  }

  const open = (): Promise<TransportRtc> => {
    opening ??= (async () => {
      const signalingPrivateKey = await importSigningPrivateKey(
        options.route.signalingPrivateKeyJwk
      )
      if (closed) throw new Error("the relay route is closed")
      const rtc = factory({
        signalingUrl: options.route.signalingUrl ?? DEFAULT_SIGNALING_URL,
        rendezvousId: options.route.rendezvousId,
        signalingRoomDescriptor: options.route.roomDescriptor,
        signalingPrivateKey,
        deviceId: options.deviceId,
        role: "mobile",
        // Node has no WebRTC: the relay carrier is the whole route.
        p2p: false,
        atomicEventWatch: Boolean(watching),
        ...(watching
          ? {
              reconnectBackoffMs: Array.from(
                { length: watching.reconnects ?? 3 },
                (_, index) => 250 * 2 ** index
              ),
            }
          : {}),
        initialEventCursor: watching?.since,
        eventObserver: (event) =>
          received({ type: event.event, seq: event.seq, payload: event.payload }),
        subscriptionObserver: (reply) => {
          if (Array.isArray(reply.rejected) && reply.rejected.length)
            observeFailure({ ok: false, cause: "refused", message: "host refused event channels" })
          else subscribed(reply.channels)
        },
        resyncObserver: (notice) =>
          observeFailure({
            ok: false,
            cause: "refused",
            code: "resync_required",
            message: "relay replay has a gap; refresh authoritative state",
            problem: notice,
          }),
        // One process, one session: nothing to resume from storage.
        persistEventCursor: false,
        relayHandshakeTimeoutMs: timeoutMs,
        peerWaitTimeoutMs: timeoutMs,
      })
      activeRtc = rtc
      if (watching) for (const channel of watching.channels) rtc.subscribe(channel, () => {})
      try {
        await rtc.connect()
      } catch (error) {
        rtc.close()
        throw error
      }
      return rtc
    })()
    // A failed join is not cached; the next command tries again.
    opening.catch(() => {
      opening = null
    })
    return opening
  }

  async function bounded(
    options: RequestOptions | undefined,
    send: (rtc: TransportRtc, deadlineAt: number) => Promise<CommandOutcome>
  ): Promise<CommandOutcome> {
    if (closed) return { ok: false, cause: "network", message: "the relay route is closed" }
    if (options?.signal?.aborted)
      return { ok: false, cause: "timeout", message: "relay request stopped" }
    const deadlineAt = Date.now() + (options?.timeoutMs ?? 30000)
    return new Promise((resolve) => {
      let done = false
      const finish = (outcome: CommandOutcome) => {
        if (done) return
        done = true
        clearTimeout(timer)
        options?.signal?.removeEventListener("abort", abort)
        resolve(outcome)
      }
      const abort = () => {
        finish({
          ok: false,
          cause: "timeout",
          message: "relay request stopped or exceeded its budget",
        })
        closeRoute()
      }
      const timer = setTimeout(abort, Math.max(1, deadlineAt - Date.now()))
      options?.signal?.addEventListener("abort", abort, { once: true })
      void open()
        .then(async (rtc) => {
          if (done || options?.signal?.aborted || Date.now() >= deadlineAt) {
            rtc.close()
            return
          }
          finish(await send(rtc, deadlineAt))
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          finish({
            ok: false,
            cause: isHostError(error)
              ? classifyRelayCode(error.code)
              : /timed out/.test(message)
                ? "timeout"
                : "network",
            message,
            ...(isHostError(error) ? { code: error.code } : {}),
            ...(typeof (error as { retryable?: unknown })?.retryable === "boolean"
              ? { retryable: (error as { retryable: boolean }).retryable }
              : {}),
            ...(typeof (error as { retryAfterMs?: unknown })?.retryAfterMs === "number"
              ? { retryAfterMs: (error as { retryAfterMs: number }).retryAfterMs }
              : {}),
          })
        })
    })
  }

  return {
    execute(name, args, requestOptions) {
      return bounded(requestOptions, async (rtc, deadlineAt) => {
        const result = await rtc.call<unknown>(name, args, {
          deadlineAt,
          ...(requestOptions?.idempotencyKey
            ? { idempotencyKey: requestOptions.idempotencyKey }
            : {}),
        })
        const operationId =
          result && typeof result === "object"
            ? (result as { operationId?: unknown }).operationId
            : undefined
        return typeof operationId === "string" &&
          (result as { status?: unknown }).status === "running"
          ? { ok: true, accepted: true, result, operationId }
          : { ok: true, result }
      })
    },
    async watch(options) {
      if (closed) return { ok: false, cause: "network", message: "relay route is closed" }
      watching = options
      return new Promise<CommandOutcome>((resolve) => {
        let done = false
        let count = 0
        let cursor = options.since ?? 0
        let detach: (() => void) | undefined
        const accepted = new Set<string>()
        const finish = (outcome: CommandOutcome) => {
          if (done) return
          done = true
          clearTimeout(timer)
          clearTimeout(ackTimer)
          options.signal?.removeEventListener("abort", abort)
          detach?.()
          closeRoute()
          resolve(outcome)
        }
        observeFailure = finish
        subscribed = (channels) => {
          if (Array.isArray(channels))
            for (const channel of channels) if (typeof channel === "string") accepted.add(channel)
          if (
            options.channels.every((channel) =>
              [...accepted].some((pattern) => channelMatches(pattern, channel))
            )
          )
            clearTimeout(ackTimer)
        }
        received = (event) => {
          if (
            done ||
            !options.channels.some((channel) => channelMatches(channel, event.type)) ||
            event.seq <= cursor
          )
            return
          try {
            options.onEvent(event)
            cursor = event.seq
            count++
          } catch (error) {
            finish({
              ok: false,
              cause: "failed",
              message: error instanceof Error ? error.message : String(error),
            })
            return
          }
          if (options.maxEvents !== undefined && count >= options.maxEvents)
            finish({ ok: true, result: { cursor, count } })
        }
        const abort = () => finish({ ok: false, cause: "timeout", message: "event watch stopped" })
        const timer = setTimeout(abort, options.timeoutMs ?? 30000)
        const ackTimer = setTimeout(
          () =>
            finish({
              ok: false,
              cause: "timeout",
              message: "host did not acknowledge event subscriptions",
            }),
          Math.min(options.timeoutMs ?? 30000, 15000)
        )
        options.signal?.addEventListener("abort", abort, { once: true })
        if (options.signal?.aborted) {
          abort()
          return
        }
        void open()
          .then((rtc) => {
            detach = rtc.onStateChange((state) => {
              if (state === "failed")
                finish({ ok: false, cause: "network", message: "relay event connection failed" })
            })
            if (done) rtc.close()
          })
          .catch((error) =>
            finish({
              ok: false,
              cause: "network",
              message: error instanceof Error ? error.message : String(error),
            })
          )
      })
    },
    getOperation(operationId, options) {
      return bounded(options, async (rtc, deadlineAt) => ({
        ok: true,
        result: await rtc.call(
          "host.operation.get",
          { operationId },
          { controlKind: "operation-get", deadlineAt }
        ),
      }))
    },
    close() {
      closeRoute()
    },
  }
}
