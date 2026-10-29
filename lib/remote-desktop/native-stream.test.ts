import fixture from "@/crates/cognia-remote-desktop/fixtures/frame-v1.json"
import {
  openNativeFrameStream,
  NATIVE_RECONNECT_MS,
  type NativeFrameStreamDeps,
} from "./native-stream"
import type { RemoteDesktopRawChannel } from "./stream"
import type { RemoteDesktopSessionOpened } from "./types"

class Channel {
  binaryType = "arraybuffer"
  protocol = ""
  readyState = "open"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = jest.fn()
  send = jest.fn()
  deliver(fence = 42) {
    const bytes = Uint8Array.from(Buffer.from(fixture.hex, "hex"))
    new DataView(bytes.buffer).setBigUint64(24, BigInt(fence))
    this.onmessage?.({ data: bytes.buffer } as MessageEvent)
  }
  disconnect() {
    this.onclose?.({} as Event)
  }
}
function setup() {
  const channels: Channel[] = []
  const openSession = jest.fn(async (): Promise<RemoteDesktopSessionOpened> => ({
    sessionId: String(channels.length),
    transport: "companion",
    mode: "view",
    expiresAt: Date.now() + 15_000,
  }))
  const closeSession = jest.fn(async () => undefined)
  const renewSession = jest.fn(async () => ({ expiresAt: Date.now() + 15_000 }))
  const release = jest.fn()
  const openStream = jest.fn(async () => {
    const channel = new Channel()
    channels.push(channel)
    return {
      connection: channel as RemoteDesktopRawChannel,
      close: () => {
        channel.close()
        release()
      },
    }
  })
  const deps: NativeFrameStreamDeps = { openSession, closeSession, renewSession, openStream }
  return { channels, deps, openSession, closeSession, renewSession, release }
}
describe("native frame observation stream", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())
  it("yields latest frames and closes its observation session", async () => {
    const f = setup()
    const stream = await openNativeFrameStream(
      { kind: "remote", hostRef: "host" },
      "sandbox:a",
      {},
      f.deps
    )
    const iterator = stream[Symbol.asyncIterator]()
    f.channels[0]!.deliver(1)
    f.channels[0]!.deliver(2)
    expect((await iterator.next()).value?.fence).toBe(2)
    const next = iterator.next()
    f.channels[0]!.deliver(3)
    expect((await next).value?.fence).toBe(3)
    await jest.advanceTimersByTimeAsync(5000)
    expect(f.renewSession).toHaveBeenCalledTimes(1)
    stream.close()
    expect((await iterator.next()).done).toBe(true)
    expect(f.channels[0]!.close).toHaveBeenCalledTimes(1)
    expect(f.closeSession).toHaveBeenCalledTimes(1)
    expect(f.channels[0]!.send).not.toHaveBeenCalled()
  })
  it("reconnects with backoff and never requests or resumes control", async () => {
    const f = setup()
    const stream = await openNativeFrameStream({ kind: "local" }, "managed-desktop:a", {}, f.deps)
    f.channels[0]!.disconnect()
    await jest.advanceTimersByTimeAsync(NATIVE_RECONNECT_MS[0] - 1)
    expect(f.openSession).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(f.openSession).toHaveBeenCalledTimes(2)
    for (const call of f.openSession.mock.calls as unknown as [unknown, unknown][])
      expect(call[1]).toEqual({
        targetId: "managed-desktop:a",
        bindingId: "native",
        mode: "view",
        takeover: false,
      })
    expect(f.closeSession).toHaveBeenCalledTimes(1)
    f.channels[1]!.disconnect()
    stream.close()
    await jest.advanceTimersByTimeAsync(30_000)
    expect(f.openSession).toHaveBeenCalledTimes(2)
  })
  it("rejects the initial open for the caller's RPC fallback and cleans up", async () => {
    const f = setup()
    f.deps.openStream = jest.fn(async () => {
      throw new Error("cannot attach")
    })
    await expect(openNativeFrameStream({ kind: "local" }, "sandbox:a", {}, f.deps)).rejects.toThrow(
      "cannot attach"
    )
    expect(f.closeSession).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(30_000)
    expect(f.openSession).toHaveBeenCalledTimes(1)
  })
  it("abort closes a pending consumer and cancels backoff", async () => {
    const f = setup()
    const controller = new AbortController()
    const stream = await openNativeFrameStream(
      { kind: "local" },
      "sandbox:a",
      { signal: controller.signal },
      f.deps
    )
    const next = stream[Symbol.asyncIterator]().next()
    f.channels[0]!.disconnect()
    await jest.advanceTimersByTimeAsync(0)
    controller.abort()
    expect((await next).done).toBe(true)
    await jest.advanceTimersByTimeAsync(30_000)
    expect(f.openSession).toHaveBeenCalledTimes(1)
  })
  it("cleans up a session returned after cancellation", async () => {
    const f = setup()
    let resolve!: (session: RemoteDesktopSessionOpened) => void
    f.deps.openSession = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const controller = new AbortController()
    const result = openNativeFrameStream(
      { kind: "local" },
      "sandbox:a",
      { signal: controller.signal },
      f.deps
    )
    controller.abort()
    resolve({ sessionId: "late", transport: "companion", mode: "view", expiresAt: 1 })
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(f.closeSession).toHaveBeenCalledWith({ kind: "local" }, "late")
    expect(f.deps.openStream).not.toHaveBeenCalled()
  })
  it("retains visible JPEG while header-only messages refresh the input proof", async () => {
    const f = setup()
    const stream = await openNativeFrameStream({ kind: "local" }, "sandbox:a", {}, f.deps)
    const iterator = stream[Symbol.asyncIterator]()
    f.channels[0]!.deliver()
    const first = (await iterator.next()).value!
    const bytes = Uint8Array.from(Buffer.from(fixture.unchanged.hex, "hex"))
    new DataView(bytes.buffer).setBigUint64(24, BigInt(99))
    f.channels[0]!.onmessage?.({ data: bytes.buffer } as MessageEvent)
    const next = (await iterator.next()).value!
    expect(next.encoding).toBe("unchanged")
    expect(next.fence).toBe(99)
    expect(next.frameId).toBe(fixture.unchanged.frameId)
    expect(next.capturedAtMs).toBe(fixture.unchanged.capturedAtMs)
    expect(next.jpeg).toBe(first.jpeg)
    expect(next.payloadBytes).toBe(0)
    stream.close()
  })
  it("requires a new JPEG after reconnect, even if old pixels were available", async () => {
    const f = setup()
    const stream = await openNativeFrameStream({ kind: "local" }, "sandbox:a", {}, f.deps)
    const iterator = stream[Symbol.asyncIterator]()
    f.channels[0]!.deliver()
    await iterator.next()
    f.channels[0]!.disconnect()
    await jest.advanceTimersByTimeAsync(500)
    const bytes = Uint8Array.from(Buffer.from(fixture.unchanged.hex, "hex"))
    f.channels[1]!.onmessage?.({ data: bytes.buffer } as MessageEvent)
    await jest.advanceTimersByTimeAsync(0)
    expect(f.channels[1]!.close).toHaveBeenCalledTimes(1)
    stream.close()
  })
  it("abort rejects immediately before a pending session RPC returns", async () => {
    const f = setup()
    let resolve!: (session: RemoteDesktopSessionOpened) => void
    f.deps.openSession = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const controller = new AbortController()
    const result = openNativeFrameStream(
      { kind: "local" },
      "sandbox:a",
      { signal: controller.signal },
      f.deps
    )
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    resolve({ sessionId: "late", transport: "companion", mode: "view", expiresAt: 1 })
    await jest.advanceTimersByTimeAsync(0)
    expect(f.closeSession).toHaveBeenCalledWith({ kind: "local" }, "late")
    expect(f.deps.openStream).not.toHaveBeenCalled()
  })
  it("abort rejects before pending attachment returns and reclaims the late transport", async () => {
    const f = setup()
    let resolve!: (
      value: Awaited<ReturnType<NonNullable<NativeFrameStreamDeps["openStream"]>>>
    ) => void
    f.deps.openStream = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const controller = new AbortController()
    const result = openNativeFrameStream(
      { kind: "local" },
      "sandbox:a",
      { signal: controller.signal },
      f.deps
    )
    await jest.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    const close = jest.fn()
    resolve({ connection: new Channel() as RemoteDesktopRawChannel, close })
    await jest.advanceTimersByTimeAsync(0)
    expect(close).toHaveBeenCalledTimes(1)
    expect(f.closeSession).toHaveBeenCalledTimes(1)
  })
  it("an unresponsive session close does not prevent observation reconnect", async () => {
    const f = setup()
    f.deps.closeSession = jest.fn(() => new Promise<void>(() => undefined))
    const stream = await openNativeFrameStream({ kind: "local" }, "sandbox:a", {}, f.deps)
    f.channels[0]!.disconnect()
    await jest.advanceTimersByTimeAsync(500)
    expect(f.openSession).toHaveBeenCalledTimes(2)
    stream.close()
  })
  it("opens the existing binary WebSocket transport and handles a frame immediately after open", async () => {
    const f = setup()
    const socket = new Channel()
    f.deps.openStream = jest.fn(async () => ({
      connection: "ws://127.0.0.1/rd/existing-ticket",
      close: f.release,
    }))
    f.deps.socket = jest.fn(() => socket as unknown as WebSocket)
    const opening = openNativeFrameStream({ kind: "local" }, "sandbox:a", {}, f.deps)
    await jest.advanceTimersByTimeAsync(0)
    socket.onopen?.({} as Event)
    socket.deliver()
    const stream = await opening
    expect((await stream[Symbol.asyncIterator]().next()).value?.frameId).toBe(fixture.frameId)
    stream.close()
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(f.release).toHaveBeenCalledTimes(1)
  })
})
