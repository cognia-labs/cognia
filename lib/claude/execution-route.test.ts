import type { Transport } from "@/lib/tauri/transport-types"

function fakeTransport(tag: string) {
  const call = jest.fn(async (name: string) => `${tag}:${name}`)
  const handlers: Array<(payload: unknown) => void> = []
  const subscribe = jest.fn((_event: string, handler: (payload: unknown) => void) => {
    handlers.push(handler)
    return () => undefined
  })
  const destroy = jest.fn()
  const transport = { call, subscribe, destroy } as unknown as Transport & { destroy: jest.Mock }
  return {
    transport,
    call,
    destroy,
    emit: (payload: unknown) => handlers.forEach((h) => h(payload)),
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
  captureExecutionRoute,
  currentExecutionRouteKey,
} from "./execution-route"

function selectRemote(tag: string) {
  const remote = fakeTransport(tag)
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
