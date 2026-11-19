import assert from "node:assert/strict"
import { test } from "node:test"
import { Channel } from "storybook/internal/channels"

import { keepModuleIndexOnServer } from "./server-channel.ts"

class ServerChannelTransport {
  sent = []
  setHandler() {}
  send(event) {
    this.sent.push(event)
  }
}

test("internal module index updates stay local while public events reach the browser", () => {
  const transport = new ServerChannelTransport()
  const channel = new Channel({ transport })
  keepModuleIndexOnServer(channel)
  let localIndex
  channel.on("services:patches", (payload) => {
    localIndex = payload.state
  })
  const state = { storiesByFile: { "component.tsx": { "component.stories.tsx": 1 } } }
  channel.emit("services:patches", { serviceId: "core/module-graph-index", state })
  assert.equal(localIndex, state, "Server-side queries/subscriptions keep the actual index")
  assert.equal(transport.sent.length, 0, "The large snapshot is never serialized for the browser")
  channel.emit("services:sync-start-reply", { serviceId: "core/module-graph-index", state })
  assert.equal(transport.sent.length, 0)
  channel.emit("services:patches", { serviceId: "core/module-graph", state: { graphRevision: 2 } })
  channel.emit("updateGlobals", { globals: { locale: "zh-CN" } })
  channel.emit("services:command-result", { serviceId: "core/module-graph-index", result: [] })
  assert.equal(
    transport.sent.length,
    3,
    "Public graph status, globals and command replies remain live"
  )
})

test("installation is idempotent and preserves transport receiver/other transports", () => {
  const transport = new ServerChannelTransport()
  const other = {
    sent: [],
    setHandler() {},
    send(event) {
      this.sent.push(event)
    },
  }
  const channel = new Channel({ transports: [transport, other] })
  assert.equal(keepModuleIndexOnServer(channel), channel)
  const wrapped = transport.send
  keepModuleIndexOnServer(channel)
  assert.equal(transport.send, wrapped)
  channel.emit("services:patches", { serviceId: "core/module-graph-index", state: {} })
  assert.equal(other.sent.length, 1, "Only the browser websocket transport is filtered")
  channel.emit("ping")
  assert.equal(transport.sent.length, 1, "Original send still receives its transport as this")
})

test("an upstream transport change fails visibly instead of pretending the workaround works", () => {
  assert.throws(() => keepModuleIndexOnServer(new Channel()), /Storybook server transport/)
})
