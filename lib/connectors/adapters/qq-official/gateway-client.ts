/**
 * QQ Official Bot gateway WebSocket client.
 *
 * QQ's gateway is modelled on Discord's (same op codes), so this mirrors the
 * Discord gateway client structure, differing only in:
 *   - IDENTIFY token format: `QQBot <access_token>` (token resolved fresh).
 *   - dispatch events: GROUP_AT / C2C / AT / DIRECT message creates + READY.
 *   - intents default covering group/C2C + public guild + direct messages.
 *
 * Inbound frames arrive via Tauri events at `connectors://ws/<id>/message`.
 */

import { connectorListen } from "@/lib/connectors/events"
import { withRequestAbort } from "@/lib/network/request-abort"
import type { AdapterHealth } from "@/types/connectors/adapter"
import { reconnectBackoffMs } from "../_shared/reconnect-backoff"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import { QQ_MESSAGE_EVENTS, QQ_SYSTEM_EVENTS, QQ_AUDIT_EVENTS, type QQDispatch } from "./parse"

const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

/**
 * PUBLIC_GUILD_MESSAGES (1<<30) | GROUP_AND_C2C_EVENT (1<<25) |
 * DIRECT_MESSAGE (1<<12) | INTERACTION (1<<26) = 1174409216.
 */
export const DEFAULT_QQ_INTENTS = (1 << 30) | (1 << 25) | (1 << 12) | (1 << 26) | (1 << 24)

export interface QQGatewayOptions {
  /** Resolves a fresh access token for IDENTIFY (without the `QQBot ` prefix). */
  accessToken: () => Promise<string>
  /** Resolves the gateway URL (GET /gateway) — called once per connect. */
  gatewayUrl: () => Promise<string>
  intents?: number
  signal: AbortSignal
  /**
   * Fired when the platform answers OP 9 INVALID_SESSION (our IDENTIFY /
   * RESUME was rejected). The adapter uses it to evict its cached app token
   * so the reconnect re-mints instead of retrying a rejected credential.
   * Errors are swallowed — the reconnect loop must never die on a callback.
   */
  onAuthInvalid?: () => void | Promise<void>
  onHealth?: (health: AdapterHealth) => void
  _backoffBaseMs?: number
  _handshakeTimeoutMs?: number
}

export interface QQGatewayClient {
  readonly selfId: string
  readonly dispatches: AsyncGenerator<QQDispatch>
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return withRequestAbort(
    signal,
    () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", clear)
          resolve()
        }, ms)
        const clear = () => clearTimeout(timer)
        signal.addEventListener("abort", clear, { once: true })
      })
  )
}

