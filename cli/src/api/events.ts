/** Non-TUI event lifecycle: authenticated WSS, bounded reconnect, explicit gaps. */
import { CompanionWorkerTransport } from "../worker/companion-worker-transport"
import type { WorkerWebSocket } from "../worker/worker-connect"
import type { CommandOutcome, RequestOptions } from "./transport"

/** Mirrors the Host catalog: exact names or a trailing-* family prefix. */
export function channelMatches(pattern: string, channel: string): boolean {
  return pattern.endsWith("*") ? channel.startsWith(pattern.slice(0, -1)) : pattern === channel
}

export interface HostEvent {
  type: string
  seq: number
  payload: unknown
}

export interface WatchOptions extends RequestOptions {
  channels: string[]
  since?: number
  maxEvents?: number
  reconnects?: number
  onCursor?: (seq: number) => void
  onEvent: (event: HostEvent) => void
}

export interface DirectEventsOptions {
  endpoint: string
  fingerprint?: string
  serviceToken?: string
  ticket?: () => Promise<CommandOutcome>
  socket?: (url: string, fingerprint?: string) => WorkerWebSocket
}

export async function directEvents(
  host: DirectEventsOptions,
  options: WatchOptions
): Promise<CommandOutcome> {
  const factory =
    host.socket ?? ((url, pin) => new CompanionWorkerTransport().openWebSocket(url, pin))
  let cursor = options.since
  let count = 0
  const deadline = Date.now() + (options.timeoutMs ?? 30000)
  let last: CommandOutcome = { ok: false, cause: "network", message: "event socket closed" }
  for (let attempt = 0; attempt <= (options.reconnects ?? 3); attempt++) {
    if (options.signal?.aborted || Date.now() >= deadline)
      return { ok: false, cause: "timeout", message: "event watch stopped or timed out" }
    const url = new URL(host.serviceToken ? "/internal/events" : "/ws/events", host.endpoint)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.searchParams.set("channels", options.channels.join(","))
    if (cursor !== undefined) url.searchParams.set("since", String(cursor))
    if (host.serviceToken) url.searchParams.set("token", host.serviceToken)
    else {
      const ticket = await host.ticket?.()
      if (!ticket?.ok)
        return ticket ?? { ok: false, cause: "auth", message: "event socket needs a device ticket" }
      const value = (ticket.result as { ticket?: unknown })?.ticket
      if (typeof value !== "string")
        return { ok: false, cause: "failed", message: "host returned an invalid event ticket" }
      url.searchParams.set("ticket", value)
    }
    last = await new Promise<CommandOutcome>((resolve) => {
      const socket = factory(url.toString(), host.fingerprint)
      let settled = false
      const finish = (outcome: CommandOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", abort)
        socket.close()
        resolve(outcome)
      }
      const abort = () => finish({ ok: false, cause: "timeout", message: "event watch stopped" })
      const timer = setTimeout(
        () => finish({ ok: false, cause: "timeout", message: "event watch total timeout elapsed" }),
        Math.max(1, deadline - Date.now())
      )
      const frame = (value: unknown): void => {
        if (settled) return
        if (!value || typeof value !== "object") throw new Error("invalid event frame")
        const event = value as Record<string, unknown>
        if (event.type === "ping") {
          socket.send(JSON.stringify({ type: "pong" }))
          return
        }
        if (event.type === "resync_required" || event.type === "subscribe_error") {
          finish({
            ok: false,
            cause: "refused",
            code: String(event.type),
            message:
              "event replay has a gap or its subscription was refused; refresh authoritative state",
            problem: event,
          })
          return
        }
        if (event.type === "subscribed") {
          if (Array.isArray(event.rejected) && event.rejected.length)
            finish({
              ok: false,
              cause: "refused",
              message: "host refused event channels",
              problem: event,
            })
          return
        }
        if (event.type === "event_batch") {
          if (!Array.isArray(event.frames)) throw new Error("invalid event batch")
          event.frames.forEach(frame)
          return
        }
        if (event.type === "stream_ready") {
          if (Number.isSafeInteger(event.cursor) && (event.cursor as number) >= 0) {
            cursor = Math.max(cursor ?? 0, event.cursor as number)
            options.onCursor?.(cursor)
          }
          return
        }
        if (
          !Number.isSafeInteger(event.seq) ||
          (event.seq as number) < 0 ||
          typeof event.type !== "string"
        )
          throw new Error("invalid event sequence or channel")
        if (
          (cursor !== undefined && (event.seq as number) <= cursor) ||
          !options.channels.some((channel) => channelMatches(channel, event.type as string))
        )
          return
        options.onEvent({ type: event.type, seq: event.seq as number, payload: event.payload })
        cursor = event.seq as number
        options.onCursor?.(cursor)
        count++
        if (options.maxEvents !== undefined && count >= options.maxEvents)
          finish({ ok: true, result: { cursor, count } })
      }
      socket.addEventListener("message", (event) => {
        try {
          frame(JSON.parse(String(event.data)))
        } catch (error) {
          finish({
            ok: false,
            cause: "failed",
            message: error instanceof Error ? error.message : "invalid event frame",
          })
        }
      })
      socket.addEventListener("open", () =>
        socket.send(
          JSON.stringify({ type: "subscribe", mode: "replace", channels: options.channels })
        )
      )
      socket.addEventListener("close", () =>
        finish({ ok: false, cause: "network", message: "event socket disconnected" })
      )
      socket.addEventListener("error", () =>
        finish({ ok: false, cause: "network", message: "event socket failed" })
      )
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
    })
    if (last.ok || last.cause !== "network") return last
    if (attempt < (options.reconnects ?? 3))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          done,
          Math.min(250 * 2 ** attempt, Math.max(0, deadline - Date.now()))
        )
        function done() {
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", done)
          resolve()
        }
        options.signal?.addEventListener("abort", done, { once: true })
      })
  }
  return last
}
