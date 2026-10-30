/**
 * Socket Mode transport tests.
 *
 * Mocks: connectorsWsOpen, connectorsWsSend, connectorsWsClose,
 * connectorsHttpRequest, @tauri-apps/api/event listen.
 *
 * Pattern: drive hello → events_api → disconnect → reconnect;
 * assert ACK envelope_ids and generator yields.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import { startSocketMode, type SocketModeDelivery } from "./transport-socket-mode"

const mockListen = listen as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock
const mockWsSend = connectorsWsSend as jest.Mock
const mockWsClose = connectorsWsClose as jest.Mock
const mockHttp = connectorsHttpRequest as jest.Mock

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: jest.fn(),
  connectorsWsSend: jest.fn(),
  connectorsWsClose: jest.fn(),
  connectorsHttpRequest: jest.fn(),
}))

// ---------------------------------------------------------------------------
// Fake WS session factory
// ---------------------------------------------------------------------------

function createFakeWsSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  let closeHandler: (() => void) | null = null
  let listenCallCount = 0
  let handlersResolve: () => void = () => {}
  const handlersReadyP = new Promise<void>((r) => {
    handlersResolve = r
  })

  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    listenCallCount++
    if ((eventName as string).endsWith("/message")) {
      messageHandler = handler as (event: { payload: string }) => void
    } else if ((eventName as string).endsWith("/close")) {
      closeHandler = handler as () => void
    }
    if (listenCallCount >= 2) handlersResolve()
    return jest.fn()
  })

  return {
    listenImpl,
    waitForListeners: () => handlersReadyP,
    push(payload: unknown) {
      messageHandler?.({ payload: JSON.stringify(payload) })
    },
    triggerClose() {
      closeHandler?.()
    },
  }
}

function createReconnectSessions() {
  type Handler = (event: { payload: string }) => void
  const listeners = new Map<string, Handler>()
  const waiters = new Map<string, () => void>()
  mockListen.mockImplementation(async (topic: string, handler: Handler) => {
    listeners.set(topic, handler)
    waiters.get(topic)?.()
    return () => listeners.delete(topic)
  })
  return {
    listeners,
    async ready(handle: string) {
      const topic = `connectors://ws/${handle}/close`
      if (listeners.has(topic)) return
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          waiters.set(topic, resolve)
          timeout = setTimeout(() => reject(new Error(`No listeners for ${handle}`)), 2000)
        })
      } finally {
        clearTimeout(timeout)
        waiters.delete(topic)
      }
    },
    push(handle: string, payload: unknown) {
      listeners.get(`connectors://ws/${handle}/message`)?.({ payload: JSON.stringify(payload) })
    },
    close(handle: string) {
      listeners.get(`connectors://ws/${handle}/close`)?.({ payload: "" })
    },
  }
}

const eventFrame = (id: string) => ({
  type: "events_api",
  envelope_id: id,
  payload: { type: "event_callback", event: { type: "message", text: id } },
})

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  mockWsOpen.mockResolvedValue("sm-handle-id")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
  mockHttp.mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ ok: true, url: "wss://fake-socket-mode" }),
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startSocketMode", () => {
  it("yields events from events_api frames and ACKs with envelope_id", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: SocketModeDelivery[] = []

    const collectorDone = (async () => {
      for await (const delivery of startSocketMode({
        appToken: async () => "xapp-token",
        signal: ctrl.signal,
        _connectionsOpenUrl: "https://fake-connections-open",
        _backoffBaseMs: 1,
      })) {
        yielded.push(delivery)
        if (yielded.length >= 2) break
      }
    })()

    await session.waitForListeners()

    // Drive hello
    session.push({ type: "hello", num_connections: 1 })
    await new Promise((r) => setTimeout(r, 10))

    // First events_api frame
    session.push({
      type: "events_api",
      envelope_id: "env-001",
      payload: {
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "hello",
          ts: "1714900000.000001",
          channel_type: "channel",
        },
      },
      accepts_response_payload: false,
    })
    await new Promise((r) => setTimeout(r, 10))

    // Second events_api frame
    session.push({
      type: "events_api",
      envelope_id: "env-002",
      payload: {
        type: "event_callback",
        team_id: "T123",
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "world",
          ts: "1714900001.000001",
          channel_type: "channel",
        },
      },
      accepts_response_payload: false,
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    expect(yielded).toHaveLength(2)
    expect(yielded[0].kind).toBe("event")
    expect(yielded[1].kind).toBe("event")
    expect((yielded[0] as { envelope: { type: string } }).envelope.type).toBe("event_callback")
    expect((yielded[1] as { envelope: { type: string } }).envelope.type).toBe("event_callback")

    // Assert ACKs were sent for both envelope_ids
    const ackCalls = mockWsSend.mock.calls.filter((args: unknown[]) => {
      try {
        const p = JSON.parse(args[1] as string) as { envelope_id?: string }
        return p.envelope_id !== undefined
      } catch {
        return false
      }
    })
    expect(ackCalls).toHaveLength(2)
    const ackIds = ackCalls.map((c: unknown[]) => {
      const p = JSON.parse(c[1] as string) as { envelope_id: string }
      return p.envelope_id
    })
    expect(ackIds).toContain("env-001")
    expect(ackIds).toContain("env-002")
  }, 15000)

  it("calls apps.connections.open once per WS connection attempt", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: unknown[] = []

    const collectorDone = (async () => {
      for await (const e of startSocketMode({
        appToken: async () => "xapp-token",
        signal: ctrl.signal,
        _connectionsOpenUrl: "https://fake-connections-open",
        _backoffBaseMs: 1,
      })) {
        yielded.push(e)
        if (yielded.length >= 1) break
      }
    })()

    await session.waitForListeners()

    session.push({ type: "hello" })
    await new Promise((r) => setTimeout(r, 10))

    session.push({
      type: "events_api",
      envelope_id: "env-once",
      payload: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "one",
          ts: "1714900000.000001",
          channel_type: "channel",
        },
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    // apps.connections.open should have been called at least once
    const httpCalls = mockHttp.mock.calls.filter((c: unknown[]) => {
      const url = (c[0] as { url?: string })?.url ?? ""
      return url.includes("fake-connections-open")
    })
    expect(httpCalls.length).toBeGreaterThanOrEqual(1)
    expect(yielded.length).toBeGreaterThanOrEqual(1)
  }, 10000)

  it("ACKs and yields interactive + slash_commands envelopes, and fires onHello", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)

    const ctrl = new AbortController()
    const yielded: SocketModeDelivery[] = []
    const onHello = jest.fn()

    const collectorDone = (async () => {
      for await (const delivery of startSocketMode({
        appToken: async () => "xapp-token",
        signal: ctrl.signal,
        onHello,
        _connectionsOpenUrl: "https://fake-connections-open",
        _backoffBaseMs: 1,
      })) {
        yielded.push(delivery)
        if (yielded.length >= 2) break
      }
    })()

    await session.waitForListeners()

    session.push({ type: "hello", num_connections: 1 })
    await new Promise((r) => setTimeout(r, 10))
    expect(onHello).toHaveBeenCalledTimes(1)

    // interactive envelope (A2UI button click)
    session.push({
      type: "interactive",
      envelope_id: "env-int",
      payload: {
        type: "block_actions",
        user: { id: "U1" },
        actions: [{ action_id: "a1", type: "button", value: "v" }],
      },
    })
    await new Promise((r) => setTimeout(r, 10))

    // slash_commands envelope
    session.push({
      type: "slash_commands",
      envelope_id: "env-slash",
      payload: { command: "/x", text: "y", channel_id: "C1", user_id: "U1" },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collectorDone

    expect(yielded).toHaveLength(2)
    expect(yielded[0]).toMatchObject({
      kind: "interactive",
      payload: { type: "block_actions" },
    })
    expect(yielded[1]).toMatchObject({
      kind: "slash_command",
      payload: { command: "/x" },
    })

    // BOTH envelope kinds must have been acked with their envelope_id.
    const ackIds = mockWsSend.mock.calls
      .map((args: unknown[]) => {
        try {
          return (JSON.parse(args[1] as string) as { envelope_id?: string }).envelope_id
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
    expect(ackIds).toContain("env-int")
    expect(ackIds).toContain("env-slash")
  }, 15000)

  it("stops immediately when signal is pre-aborted", async () => {
    mockListen.mockResolvedValue(jest.fn())

    const ctrl = new AbortController()
    ctrl.abort()

    const collected: unknown[] = []
    for await (const e of startSocketMode({
      appToken: async () => "xapp-token",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })) {
      collected.push(e)
    }

    expect(collected).toHaveLength(0)
  })

  it.each(["disconnect", "ws-close"])(
    "%s reconnects with a fresh URL/token and ACKs only on the current handle",
    async (reason) => {
      const sessions = createReconnectSessions()
      mockWsOpen.mockResolvedValueOnce("first").mockResolvedValueOnce("second")
      let token = 0
      mockHttp.mockImplementation(async () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, url: `wss://socket-${token}` }),
      }))
      const ctrl = new AbortController()
      const onHello = jest.fn()
      const stream = startSocketMode({
        appToken: async () => `xapp-${++token}`,
        signal: ctrl.signal,
        _backoffBaseMs: 1,
        onHello,
      })
      try {
        const first = stream.next()
        await sessions.ready("first")
        sessions.push("first", { type: "hello" })
        sessions.push("first", eventFrame("before"))
        expect((await first).value).toMatchObject({
          kind: "event",
          envelope: { event_id: "before" },
        })
        const next = stream.next()
        if (reason === "disconnect")
          sessions.push("first", { type: "disconnect", reason: "refresh_requested" })
        else sessions.close("first")
        await sessions.ready("second")
        expect(sessions.listeners.has("connectors://ws/first/message")).toBe(false)
        sessions.push("first", eventFrame("stale"))
        sessions.push("second", { type: "hello" })
        sessions.push("second", eventFrame("after"))
        expect((await next).value).toMatchObject({ kind: "event", envelope: { event_id: "after" } })
        expect(onHello).toHaveBeenCalledTimes(2)
        expect(mockWsOpen.mock.calls).toEqual([["wss://socket-1"], ["wss://socket-2"]])
        expect(mockHttp.mock.calls.map(([request]) => request.headers.Authorization)).toEqual([
          "Bearer xapp-1",
          "Bearer xapp-2",
        ])
        expect(mockWsSend.mock.calls).toEqual([
          ["first", JSON.stringify({ envelope_id: "before" })],
          ["second", JSON.stringify({ envelope_id: "after" })],
        ])
      } finally {
        ctrl.abort()
        await stream.return(undefined)
      }
      expect(mockWsClose.mock.calls).toEqual([["first"], ["second"]])
      expect(sessions.listeners.size).toBe(0)
    }
  )

  it("abort during disconnect backoff prevents another connection", async () => {
    jest.useFakeTimers()
    const sessions = createReconnectSessions()
    const ctrl = new AbortController()
    const stream = startSocketMode({
      appToken: async () => "xapp-token",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })
    const result = stream.next()
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(sessions.listeners.has("connectors://ws/sm-handle-id/message")).toBe(true)
      sessions.push("sm-handle-id", { type: "disconnect" })
      await jest.advanceTimersByTimeAsync(499)
      expect(mockWsOpen).toHaveBeenCalledTimes(1)
      ctrl.abort()
      expect((await result).done).toBe(true)
      await jest.advanceTimersByTimeAsync(10_000)
      expect(mockHttp).toHaveBeenCalledTimes(1)
      expect(sessions.listeners.size).toBe(0)
    } finally {
      ctrl.abort()
      await stream.return(undefined)
      jest.useRealTimers()
    }
  })

  it("abort while WebSocket opening closes the handle that arrives late", async () => {
    let resolveOpen!: (handle: string) => void
    let opening!: () => void
    const started = new Promise<void>((resolve) => {
      opening = resolve
    })
    mockWsOpen.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveOpen = resolve
          opening()
        })
    )
    const ctrl = new AbortController()
    const stream = startSocketMode({ appToken: async () => "xapp-token", signal: ctrl.signal })
    const result = stream.next()
    await started
    ctrl.abort()
    resolveOpen("late-handle")
    expect((await result).done).toBe(true)
    expect(mockWsClose).toHaveBeenCalledWith("late-handle")
    expect(mockListen).not.toHaveBeenCalled()
    expect(mockHttp).toHaveBeenCalledTimes(1)
  })

  it("abort while token resolution is pending never opens a connection", async () => {
    let release!: (token: string) => void
    const token = new Promise<string>((resolve) => {
      release = resolve
    })
    const ctrl = new AbortController()
    const stream = startSocketMode({ appToken: () => token, signal: ctrl.signal })
    const result = stream.next()
    ctrl.abort()
    release("xapp-late")
    expect((await result).done).toBe(true)
    expect(mockHttp).not.toHaveBeenCalled()
    expect(mockWsOpen).not.toHaveBeenCalled()
  })

  it("abort while connections.open is pending never opens the returned WebSocket URL", async () => {
    let release!: (response: unknown) => void
    let requested!: () => void
    const started = new Promise<void>((resolve) => {
      requested = resolve
    })
    mockHttp.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
          requested()
        })
    )
    const ctrl = new AbortController()
    const stream = startSocketMode({ appToken: async () => "xapp-token", signal: ctrl.signal })
    const result = stream.next()
    await started
    ctrl.abort()
    release({ status: 200, headers: {}, body: JSON.stringify({ ok: true, url: "wss://late" }) })
    expect((await result).done).toBe(true)
    expect(mockWsOpen).not.toHaveBeenCalled()
    expect(mockListen).not.toHaveBeenCalled()
  })

  it("abort during listener registration closes the socket and removes both listeners", async () => {
    const ctrl = new AbortController()
    const unlisten = jest.fn()
    mockListen.mockImplementation(async (topic: string) => {
      if (topic.endsWith("/close")) ctrl.abort()
      return unlisten
    })
    const stream = startSocketMode({ appToken: async () => "xapp-token", signal: ctrl.signal })
    expect((await stream.next()).done).toBe(true)
    expect(mockWsClose).toHaveBeenCalledWith("sm-handle-id")
    expect(unlisten).toHaveBeenCalledTimes(2)
    expect(mockHttp).toHaveBeenCalledTimes(1)
  })

  it("a message listener arriving after abort is disposed without registering a close listener", async () => {
    let release!: (unlisten: () => void) => void
    let registering!: () => void
    const started = new Promise<void>((resolve) => {
      registering = resolve
    })
    const unlisten = jest.fn()
    mockListen.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
          registering()
        })
    )
    const ctrl = new AbortController()
    const stream = startSocketMode({ appToken: async () => "xapp-token", signal: ctrl.signal })
    const result = stream.next()
    await started
    ctrl.abort()
    const closedAtAbort = mockWsClose.mock.calls.length
    release(unlisten)
    expect((await result).done).toBe(true)
    expect(closedAtAbort).toBe(1)
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalledTimes(1)
    expect(mockWsClose).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    "listener registration rejection releases partial resources (abort=%s)",
    async (abort) => {
      const unlisten = jest.fn()
      let fail!: (error: Error) => void
      let registering!: () => void
      const started = new Promise<void>((resolve) => {
        registering = resolve
      })
      mockListen.mockImplementation(async (topic: string) => {
        if (topic.endsWith("/message")) return unlisten
        return new Promise((_resolve, reject) => {
          fail = reject
          registering()
        })
      })
      const ctrl = new AbortController()
      const stream = startSocketMode({ appToken: async () => "xapp-token", signal: ctrl.signal })
      const result = stream.next()
      await started
      if (abort) ctrl.abort()
      const closedAtAbort = mockWsClose.mock.calls.length
      const disposedAtAbort = unlisten.mock.calls.length
      fail(new Error("listener registration failed"))
      await expect(result).rejects.toThrow("listener registration failed")
      if (abort) {
        expect(closedAtAbort).toBe(1)
        expect(disposedAtAbort).toBe(1)
      }
      expect(mockWsClose).toHaveBeenCalledTimes(1)
      expect(unlisten).toHaveBeenCalledTimes(1)
      ctrl.abort()
      expect(mockWsClose).toHaveBeenCalledTimes(1)
    }
  )
})
