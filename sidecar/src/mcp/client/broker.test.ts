import test from "node:test"
import assert from "node:assert/strict"
import { connectBroker } from "./broker.ts"
import { fakeSocket, scriptedBroker } from "../../../test-support/mcp-broker.ts"
test("connectBroker resolves a call with the matching response id", async () => {
  const { broker } = scriptedBroker((method) => ({ echoed: method }))
  assert.deepEqual(await broker.call("hello", {}), { echoed: "hello" })
})

test("connectBroker rejects every pending call when Cognia goes away", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  const first = assert.rejects(broker.call("authorize", {}), /closed the connection/)
  const second = assert.rejects(broker.call("refresh", {}), /closed the connection/)
  socket.emit("close")
  await Promise.all([first, second])
  const writesBefore = socket.writes.length
  await assert.rejects(broker.call("after-close", {}), /closed the connection/)
  assert.equal(socket.writes.length, writesBefore)
})

test(
  "connectBroker correlates reversed, fragmented replies by request id",
  { timeout: 1000 },
  async () => {
    const socket = fakeSocket()
    const broker = connectBroker("/ignored", { connect: () => socket })
    try {
      const first = broker.call("authorize", { client: "first" })
      const second = broker.call("refresh", { client: "second" })
      const replies = Promise.all([first, second])
      await broker.ready()
      const requests = socket.writes.map((line) => JSON.parse(line))
      assert.equal(requests.length, 2)
      assert.notEqual(requests[0].id, requests[1].id)
      assert.deepEqual(
        requests.map(({ method, params }) => ({ method, params })),
        [
          { method: "authorize", params: { client: "first" } },
          { method: "refresh", params: { client: "second" } },
        ]
      )
      const frames = [
        { id: -1, result: "unsolicited" },
        { id: requests[1].id, result: { token: "second-token" } },
        { id: requests[0].id, result: { token: "first-token" } },
      ]
        .map((frame) => `${JSON.stringify(frame)}\n`)
        .join("")
      // Include both an incomplete JSON object and multiple lines in one chunk.
      socket.emit("data", frames.slice(0, 7))
      socket.emit("data", frames.slice(7, -3))
      socket.emit("data", frames.slice(-3))
      assert.deepEqual(await replies, [{ token: "first-token" }, { token: "second-token" }])
    } finally {
      broker.close()
    }
  }
)

test("connectBroker rejects a malformed frame rather than guessing", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  const pending = broker.call("authorize", {})
  socket.emit("data", "garbage\n")
  await assert.rejects(pending, /malformed frame/)
})

test("connectBroker surfaces a broker-side error as a rejection", async () => {
  const socket = fakeSocket()
  const broker = connectBroker("/ignored", { connect: () => socket })
  socket.write = (chunk) => {
    const { id } = JSON.parse(chunk)
    queueMicrotask(() => socket.emit("data", `${JSON.stringify({ id, error: "unauthorized" })}\n`))
    return true
  }
  await assert.rejects(broker.call("hello", {}), /unauthorized/)
})
