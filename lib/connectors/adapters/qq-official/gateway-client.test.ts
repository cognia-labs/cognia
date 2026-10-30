/**
 * QQ gateway client tests — mirror the Discord harness: mock the Tauri WS
 * passthrough + @tauri-apps/api/event, then drive HELLO → IDENTIFY → READY →
 * GROUP_AT_MESSAGE_CREATE and assert the generator yields the dispatch.
 */

import { listen } from "@tauri-apps/api/event"
import {
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
} from "@/lib/connectors/tauri/commands"
import { DEFAULT_QQ_INTENTS, startQQGateway } from "./gateway-client"

const mockListen = listen as jest.Mock
const mockWsOpen = connectorsWsOpen as jest.Mock
const mockWsSend = connectorsWsSend as jest.Mock
const mockWsClose = connectorsWsClose as jest.Mock

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsWsOpen: jest.fn(),
  connectorsWsSend: jest.fn(),
  connectorsWsClose: jest.fn(),
}))

function createFakeWsSession() {
  let messageHandler: ((event: { payload: string }) => void) | null = null
  const handlers = new Map<string, (event: { payload: unknown }) => void>()
  const unlisten = jest.fn()
  let count = 0
  let resolve: () => void = () => {}
  const ready = new Promise<void>((r) => {
    resolve = r
  })
  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    handlers.set(eventName.split("/").at(-1)!, handler as (event: { payload: unknown }) => void)
    count += 1
    if (eventName.endsWith("/message")) messageHandler = handler as (e: { payload: string }) => void
    if (count >= 2) resolve()
    return unlisten
  })
  return {
    listenImpl,
    waitForListeners: () => ready,
    push: (payload: unknown) => messageHandler?.({ payload: JSON.stringify(payload) }),
    close: (payload: unknown) => handlers.get("close")?.({ payload }),
    unlisten,
  }
}

/**
 * Reconnect-aware harness: tracks one message handler per WS connection so a
 * test can drive HELLO/READY frames on the first connection, force it to end,
 * and then talk to the second connection.
 */
