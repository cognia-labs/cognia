import type { Transport } from "@/lib/tauri/transport-types"

function fakeTransport(tag: string) {
  const call = jest.fn(async (name: string) => `${tag}:${name}`)
  const handlers: Array<(payload: unknown) => void> = []
  const subscribe = jest.fn((_event: string, handler: (payload: unknown) => void) => {
    handlers.push(handler)
    return () => {
      const at = handlers.indexOf(handler)
      if (at >= 0) handlers.splice(at, 1)
    }
  })
  const destroy = jest.fn()
  const transport = { call, subscribe, destroy } as unknown as Transport & { destroy: jest.Mock }
  return {
    transport,
    call,
    destroy,
    emit: (payload: unknown) => [...handlers].forEach((h) => h(payload)),
    listeners: () => handlers.length,
  }
}

const mockLocal = fakeTransport("local")
let mockShared: Transport
let mockContext: { targetId: string; routingGeneration: number; accountId: string } | null = null

jest.mock("@/lib/tauri", () => ({
  get transport() {
    return mockShared
  },
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  get localTransport() {
    return mockLocal.transport
  },
}))
jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => mockContext,
}))

import {
  RoutingTransport,
  __resetRoutingForTests,
  setActiveRemoteEndpoint,
  setActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import {
  ExecutionRouteChangedError,
  __resetSessionExecutionRoutesForTests,
  bindSessionExecutionRoute,
  captureExecutionRoute,
  currentExecutionRouteKey,
  detachedSessionRoute,
  forgetSessionExecutionRoute,
  subscribeSessionEvents,
} from "./execution-route"

function select(tag: string, remote: ReturnType<typeof fakeTransport>) {
  setActiveRemoteTransport(remote.transport)
  setActiveRemoteEndpoint({
    remoteHost: { id: tag, label: tag },
    baseUrl: `https://${tag}`,
    deviceId: "device",
    devicePrivateKeyJwk: {},
    deviceKeyThumbprint: "thumb",
    serverVersion: "1",
  })
  return remote
}

function selectRemote(tag: string) {
  return select(tag, fakeTransport(tag))
}

describe("captureExecutionRoute on the desktop", () => {
  beforeEach(() => {
    __resetRoutingForTests()
    mockShared = new RoutingTransport(mockLocal.transport)
    jest.clearAllMocks()
  })

  it("keeps a turn begun on Host A on A after B is selected", async () => {
    const a = selectRemote("A")
    const route = captureExecutionRoute()
    expect(route).toMatchObject({ key: "remote:A", remote: true, identity: a.transport })
    const heard: unknown[] = []
    route.transport.subscribe("claude://message", (payload) => heard.push(payload))

    const b = selectRemote("B")
    expect(route.isCurrent()).toBe(false)
    expect(currentExecutionRouteKey()).toBe("remote:B")
    // A stays open for the turn: its control and its events are still A's.
    expect(a.destroy).not.toHaveBeenCalled()
    await expect(route.transport.call("claude_interrupt", { sessionId: "s" })).resolves.toBe(
      "A:claude_interrupt"
    )
    a.emit({ type: "session_disposed" })
    expect(heard).toEqual([{ type: "session_disposed" }])
    expect(b.call).not.toHaveBeenCalled()

    route.release()
    expect(a.destroy).toHaveBeenCalledTimes(1)
  })

  it("holds A once per holder", () => {
    const a = selectRemote("A")
    const route = captureExecutionRoute()
    route.retain()
    selectRemote("B")
    route.release()
    expect(a.destroy).not.toHaveBeenCalled()
    route.release()
    route.release()
    expect(a.destroy).toHaveBeenCalledTimes(1)
  })

  it("pins this machine's own IPC when no remote Host is selected", async () => {
    const route = captureExecutionRoute()
    expect(route).toMatchObject({ key: "local", remote: false, identity: mockLocal.transport })
    const b = selectRemote("B")
    expect(route.isCurrent()).toBe(false)
    await route.transport.call("agent_close_session", {})
    expect(mockLocal.call).toHaveBeenCalledWith("agent_close_session", {})
    expect(b.call).not.toHaveBeenCalled()
  })
})

describe("captureExecutionRoute on a paired client", () => {
  const shared = fakeTransport("paired")
  beforeEach(() => {
    __resetRoutingForTests()
    mockShared = shared.transport
    mockContext = { targetId: "host-a", routingGeneration: 1, accountId: "acct" }
    jest.clearAllMocks()
  })

  it("refuses controls and drops events once the client follows another target", async () => {
    const route = captureExecutionRoute()
    expect(route.key).toBe("target:host-a:1")
    const heard: unknown[] = []
    route.transport.subscribe("claude://message", (payload) => heard.push(payload))
    await expect(route.transport.call("claude_interrupt", {})).resolves.toBe(
      "paired:claude_interrupt"
    )
    shared.emit("from A")

    mockContext = { targetId: "host-b", routingGeneration: 2, accountId: "acct" }
    expect(route.isCurrent()).toBe(false)
    await expect(route.transport.call("claude_interrupt", {})).rejects.toBeInstanceOf(
      ExecutionRouteChangedError
    )
    shared.emit("from B")
    expect(heard).toEqual(["from A"])
    expect(shared.call).toHaveBeenCalledTimes(1)
  })

  it("treats a reconnect to the same target as a new route", async () => {
    const route = captureExecutionRoute()
    mockContext = { targetId: "host-a", routingGeneration: 2, accountId: "acct" }
    await expect(route.transport.call("agent_close_session", {})).rejects.toMatchObject({
      code: "execution_host_changed",
    })
  })
})

describe("global listeners across a Host switch (postfix review P05)", () => {
  type Frame = { sessionId?: string; n: number }
  let heard: Array<[number, string | null]>
  let unlisten: () => void
  beforeEach(() => {
    __resetSessionExecutionRoutesForTests()
    __resetRoutingForTests()
    mockShared = new RoutingTransport(mockLocal.transport)
    mockContext = null
    jest.clearAllMocks()
    heard = []
  })
  afterEach(() => {
    unlisten?.()
    __resetSessionExecutionRoutesForTests()
  })
  const listen = () => {
    unlisten = subscribeSessionEvents<Frame>(
      "claude://message",
      (frame) => frame.sessionId,
      (frame, from) => heard.push([frame.n, from?.key ?? null])
    )
  }

  it("hears a turn from the Host it runs on, and only from there", () => {
    const a = selectRemote("A")
    const route = captureExecutionRoute()
    bindSessionExecutionRoute("s", route)
    route.release()
    listen()
    a.emit({ sessionId: "s", n: 1 })

    const b = selectRemote("B")
    expect(detachedSessionRoute("s")).toBe(route)
    expect(a.destroy).not.toHaveBeenCalled()
    a.emit({ sessionId: "s", n: 2 })
    // B's session of the same id is not this turn.
    b.emit({ sessionId: "s", n: 3 })
    b.emit({ sessionId: "other", n: 4 })
    // A's other sessions are not routed here: nothing recorded them on A.
    a.emit({ sessionId: "other", n: 5 })
    a.emit({ n: 6 })

    // Back on A, its events arrive once, through the shared transport.
    select("A", a)
    expect(detachedSessionRoute("s")).toBeNull()
    a.emit({ sessionId: "s", n: 7 })
    expect(heard).toEqual([
      [1, null],
      [2, "remote:A"],
      [4, null],
      [7, null],
    ])
  })

  it("stops hearing the old Host once the session lets it go", () => {
    const a = selectRemote("A")
    const route = captureExecutionRoute()
    bindSessionExecutionRoute("s", route)
    route.release()
    listen()
    const b = selectRemote("B")
    forgetSessionExecutionRoute("s")
    expect(a.listeners()).toBe(0)
    a.emit({ sessionId: "s", n: 1 })
    b.emit({ sessionId: "s", n: 2 })
    expect(heard).toEqual([[2, null]])
    expect(a.destroy).toHaveBeenCalledTimes(1)
  })

  it("never holds back a paired client's events, whose old Host is out of reach", () => {
    const shared = fakeTransport("paired")
    mockShared = shared.transport
    mockContext = { targetId: "host-a", routingGeneration: 1, accountId: "acct" }
    bindSessionExecutionRoute("s", captureExecutionRoute())
    listen()
    mockContext = { targetId: "host-b", routingGeneration: 2, accountId: "acct" }
    expect(detachedSessionRoute("s")).toBeNull()
    shared.emit({ sessionId: "s", n: 1 })
    expect(heard).toEqual([[1, null]])
  })
})
