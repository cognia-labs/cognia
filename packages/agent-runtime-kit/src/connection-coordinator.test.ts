import { AgentConnectionCoordinator } from "./connection-coordinator"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it("joins duplicate disconnects and clears failed teardown before a retry", async () => {
  const state = new AgentConnectionCoordinator(),
    gate = deferred()
  const stop = jest.fn(() => gate.promise)
  const first = state.disconnect("agent", stop, true),
    second = state.disconnect("agent", stop, true)
  expect(stop).toHaveBeenCalledTimes(1)
  gate.resolve()
  await Promise.all([first, second])
  await expect(
    state.disconnect(
      "agent",
      async () => {
        throw new Error("stop failed")
      },
      true
    )
  ).rejects.toThrow("stop failed")
  expect(state.disconnections.size).toBe(0)
  await state.disconnect("agent", stop, true)
  expect(stop).toHaveBeenCalledTimes(2)
})

it("joins simultaneous connects and clears ownership after completion", async () => {
  const state = new AgentConnectionCoordinator(),
    gate = deferred()
  const spawn = jest.fn(() => gate.promise)
  const a = state.connect("agent", spawn, true),
    b = state.connect("agent", spawn, true)
  expect(spawn).toHaveBeenCalledTimes(1)
  gate.resolve()
  await Promise.all([a, b])
  expect(state.connections.size).toBe(0)
})

it("finishes an owned handshake before teardown and a subsequent reconnect", async () => {
  const state = new AgentConnectionCoordinator(),
    handshake = deferred(),
    stopping = deferred()
  const order: string[] = []
  const connect = state.connect("agent", () => handshake.promise, true)
  const stop = state.disconnect(
    "agent",
    async () => {
      order.push("stop")
      await stopping.promise
    },
    true
  )
  const reconnect = state.connect(
    "agent",
    async () => {
      order.push("connect")
    },
    true
  )
  expect(order).toEqual([])
  handshake.resolve()
  await connect
  await Promise.resolve()
  expect(order).toEqual(["stop"])
  stopping.resolve()
  await Promise.all([stop, reconnect])
  expect(order).toEqual(["stop", "connect"])
  expect(state.disconnections.size).toBe(0)
})

it("releases failed handshakes and still runs the requested cleanup", async () => {
  const state = new AgentConnectionCoordinator(),
    stop = jest.fn(async () => {})
  const connect = state.connect(
    "agent",
    async () => {
      throw new Error("handshake failed")
    },
    true
  )
  const cleanup = state.disconnect("agent", stop, true)
  await expect(connect).rejects.toThrow("handshake failed")
  await cleanup
  expect(stop).toHaveBeenCalledTimes(1)
  expect(state.connections.size).toBe(0)
})

it("does not serialize independent operations when a runtime owns no shared connection", async () => {
  const state = new AgentConnectionCoordinator(),
    gate = deferred()
  const operation = jest.fn(() => gate.promise)
  const a = state.connect("agent", operation, false),
    b = state.connect("agent", operation, false)
  expect(operation).toHaveBeenCalledTimes(2)
  gate.resolve()
  await Promise.all([a, b])
})
