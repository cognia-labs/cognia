/** Observation-only native stream. Opening/reconnecting never acquires control;
 * input keeps using the native lease RPC and each yielded frame's proof.
 */
import {
  closeRemoteDesktopSession,
  openRemoteDesktopSession,
  renewRemoteDesktopSession,
  REMOTE_DESKTOP_RENEW_MS,
  RemoteDesktopError,
} from "./host-client"
import { NativeFrameDecoder, type NativeFrame } from "./frames"
import {
  openRemoteDesktopStream,
  type RemoteDesktopRawChannel,
  type RemoteDesktopStream,
} from "./stream"
import type { RemoteDesktopHostRef } from "./types"

export const NATIVE_OPEN_TIMEOUT_MS = 15_000
export const NATIVE_RECONNECT_MS = [500, 1000, 2000, 4000, 8000] as const
/** Every yielded value includes the current JPEG, including header-only ticks.
 * Compare jpeg identity to avoid decoding unchanged pixels; always update proof.
 */
export interface NativeFrameStream extends AsyncIterable<NativeFrame> {
  close(): void
}
export interface NativeFrameStreamOptions {
  signal?: AbortSignal
  onReconnect?: (attempt: number, error: unknown) => void
}
export interface NativeFrameStreamDeps {
  openSession?: typeof openRemoteDesktopSession
  renewSession?: typeof renewRemoteDesktopSession
  closeSession?: typeof closeRemoteDesktopSession
  openStream?: typeof openRemoteDesktopStream
  socket?: (url: string) => WebSocket
}
type Channel = WebSocket | RemoteDesktopRawChannel

interface LiveConnection {
  ended: Promise<unknown>
  close(): void
}
function lost(): RemoteDesktopError {
  return new RemoteDesktopError("remote_desktop_connection_lost")
}
function abortError(): Error {
  return new DOMException("Aborted", "AbortError")
}

/** Cancellation rejects promptly even when RPC/transport cannot be canceled.
 * A late response is still reclaimed; a dead Host never gates local cleanup.
 */
function interruptible<T>(
  work: Promise<T>,
  signal: AbortSignal,
  reclaim: (value: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const onAbort = () => finish(abortError())
    const timer = setTimeout(() => finish(lost()), NATIVE_OPEN_TIMEOUT_MS)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
    void work.then(
      (value) => {
        if (settled) reclaim(value)
        else finish(undefined, value)
      },
      (error: unknown) => finish(error instanceof Error ? error : lost())
    )
  })
}

/** Initial open rejects so a viewer can fall back to its existing frame RPC.
 * After opening, observation reconnects with bounded exponential backoff.
 * `close`/AbortSignal cancels reconnect, renewal, transport and broker session.
 * The async iterator holds only the newest undelivered decoded frame.
 */