function createMultiWsSessions() {
  const handlers: Array<(event: { payload: string }) => void> = []
  const closes: Array<(event: { payload: { code: number } }) => void> = []
  let waiters: Array<{ count: number; resolve: () => void }> = []
  const listenImpl = jest.fn().mockImplementation(async (eventName: string, handler: unknown) => {
    if (eventName.endsWith("/close"))
      closes.push(handler as (event: { payload: { code: number } }) => void)
    if (eventName.endsWith("/message")) {
      handlers.push(handler as (e: { payload: string }) => void)
      waiters = waiters.filter((w) => {
        if (handlers.length >= w.count) {
          w.resolve()
          return false
        }
        return true
      })
    }
    return jest.fn()
  })
  return {
    listenImpl,
    /** Resolves once the n-th connection has registered its message listener. */
    waitForConnection: (n: number) =>
      new Promise<void>((resolve) => {
        if (handlers.length >= n) {
          resolve()
          return
        }
        waiters.push({ count: n, resolve })
      }),
    /** Push a frame to the n-th (1-indexed) connection. */
    push: (n: number, payload: unknown) => handlers[n - 1]?.({ payload: JSON.stringify(payload) }),
    close: (n: number, code: number) => closes[n - 1]?.({ payload: { code } }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockWsOpen.mockImplementation(async (_url, _headers, handleId) => handleId ?? "qq-ws-1")
  mockWsSend.mockResolvedValue(undefined)
  mockWsClose.mockResolvedValue(undefined)
})

describe("startQQGateway", () => {
  it("answers a server-requested heartbeat with the latest sequence", async () => {
    const random = jest.spyOn(Math, "random").mockReturnValue(0.5)
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
    })
    const collector = (async () => {
      for await (const dispatch of client.dispatches) void dispatch
    })()
    try {
      await session.waitForListeners()
      session.push({ op: 10, d: { heartbeat_interval: 100000 } })
      session.push({ op: 0, s: 17, t: "READY", d: { user: { id: "bot" }, session_id: "session" } })
      session.push({ op: 1 })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      ctrl.abort()
      await collector
      random.mockRestore()
    }
    expect(
      mockWsSend.mock.calls.map((call) => JSON.parse(call[1])).filter((payload) => payload.op === 1)
    ).toEqual([{ op: 1, d: 17 }])
  })

  it("closes immediately when aborted while its consumer holds a dispatch", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
    })
    const received = client.dispatches.next()
    await session.waitForListeners()
    session.push({ op: 10, d: { heartbeat_interval: 100000 } })
    session.push({ op: 0, t: "READY", d: { user: { id: "bot" }, session_id: "session" } })
    session.push({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "held" } })
    await received
    ctrl.abort()
    try {
      expect(mockWsClose).toHaveBeenCalled()
      expect(session.unlisten).toHaveBeenCalledTimes(3)
    } finally {
      await client.dispatches.return(undefined)
    }
  })

  it("keeps abort listeners bounded through repeated discovery failures", async () => {
    const ctrl = new AbortController()
    const added = jest.spyOn(ctrl.signal, "addEventListener")
    const removed = jest.spyOn(ctrl.signal, "removeEventListener")
    let reached!: () => void
    const ready = new Promise<void>((resolve) => {
      reached = resolve
    })
    let calls = 0
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
      gatewayUrl: async () => {
        calls += 1
        if (calls < 6) throw new Error("discovery offline")
        reached()
        return new Promise<string>(() => {})
      },
    })
    const collector = (async () => {
      for await (const dispatch of client.dispatches) void dispatch
    })()
    let retained = 0
    try {
      await ready
      retained =
        added.mock.calls.filter(([type]) => type === "abort").length -
        removed.mock.calls.filter(([type]) => type === "abort").length
    } finally {
      ctrl.abort()
      await collector
      added.mockRestore()
      removed.mockRestore()
    }
    expect(calls).toBe(6)
    expect(retained).toBeLessThanOrEqual(2)
  })

  it.each(["discovery", "open", "token", "identify"])(
    "bounds a never-resolving %s operation",
    async (stage) => {
      const session = createFakeWsSession()
      mockListen.mockImplementation(session.listenImpl)
      const onHealth = jest.fn()
      const ctrl = new AbortController()
      const stuck = () => new Promise<never>(() => {})
      if (stage === "open") mockWsOpen.mockImplementation(stuck)
      if (stage === "identify") mockWsSend.mockImplementation(stuck)
      const client = startQQGateway({
        accessToken: stage === "token" ? stuck : async () => "TOKEN",
        gatewayUrl: stage === "discovery" ? stuck : async () => "wss://fake",
        signal: ctrl.signal,
        onHealth,
        _handshakeTimeoutMs: 10,
        _backoffBaseMs: 1000,
      })
      const collector = (async () => {
        for await (const dispatch of client.dispatches) void dispatch
      })()
      try {
        if (stage !== "discovery") {
          await session.waitForListeners()
          session.push({ op: 10, d: { heartbeat_interval: 100000 } })
        }
        await new Promise((resolve) => setTimeout(resolve, 30))
      } finally {
        ctrl.abort()
        await collector
      }
      expect(onHealth).toHaveBeenCalledWith({
        state: "degraded",
        reason: "QQ gateway authentication timed out",
      })
      expect(session.unlisten).toHaveBeenCalledTimes(stage === "discovery" ? 0 : 3)
    }
  )

  it("fences a previous socket's queued close after the next READY", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()
    const onHealth = jest.fn()
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      onHealth,
      _backoffBaseMs: 1,
    })
    const collector = (async () => {
      for await (const dispatch of client.dispatches) void dispatch
    })()
    try {
      await sessions.waitForConnection(1)
      sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
      sessions.push(1, { op: 0, t: "READY", d: { user: { id: "bot" }, session_id: "session" } })
      sessions.push(1, { op: 7 })
      await sessions.waitForConnection(2)
      sessions.push(2, { op: 10, d: { heartbeat_interval: 100000 } })
      sessions.push(2, { op: 0, t: "RESUMED" })
      await new Promise((resolve) => setTimeout(resolve, 0))
      sessions.close(1, 4004)
    } finally {
      ctrl.abort()
      await collector
    }
    expect(onHealth.mock.calls.at(-1)?.[0]).toEqual({ state: "running" })
  })

  it.each(["READY", "RESUMED"])("clears authentication deadline after %s", async (event) => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()
    const onHealth = jest.fn()
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      onHealth,
      _handshakeTimeoutMs: 30,
      _backoffBaseMs: 1,
    })
    const out: unknown[] = []
    const collector = (async () => {
      for await (const dispatch of client.dispatches) out.push(dispatch)
    })()
    try {
      await sessions.waitForConnection(1)
      sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
      sessions.push(1, { op: 0, t: "READY", d: { user: { id: "bot" }, session_id: "session" } })
      if (event === "RESUMED") {
        sessions.push(1, { op: 7 })
        await sessions.waitForConnection(2)
        sessions.push(2, { op: 10, d: { heartbeat_interval: 100000 } })
        sessions.push(2, { op: 0, t: "RESUMED" })
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
      sessions.push(event === "RESUMED" ? 2 : 1, {
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: { id: "after-deadline" },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      ctrl.abort()
      await collector
    }
    expect(
      onHealth.mock.calls.some(
        ([health]) => health.reason === "QQ gateway authentication timed out"
      )
    ).toBe(false)
    expect(out).toHaveLength(1)
    expect(mockWsOpen).toHaveBeenCalledTimes(event === "RESUMED" ? 2 : 1)
  })

  it.each(["subscribe", "open"])(
    "disposes registrations after %s failure and reconnects",
    async (stage) => {
      const session = createFakeWsSession()
      const disposable = jest.fn()
      if (stage === "subscribe")
        mockListen
          .mockResolvedValueOnce(disposable)
          .mockRejectedValueOnce(new Error("private failure"))
      else mockWsOpen.mockRejectedValueOnce(new Error("private failure"))
      mockListen.mockImplementation(session.listenImpl)
      const ctrl = new AbortController()
      const onHealth = jest.fn()
      let connected!: () => void
      const ready = new Promise<void>((resolve) => {
        connected = resolve
      })
      mockWsOpen.mockImplementation(async (_url, _headers, handle) => {
        connected()
        return handle
      })
      const client = startQQGateway({
        accessToken: async () => "TOKEN",
        gatewayUrl: async () => "wss://fake",
        signal: ctrl.signal,
        onHealth,
        _backoffBaseMs: 1,
      })
      const collector = (async () => {
        for await (const dispatch of client.dispatches) void dispatch
      })()
      try {
        await ready
      } finally {
        ctrl.abort()
        await collector
      }
      if (stage === "subscribe") expect(disposable).toHaveBeenCalledTimes(1)
      else expect(session.unlisten).toHaveBeenCalledTimes(6)
      expect(mockWsSend).not.toHaveBeenCalled()
      expect(JSON.stringify(onHealth.mock.calls)).not.toContain("private failure")
      const topics = mockListen.mock.calls
        .filter(([name]) => name.endsWith("/message"))
        .map(([name]) => name)
      expect(new Set(topics).size).toBe(2)
    }
  )

  it.each([false, true])(
    "times out an unauthenticated socket (HELLO received: %s)",
    async (hello) => {
      const sessions = createMultiWsSessions()
      mockListen.mockImplementation(sessions.listenImpl)
      const onHealth = jest.fn()
      const ctrl = new AbortController()
      const client = startQQGateway({
        accessToken: async () => "TOKEN",
        gatewayUrl: async () => "wss://fake",
        signal: ctrl.signal,
        onHealth,
        _handshakeTimeoutMs: 5,
        _backoffBaseMs: 1,
      })
      const collector = (async () => {
        for await (const dispatch of client.dispatches) void dispatch
      })()
      try {
        await sessions.waitForConnection(1)
        if (hello) sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
        await sessions.waitForConnection(2)
      } finally {
        ctrl.abort()
        await collector
      }
      expect(onHealth).toHaveBeenCalledWith({
        state: "degraded",
        reason: "QQ gateway authentication timed out",
      })
      expect(onHealth).not.toHaveBeenCalledWith({ state: "running" })
      expect(mockWsClose).toHaveBeenCalled()
    }
  )

  it("reports running only after READY and sanitizes remote close details", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const onHealth = jest.fn()
    const ctrl = new AbortController()
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      onHealth,
    })
    const collector = (async () => {
      for await (const dispatch of client.dispatches) void dispatch
    })()
    let prematurelyRunning = false
    try {
      await session.waitForListeners()
      session.push({ op: 10, d: { heartbeat_interval: 100000 } })
      session.push({ op: 11 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      prematurelyRunning = onHealth.mock.calls.some(([health]) => health.state === "running")
      session.push({ op: 0, t: "READY", d: { user: { id: "bot" }, session_id: "session" } })
      await new Promise((resolve) => setTimeout(resolve, 0))
      session.close({ code: 4004, reason: "private provider detail TOKEN" })
    } finally {
      ctrl.abort()
      await collector
    }
    expect(prematurelyRunning).toBe(false)
    expect(onHealth).toHaveBeenCalledWith({ state: "running" })
    expect(onHealth).toHaveBeenCalledWith({
      state: "degraded",
      reason: "QQ gateway closed (code 4004)",
    })
    expect(JSON.stringify(onHealth.mock.calls)).not.toContain("TOKEN")
    expect(session.unlisten).toHaveBeenCalledTimes(3)
  })

  it("closes a late native open after cancellation and disposes all subscriptions", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    let opened!: () => void
    const entered = new Promise<void>((resolve) => {
      opened = resolve
    })
    let release!: (handle: string) => void
    mockWsOpen.mockImplementation(() => {
      opened()
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const ctrl = new AbortController()
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
    })
    const collector = (async () => {
      for await (const dispatch of client.dispatches) void dispatch
    })()
    await entered
    ctrl.abort()
    const handle = mockWsOpen.mock.calls[0][2]
    release(handle)
    await collector
    expect(mockWsClose).toHaveBeenCalledWith(handle)
    expect(mockWsSend).not.toHaveBeenCalled()
    expect(session.unlisten).toHaveBeenCalledTimes(3)
  })

  it("identifies when native HELLO arrives before open returns", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    mockWsOpen.mockImplementation(async (_url, _headers, handleId) => {
      session.push({ op: 10, d: { heartbeat_interval: 100000 } })
      return handleId ?? "qq-early"
    })
    const ctrl = new AbortController()
    const client = startQQGateway({
      accessToken: async () => "TOKEN",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
    })
    const collector = (async () => {
      for await (const dispatch of client.dispatches) void dispatch
    })()
    await session.waitForListeners()
    await new Promise((resolve) => setTimeout(resolve, 0))
    ctrl.abort()
    await collector
    expect(mockWsSend.mock.calls.some((call) => JSON.parse(call[1]).op === 2)).toBe(true)
  })

  it("forwards full group and private-guild events to the common parser", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    const client = startQQGateway({
      accessToken: async () => "token",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
    })
    const out: string[] = []
    const collector = (async () => {
      for await (const message of client.dispatches) {
        out.push(message.t)
        if (out.length === 2) ctrl.abort()
      }
    })()
    await session.waitForListeners()
    for (const t of ["GROUP_MESSAGE_CREATE", "MESSAGE_CREATE"])
      session.push({ op: 0, t, d: { id: t } })
    await collector
    expect(out).toEqual(["GROUP_MESSAGE_CREATE", "MESSAGE_CREATE"])
  })

  it.each([
    "GROUP_AT_MESSAGE_CREATE",
    "INTERACTION_CREATE",
    "GROUP_JOIN_REQUEST",
    "C2C_MSG_RECEIVE",
    "MESSAGE_AUDIT_PASS",
    "MESSAGE_AUDIT_REJECT",
  ])(
    "identifies and forwards %s dispatches",
    async (eventType) => {
      const session = createFakeWsSession()
      mockListen.mockImplementation(session.listenImpl)
      const ctrl = new AbortController()

      const client = startQQGateway({
        accessToken: async () => "ACCESS_TOKEN",
        gatewayUrl: async () => "wss://fake",
        signal: ctrl.signal,
        _backoffBaseMs: 1,
      })

      const out: Array<{ t: string }> = []
      const collector = (async () => {
        for await (const d of client.dispatches) {
          out.push(d)
          if (out.length >= 2) break
        }
      })()

      await session.waitForListeners()
      session.push(null)
      session.push([])
      session.push({ op: 10, d: null })
      session.push({ op: 0, t: "READY", d: null })
      session.push({ op: 10, d: { heartbeat_interval: 100000 } })
      await new Promise((r) => setTimeout(r, 20))
      session.push({ op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s1" } })
      await new Promise((r) => setTimeout(r, 10))
      session.push({
        op: 0,
        id: "outer-event",
        t: eventType,
        s: 2,
        d: { id: "m1", content: "hi", group_openid: "GO" },
      })
      session.push({
        op: 0,
        t: "PUBLIC_MESSAGE_DELETE",
        s: 3,
        d: { message: { id: "parent", channel_id: "channel" }, op_user: { id: "moderator" } },
      })
      await new Promise((r) => setTimeout(r, 20))

      ctrl.abort()
      await collector

      expect(out).toHaveLength(2)
      expect(out[0].t).toBe(eventType)
      expect(out[0]).toHaveProperty("id", "outer-event")
      expect(out[1].t).toBe("PUBLIC_MESSAGE_DELETE")
      expect(client.selfId).toBe("bot-1")

      // The IDENTIFY frame carried the `QQBot ` token prefix.
      const identifyCall = mockWsSend.mock.calls.find((c) => {
        try {
          return JSON.parse(c[1]).op === 2
        } catch {
          return false
        }
      })
      expect(identifyCall).toBeDefined()
      expect(JSON.parse(identifyCall![1]).d.token).toBe("QQBot ACCESS_TOKEN")
    },
    10000
  )

  it("reconnects and recovers when the access token mint fails once during HELLO", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()
    const accessToken = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error("bots.qq.com blip"))
      .mockResolvedValue("FRESH_TOKEN")

    const client = startQQGateway({
      accessToken,
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const out: Array<{ t: string }> = []
    const collector = (async () => {
      for await (const d of client.dispatches) {
        out.push(d)
        if (out.length >= 1) break
      }
    })()

    await sessions.waitForConnection(1)
    // First HELLO: accessToken rejects — must NOT unwind the generator.
    sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
    await sessions.waitForConnection(2)
    // Second connection: token mint succeeds, IDENTIFY goes out, bot recovers.
    sessions.push(2, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    sessions.push(2, { op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s1" } })
    sessions.push(2, {
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      s: 2,
      d: { id: "m1", content: "hi", author: { user_openid: "UO" } },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collector

    expect(out).toHaveLength(1)
    expect(out[0].t).toBe("C2C_MESSAGE_CREATE")
    expect(mockWsOpen).toHaveBeenCalledTimes(2)
  }, 10000)

  it("fires onAuthInvalid on OP 9 INVALID_SESSION, drops the session and reconnects", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()
    const onAuthInvalid = jest.fn().mockRejectedValue(new Error("evict blew up"))

    const client = startQQGateway({
      accessToken: async () => "TOK",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      onAuthInvalid,
      _backoffBaseMs: 1,
    })

    const out: Array<{ t: string }> = []
    const collector = (async () => {
      for await (const d of client.dispatches) {
        out.push(d)
        if (out.length >= 1) break
      }
    })()

    await sessions.waitForConnection(1)
    sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    sessions.push(1, { op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s1" } })
    await new Promise((r) => setTimeout(r, 10))
    // Platform rejects the session — callback fires (its rejection is swallowed).
    sessions.push(1, { op: 9, d: false })
    await sessions.waitForConnection(2)
    expect(onAuthInvalid).toHaveBeenCalledTimes(1)

    // The reconnect IDENTIFYs afresh (no RESUME with the dropped session).
    sessions.push(2, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    const ops = mockWsSend.mock.calls.map((c) => {
      try {
        return JSON.parse(c[1]).op as number
      } catch {
        return -1
      }
    })
    expect(ops.filter((op) => op === 2)).toHaveLength(2)
    expect(ops).not.toContain(6)

    sessions.push(2, { op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s2" } })
    sessions.push(2, {
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      s: 2,
      d: { id: "m1", content: "hi", author: { user_openid: "UO" } },
    })
    await new Promise((r) => setTimeout(r, 20))
    ctrl.abort()
    await collector
    expect(out).toHaveLength(1)
  }, 10000)

  it("closes a zombie socket after two heartbeats without an ACK and reconnects", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()

    const client = startQQGateway({
      accessToken: async () => "TOK",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const collector = (async () => {
      // No dispatches expected — drain until abort.
      for await (const d of client.dispatches) void d
    })()

    await sessions.waitForConnection(1)
    // Tiny heartbeat interval and never an ACK: the client must give the
    // socket up as half-open and re-dial instead of heartbeating forever.
    sessions.push(1, { op: 10, d: { heartbeat_interval: 5 } })
    await sessions.waitForConnection(2)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockWsClose).toHaveBeenCalled()
    expect(mockWsOpen.mock.calls.length).toBeGreaterThanOrEqual(2)

    ctrl.abort()
    await collector
  }, 10000)

  it("resumes with the stored session and treats RESUMED as consumed, not yielded", async () => {
    const sessions = createMultiWsSessions()
    mockListen.mockImplementation(sessions.listenImpl)
    const ctrl = new AbortController()

    const client = startQQGateway({
      accessToken: async () => "TOK",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })

    const out: Array<{ t: string }> = []
    const collector = (async () => {
      for await (const d of client.dispatches) {
        out.push(d)
        if (out.length >= 1) break
      }
    })()

    await sessions.waitForConnection(1)
    sessions.push(1, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    sessions.push(1, { op: 0, t: "READY", s: 1, d: { user: { id: "bot-1" }, session_id: "s1" } })
    // A heartbeat ACK resets the zombie counter (op 11).
    sessions.push(1, { op: 11 })
    // Server asks us to reconnect (op 7) — the session survives for RESUME.
    sessions.push(1, { op: 7 })

    await sessions.waitForConnection(2)
    sessions.push(2, { op: 10, d: { heartbeat_interval: 100000 } })
    await new Promise((r) => setTimeout(r, 20))
    // RESUMED resets the backoff attempt counter and is not a message event.
    sessions.push(2, { op: 0, t: "RESUMED", d: {} })
    sessions.push(2, {
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      s: 5,
      d: { id: "m9", content: "back", group_openid: "GO" },
    })
    await new Promise((r) => setTimeout(r, 20))

    ctrl.abort()
    await collector

    // The second connection resumed instead of re-identifying.
    const resumeCall = mockWsSend.mock.calls.find((c) => {
      try {
        return JSON.parse(c[1]).op === 6
      } catch {
        return false
      }
    })
    expect(resumeCall).toBeDefined()
    expect(JSON.parse(resumeCall![1]).d.session_id).toBe("s1")
    expect(out).toHaveLength(1)
    expect(out[0].t).toBe("GROUP_AT_MESSAGE_CREATE")
  }, 10000)

  it("exits immediately when already aborted", async () => {
    const session = createFakeWsSession()
    mockListen.mockImplementation(session.listenImpl)
    const ctrl = new AbortController()
    ctrl.abort()
    const client = startQQGateway({
      accessToken: async () => "t",
      gatewayUrl: async () => "wss://fake",
      signal: ctrl.signal,
      _backoffBaseMs: 1,
    })
    const out: unknown[] = []
    for await (const d of client.dispatches) out.push(d)
    expect(out).toHaveLength(0)
    expect(mockWsOpen).not.toHaveBeenCalled()
  })
})

it("subscribes to native button interactions by default", () => {
  expect(DEFAULT_QQ_INTENTS & (1 << 26)).not.toBe(0)
})
