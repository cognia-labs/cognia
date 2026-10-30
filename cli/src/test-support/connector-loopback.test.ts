import { ConnectorLoopback, deferred, waitFor } from "./connector-loopback"
import {
  connectorsHttpRequest,
  connectorsWsOpen,
  connectorsWsSend,
  connectorsWsClose,
  connectorsWechatOaInboundList,
} from "@/lib/connectors/tauri/commands"
import { connectorListen } from "@/lib/connectors/events"
import { createServer } from "node:http"
import { once } from "node:events"
import { readFile } from "node:fs/promises"

it("performs actual HTTP requests through the production wrapper and refuses foreign origins", async () => {
  const wire = await new ConnectorLoopback().open()
  wire.onHttp = (request) => ({ body: { text: request.body.text } })
  try {
    const reply = await connectorsHttpRequest({
      url: `${wire.origin}/message`,
      method: "POST",
      body: JSON.stringify({ text: "真实消息 ✓" }),
    })
    expect(JSON.parse(reply.body)).toEqual({ text: "真实消息 ✓" })
    expect(wire.requests).toHaveLength(1)
    await expect(
      connectorsHttpRequest({ url: "https://not-owned.example/message", method: "POST" })
    ).rejects.toThrow("refused outbound")
    expect(wire.requests).toHaveLength(1)
  } finally {
    await wire.close()
  }
  await expect(wire.http({ url: `${wire.origin}/closed`, method: "GET" })).rejects.toThrow("closed")
})

it("exchanges actual WS frames and unregisters the native-boundary event listener", async () => {
  const wire = await new ConnectorLoopback().open()
  wire.onFrame = ({ socket, body }) => socket.send(JSON.stringify({ echo: body.text }))
  try {
    const handle = await connectorsWsOpen(wire.wsUrl)
    let reply: string | undefined
    const remove = await connectorListen<string>(`connectors://ws/${handle}/message`, (event) => {
      reply = event.payload
    })
    await connectorsWsSend(handle, JSON.stringify({ text: "hello" }))
    await waitFor(() => reply !== undefined, "real WS echo")
    expect(JSON.parse(reply!)).toEqual({ echo: "hello" })
    remove()
    await connectorsWsClose(handle)
    expect(wire.clients.size).toBe(0)
    expect(wire.listeners.size).toBe(0)
    await expect(connectorsWsOpen("wss://not-owned.example/ws")).rejects.toThrow("refused external")
  } finally {
    await wire.close()
  }
})

it("cannot escape the owned server through a scheme-relative request path", async () => {
  let escaped = 0
  const other = createServer((_req, res) => {
    escaped++
    res.end("{}")
  })
  other.listen(0, "127.0.0.1")
  await once(other, "listening")
  const address = other.address()
  if (!address || typeof address === "string") throw new Error("Missing second owned port")
  const wire = await new ConnectorLoopback().open()
  try {
    await expect(
      wire.http({ url: `${wire.origin}//127.0.0.1:${address.port}/escape`, method: "POST" })
    ).rejects.toThrow("refused")
    expect(escaped).toBe(0)
  } finally {
    await wire.close()
    other.closeAllConnections()
    await new Promise<void>((resolve) => other.close(() => resolve()))
  }
})

it("rejects overlapping bridge owners without replacing the active fixture", async () => {
  const first = await new ConnectorLoopback().open()
  const second = new ConnectorLoopback()
  first.onHttp = () => ({ body: { owner: "first" } })
  try {
    await expect(second.open()).rejects.toThrow("already active")
    const result = await connectorsHttpRequest({ url: `${first.origin}/owner`, method: "GET" })
    expect(JSON.parse(result.body)).toEqual({ owner: "first" })
  } finally {
    await second.close()
    await first.close()
  }
})

it("waits for active HTTP and handler settlement before declaring fixture cleanup complete", async () => {
  const wire = await new ConnectorLoopback().open()
  const entered = deferred<void>(),
    release = deferred<void>()
  let ended = false,
    closed = false
  wire.onHttp = async () => {
    entered.resolve()
    await release.promise
    ended = true
    return { body: {} }
  }
  const response = wire.http({ url: `${wire.origin}/held`, method: "GET" }).catch((error) => error)
  await entered.promise
  const rawClosing = wire.close()
  expect(wire.close()).toBe(rawClosing)
  const closing = rawClosing.then(() => {
    closed = true
  })
  try {
    await waitFor(() => wire.httpInFlight === 0, "cancelled HTTP request")
    expect(closed).toBe(false)
    expect(ended).toBe(false)
  } finally {
    release.resolve()
    await closing
    await response
  }
  expect(ended).toBe(true)
  expect(closed).toBe(true)
})

it("waits for an outstanding native substitute instead of restoring globals early", async () => {
  const wire = await new ConnectorLoopback().open()
  const entered = deferred<void>(),
    release = deferred<void>()
  wire.onCommand = async () => {
    entered.resolve()
    await release.promise
    return []
  }
  const native = connectorsWechatOaInboundList("owned")
  await entered.promise
  let settled = false
  const closing = wire.close().then(() => {
    settled = true
  })
  try {
    // This is a bounded negative observation: known unfinished native work
    // must keep cleanup pending for the whole observation interval.
    const deadline = Date.now() + 100
    while (Date.now() < deadline) {
      expect(settled).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  } finally {
    release.resolve()
    await native
    await closing
  }
  const evidence = JSON.parse(await readFile(wire.reportPath, "utf8"))
  expect(evidence.workAfterCleanup).toBe(0)
})

it("never serializes arbitrary protocol fields or unknown request paths into evidence", async () => {
  const wire = await new ConnectorLoopback().open()
  try {
    const handle = await connectorsWsOpen(wire.wsUrl)
    await connectorsWsSend(
      handle,
      JSON.stringify({
        cmd: { secret: "synthetic-private-value" },
        code: { text: "synthetic-message-body" },
      })
    )
    await waitFor(() => wire.frames.length === 1, "untrusted frame")
    await wire.http({ url: `${wire.origin}/synthetic-private-path`, method: "GET" })
    await connectorsWsClose(handle)
  } finally {
    await wire.close()
  }
  const evidence = await readFile(wire.reportPath, "utf8")
  expect(evidence).not.toContain("synthetic-private-value")
  expect(evidence).not.toContain("synthetic-message-body")
  expect(evidence).not.toContain("synthetic-private-path")
})