export async function openNativeFrameStream(
  host: RemoteDesktopHostRef,
  targetId: `sandbox:${string}` | `managed-desktop:${string}`,
  options: NativeFrameStreamOptions = {},
  deps: NativeFrameStreamDeps = {}
): Promise<NativeFrameStream> {
  if (!/^(sandbox|managed-desktop):.+$/.test(targetId))
    throw new RemoteDesktopError("remote_desktop_frame_invalid")
  const controller = new AbortController()
  const { signal } = controller
  let latest: NativeFrame | undefined
  let pending: ((result: IteratorResult<NativeFrame>) => void) | undefined
  let live: LiveConnection | undefined
  let stopped = false
  const close = () => {
    if (stopped) return
    stopped = true
    controller.abort()
    options.signal?.removeEventListener("abort", close)
    latest = undefined
    pending?.({ done: true, value: undefined })
    pending = undefined
    void live?.close()
  }
  if (options.signal?.aborted) throw abortError()
  options.signal?.addEventListener("abort", close, { once: true })
  const deliver = (frame: NativeFrame) => {
    if (stopped) return
    if (pending) {
      const resolve = pending
      pending = undefined
      resolve({ done: false, value: frame })
    } else latest = frame
  }
  const connect = async (): Promise<LiveConnection> => {
    if (stopped) throw abortError()
    const closeSession = (sessionId: string) => {
      void (deps.closeSession ?? closeRemoteDesktopSession)(host, sessionId).catch(() => undefined)
    }
    const session = await interruptible(
      (deps.openSession ?? openRemoteDesktopSession)(host, {
        targetId,
        bindingId: "native",
        mode: "view",
        takeover: false,
      }),
      signal,
      (late) => closeSession(late.sessionId)
    )
    let transport: RemoteDesktopStream | undefined
    let channel: Channel | undefined
    let renewTimer: ReturnType<typeof setInterval> | undefined
    let cleaned = false
    let end!: (error: unknown) => void
    const ended = new Promise<unknown>((resolve) => {
      end = resolve
    })
    let socket: WebSocket | undefined
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      if (renewTimer) clearInterval(renewTimer)
      signal.removeEventListener("abort", onAbort)
      if (socket) socket.onopen = null
      if (channel) {
        channel.onmessage = null
        channel.onclose = null
        channel.onerror = null
        try {
          socket?.close()
        } catch {
          /* Already closed. */
        }
      }
      try {
        transport?.close()
      } catch {
        /* Continue session cleanup. */
      }
      end(lost())
      closeSession(session.sessionId)
    }
    const onAbort = () => cleanup()
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      if (stopped) throw abortError()
      // Defend against a mismatched/older Host returning control authority.
      if (session.mode !== "view" || session.lease)
        throw new RemoteDesktopError("remote_desktop_protocol_invalid")
      transport = await interruptible(
        (deps.openStream ?? openRemoteDesktopStream)(host, session),
        signal,
        (late) => late.close()
      )
      if (stopped) {
        transport.close()
        throw abortError()
      }
      const decoder = new NativeFrameDecoder()
      let pixels: NativeFrame | undefined
      if (typeof transport.connection === "string") {
        const ws = (deps.socket ?? ((url) => new WebSocket(url, ["binary"])))(transport.connection)
        socket = ws
        channel = ws
        await interruptible(
          new Promise<void>((resolve, reject) => {
            ws.binaryType = "arraybuffer"
            ws.onmessage = receive
            ws.onopen = () => {
              ws.onopen = null
              resolve()
            }
            ws.onclose = () => reject(lost())
            ws.onerror = () => reject(lost())
          }),
          signal,
          () => undefined
        )
      } else channel = transport.connection
      function receive(event: MessageEvent) {
        try {
          if (!(event.data instanceof ArrayBuffer))
            throw new RemoteDesktopError("remote_desktop_protocol_invalid")
          for (const frame of decoder.push(new Uint8Array(event.data))) {
            if (frame.encoding === "jpeg") pixels = frame
            else if (!pixels || pixels.width !== frame.width || pixels.height !== frame.height) {
              throw new RemoteDesktopError("remote_desktop_frame_invalid")
            }
            // Header-only refreshes update the proof while retaining visible pixels.
            deliver({ ...frame, jpeg: pixels!.jpeg })
          }
        } catch (error) {
          end(error)
        }
      }
      if (stopped) throw abortError()
      channel.binaryType = "arraybuffer"
      channel.onmessage = receive
      channel.onclose = () => {
        try {
          decoder.finish()
          end(lost())
        } catch (error) {
          end(error)
        }
      }
      channel.onerror = () => end(lost())
      let renewing = false
      renewTimer = setInterval(() => {
        if (renewing || stopped) return
        renewing = true
        void (deps.renewSession ?? renewRemoteDesktopSession)(host, session.sessionId)
          .catch((error: unknown) => end(error))
          .finally(() => {
            renewing = false
          })
      }, REMOTE_DESKTOP_RENEW_MS)
      return { ended, close: cleanup }
    } catch (error) {
      cleanup()
      throw error
    }
  }
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal.addEventListener("abort", done, { once: true })
      if (stopped) done()
    })
  try {
    live = await connect()
  } catch (error) {
    close()
    throw error
  }
  const first = live
  void (async () => {
    let current = first
    let attempt = 0
    while (!stopped) {
      const error = await current.ended
      latest = undefined
      current.close()
      if (stopped) return
      while (!stopped) {
        attempt += 1
        options.onReconnect?.(attempt, error)
        await delay(NATIVE_RECONNECT_MS[Math.min(attempt - 1, NATIVE_RECONNECT_MS.length - 1)]!)
        if (stopped) return
        try {
          current = await connect()
          live = current
          break
        } catch {
          /* Retry observation only. */
        }
      }
    }
  })().catch(close)
  let iterated = false
  return {
    close,
    [Symbol.asyncIterator]() {
      if (iterated) throw new Error("Native frame stream supports one consumer")
      iterated = true
      return {
        next: () => {
          if (stopped) return Promise.resolve({ done: true as const, value: undefined })
          if (latest) {
            const frame = latest
            latest = undefined
            return Promise.resolve({ done: false as const, value: frame })
          }
          return new Promise<IteratorResult<NativeFrame>>((resolve) => {
            pending = resolve
          })
        },
        return: async () => {
          close()
          return { done: true as const, value: undefined }
        },
      }
    },
  }
}