export function startQQGateway(opts: QQGatewayOptions): QQGatewayClient {
  const intents = opts.intents ?? DEFAULT_QQ_INTENTS
  const backoffBaseMs = opts._backoffBaseMs ?? 1000
  const session = { sessionId: null as string | null, sequence: null as number | null }
  let selfId = ""
  let attempts = 0
  const report = (health: AdapterHealth) => {
    if (opts.signal.aborted) return
    try {
      opts.onHealth?.(health)
    } catch {
      /* Observability cannot terminate transport. */
    }
  }

  async function* generate(): AsyncGenerator<QQDispatch> {
    while (!opts.signal.aborted) {
      const attempt = new AbortController()
      const signal = attempt.signal
      const handleId = crypto.randomUUID()
      const queue: string[] = []
      const disposers: Array<() => void> = []
      let wake: (() => void) | undefined
      let disposed = false
      let openStarted = false
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined
      let unackedHeartbeats = 0
      let stage = "QQ gateway discovery failed"
      const active = () => !disposed && !signal.aborted && !opts.signal.aborted
      const cleanup = () => {
        if (disposed) return
        disposed = true
        clearTimeout(handshakeTimer)
        clearTimeout(heartbeatTimer)
        opts.signal.removeEventListener("abort", abort)
        wake = undefined
        for (const unlisten of disposers.splice(0)) {
          try {
            unlisten()
          } catch {
            /* Dispose the remaining listeners as well. */
          }
        }
        if (openStarted) void connectorsWsClose(handleId).catch(() => {})
      }
      const abort = () => attempt.abort(opts.signal.reason)
      signal.addEventListener("abort", cleanup, { once: true })
      const fail = (reason: string, state: AdapterHealth["state"] = "degraded") => {
        if (!active()) return
        report({ state, reason })
        attempt.abort(new Error(reason))
      }
      opts.signal.addEventListener("abort", abort, { once: true })
      if (opts.signal.aborted) abort()
      const subscribe = async <T>(topic: string, callback: (event: { payload: T }) => void) => {
        await withRequestAbort(signal, () =>
          connectorListen<T>(topic, callback).then((unlisten) => {
            if (!active()) unlisten()
            else disposers.push(unlisten)
          })
        )
      }
      const send = (payload: Record<string, unknown>) =>
        withRequestAbort(signal, () => connectorsWsSend(handleId, JSON.stringify(payload)))
      const authenticated = () => {
        if (!active()) return
        clearTimeout(handshakeTimer)
        handshakeTimer = undefined
        attempts = 0
        report({ state: "running" })
      }
      const heartbeat = () => {
        if (!active()) return
        if (unackedHeartbeats >= 2) return fail("QQ gateway heartbeat timed out")
        unackedHeartbeats += 1
        void send({ op: OP_HEARTBEAT, d: session.sequence }).catch(() =>
          fail("QQ gateway heartbeat failed")
        )
      }
      try {
        if (!active()) return
        handshakeTimer = setTimeout(
          () => fail("QQ gateway authentication timed out"),
          opts._handshakeTimeoutMs ?? 15_000
        )
        report({ state: "starting", reason: "QQ gateway awaiting authentication" })
        const url = await withRequestAbort(signal, opts.gatewayUrl)
        stage = "QQ gateway socket connection failed"
        // Native and headless hosts share this preallocated handle. Subscribe
        // before dialing because the first HELLO can precede the open result.
        await subscribe<string>(`connectors://ws/${handleId}/message`, (event) => {
          if (!active()) return
          queue.push(event.payload)
          wake?.()
          wake = undefined
        })
        await subscribe<{ code?: number }>(`connectors://ws/${handleId}/close`, (event) => {
          fail(
            Number.isInteger(event.payload?.code)
              ? `QQ gateway closed (code ${event.payload.code})`
              : "QQ gateway closed"
          )
        })
        await subscribe<string>(`connectors://ws/${handleId}/error`, () =>
          fail("QQ gateway socket error")
        )
        await withRequestAbort(signal, () => {
          openStarted = true
          return connectorsWsOpen(url, undefined, handleId).then((opened) => {
            if (!active() || opened !== handleId) void connectorsWsClose(opened).catch(() => {})
            if (opened !== handleId) throw new Error("Unsupported preallocated WebSocket handle")
          })
        })
        while (active()) {
          if (!queue.length)
            await withRequestAbort(
              signal,
              () =>
                new Promise<void>((resolve) => {
                  wake = resolve
                })
            )
          while (queue.length && active()) {
            let msg: { op: number; d?: unknown; s?: number; t?: string; id?: string }
            try {
              msg = JSON.parse(queue.shift()!)
            } catch {
              continue
            }
            if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue
            if (msg.s !== undefined && msg.s !== null) session.sequence = msg.s
            switch (msg.op) {
              case OP_HELLO: {
                if (!msg.d || typeof msg.d !== "object") break
                const { heartbeat_interval } = msg.d as { heartbeat_interval: number }
                if (!Number.isFinite(heartbeat_interval) || heartbeat_interval <= 0) break
                clearTimeout(heartbeatTimer)
                const tick = () => {
                  heartbeat()
                  if (active()) heartbeatTimer = setTimeout(tick, heartbeat_interval)
                }
                heartbeatTimer = setTimeout(tick, Math.floor(Math.random() * heartbeat_interval))
                try {
                  const token = await withRequestAbort(signal, opts.accessToken)
                  await send(
                    session.sessionId
                      ? {
                          op: OP_RESUME,
                          d: {
                            token: `QQBot ${token}`,
                            session_id: session.sessionId,
                            seq: session.sequence,
                          },
                        }
                      : {
                          op: OP_IDENTIFY,
                          d: { token: `QQBot ${token}`, intents, shard: [0, 1], properties: {} },
                        }
                  )
                } catch {
                  fail("QQ gateway authentication failed")
                }
                break
              }
              case OP_DISPATCH:
                if (msg.t === "READY") {
                  const ready = msg.d as { user?: { id?: string }; session_id?: string }
                  if (!ready || typeof ready !== "object" || !ready.user?.id || !ready.session_id)
                    break
                  selfId = ready.user.id
                  session.sessionId = ready.session_id
                  authenticated()
                } else if (msg.t === "RESUMED") {
                  if (session.sessionId) authenticated()
                } else if (
                  msg.t &&
                  (QQ_MESSAGE_EVENTS.includes(msg.t) ||
                    QQ_SYSTEM_EVENTS.includes(msg.t) ||
                    QQ_AUDIT_EVENTS.includes(msg.t) ||
                    msg.t === "INTERACTION_CREATE")
                ) {
                  yield {
                    t: msg.t,
                    s: msg.s,
                    op: OP_DISPATCH,
                    d: msg.d as QQDispatch["d"],
                    ...(typeof msg.id === "string" ? { id: msg.id } : {}),
                  }
                }
                break
              case OP_RECONNECT:
                fail("QQ gateway reconnect requested", "starting")
                break
              case OP_INVALID_SESSION:
                session.sessionId = null
                session.sequence = null
                try {
                  void Promise.resolve(opts.onAuthInvalid?.()).catch(() => {})
                } catch {
                  /* Cache eviction is best effort. */
                }
                fail("QQ gateway session rejected")
                break
              case OP_HEARTBEAT_ACK:
                unackedHeartbeats = 0
                break
              case OP_HEARTBEAT:
                heartbeat()
                break
            }
          }
        }
      } catch {
        if (active()) fail(stage)
      } finally {
        attempt.abort()
        cleanup()
      }
      if (opts.signal.aborted) return
      attempts += 1
      try {
        await delay(reconnectBackoffMs(backoffBaseMs, attempts), opts.signal)
      } catch {
        return
      }
    }
  }
  return {
    get selfId() {
      return selfId
    },
    dispatches: generate(),
  }
}
