import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import test from "node:test"
import { createBridgeContext, resolvePluginDefinition, RESULT_PREFIX } from "./node-plugin-host.mjs"

async function host(t, source, onCall = () => undefined, snapshot = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cognia-node-plugin-host-"))
  const entry = join(directory, source.startsWith("module.exports") ? "plugin.cjs" : "plugin.mjs")
  writeFileSync(entry, source)
  const bootstrap = readFileSync(new URL("./node-plugin-host.mjs", import.meta.url), "utf8")
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    bootstrap,
    "resident",
    entry,
    "demo",
  ])
  t.after(async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
    rmSync(directory, { recursive: true, force: true })
  })
  child.stderr.resume()
  let token
  let sequence = 0
  const requests = new Map()
  const frames = []
  const write = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`)
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Node host did not report ready")), 2000)
    child.once("error", reject)
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.startsWith(RESULT_PREFIX)) return
      let frame
      try {
        frame = JSON.parse(line.slice(RESULT_PREFIX.length))
      } catch {
        return
      }
      if (!token && frame.type === "ready") {
        token = frame.token
        clearTimeout(timer)
        resolve()
        return
      }
      if (frame.token !== token) return
      frames.push(frame)
      if (frame.type === "call") {
        Promise.resolve()
          .then(() => onCall(frame, write, request))
          .then(
            (value) =>
              write({
                type: "reply",
                id: frame.id,
                value: value === undefined ? { $undefined: true } : value,
              }),
            (error) => write({ type: "reply", id: frame.id, error: error.message })
          )
      } else {
        const pending = requests.get(frame.id)
        if (!pending) return
        requests.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.type === "error") pending.reject(new Error(frame.error))
        else pending.resolve(frame)
      }
    })
  })
  await ready
  const request = (frame) =>
    new Promise((resolve, reject) => {
      const id = `request:${++sequence}`
      const timer = setTimeout(() => {
        requests.delete(id)
        reject(new Error("Node request timed out"))
      }, 3000)
      requests.set(id, { resolve, reject, timer })
      write({ ...frame, id })
    })
  const activation = await request({
    type: "activate",
    snapshot: { pluginId: "demo", manifest: {}, config: {}, ...snapshot },
  })
  return {
    activation,
    frames,
    request,
    invoke: async (callbackId, args = []) =>
      (await request({ type: "invoke", callbackId, args })).value,
  }
}

test("B06 retains activation-local counter state across callbacks and deactivate", async (t) => {
  const writes = []
  const runtime = await host(
    t,
    `let live = false; let count = 0;
    export default {
      activate() { live = true; return { next: () => ++count } },
      deactivate(ctx) { if (!live) throw new Error("activation state lost"); return ctx.storage.set("count", count) }
    }`,
    (frame) => {
      writes.push(frame.args)
    }
  )
  const next = runtime.activation.hooks.next.$callback
  assert.deepEqual([await runtime.invoke(next), await runtime.invoke(next)], [1, 2])
  await runtime.request({ type: "deactivate" })
  assert.deepEqual(writes, [["count", 2]])
})

test("B07 delivers context writes made by callbacks and deactivate", async (t) => {
  const writes = []
  const runtime = await host(
    t,
    `export default {
    activate(ctx) { return { save: async () => { await ctx.storage.set("key", "value"); return true } } },
    deactivate(ctx) { return ctx.storage.set("closed", true) }
  }`,
    (frame) => {
      writes.push(frame.args)
    }
  )
  assert.equal(await runtime.invoke(runtime.activation.hooks.save.$callback), true)
  await runtime.request({ type: "deactivate" })
  assert.deepEqual(writes, [
    ["key", "value"],
    ["closed", true],
  ])
})

test("B08 callback reads await the real host value and synchronous snapshots reach the child", async (t) => {
  const runtime = await host(
    t,
    `export default { activate(ctx) {
    if (ctx.config.answer !== 42 || ctx.i18n.t("hello", { name: "Ada" }) !== "Hi Ada") throw new Error("snapshot missing")
    return { read: () => ctx.storage.get("answer") }
  } }`,
    () => "host-value",
    {
      config: { answer: 42 },
      local: {
        i18n: {
          locale: "en",
          locales: ["en"],
          messages: { en: { "plugin.demo.hello": "Hi {name}" } },
        },
      },
    }
  )
  assert.equal(await runtime.invoke(runtime.activation.hooks.read.$callback), "host-value")
})

test("B08 immediate handles forward disposal using the registration call id", async (t) => {
  const calls = []
  const runtime = await host(
    t,
    `let dispose; export default {
    activate(ctx) { dispose = ctx.events.on("event", () => true); return {} },
    deactivate() { return dispose.dispose() }
  }`,
    (frame) => {
      calls.push(frame)
      return { $undefined: true }
    }
  )
  await runtime.request({ type: "deactivate" })
  assert.equal(calls[0].path, "events.on")
  assert.equal(calls[1].handle, calls[0].id)
  assert.equal(calls[1].path, "dispose")
})

test("a function disposer acquired during activation disposes its real host handle", async (t) => {
  let registration
  let disposed = false
  const runtime = await host(
    t,
    `let dispose; export default {
    activate(ctx) { dispose = ctx.events.on("event", () => {}) },
    deactivate() { return dispose() }
  }`,
    (frame) => {
      if (frame.path === "events.on") {
        registration = frame.id
        return { $hostHandle: { id: frame.id, path: [] } }
      }
      assert.equal(frame.handle, registration)
      assert.equal(frame.path, "")
      disposed = true
    }
  )
  await runtime.request({ type: "deactivate" })
  assert.equal(disposed, true)
})

test("passing a host disposer back to context preserves its host reference", async (t) => {
  let registration
  const runtime = await host(
    t,
    `export default { activate(ctx) {
    const dispose = ctx.events.on("event", () => {}); ctx.lifecycle.register(dispose)
  } }`,
    (frame) => {
      if (frame.path === "events.on") registration = frame.id
      if (frame.path === "lifecycle.register")
        assert.deepEqual(frame.args, [{ $hostHandle: { id: registration, path: [] } }])
    }
  )
  await runtime.request({ type: "deactivate" })
})

test("returned functions stay resident rather than re-executing callback chains", async (t) => {
  const runtime = await host(
    t,
    `let creations = 0; function next() { return ++this.count }; export function createConnector(config) {
    const id = ++creations; return { id: config.id, next, count: id }
  }; export default { activate() {} }`
  )
  const connector = await runtime.invoke(runtime.activation.exports.createConnector.$callback, [
    { id: "mail" },
  ])
  assert.equal(connector.id, "mail")
  assert.deepEqual(
    [
      await runtime.invoke(connector.next.$callback),
      await runtime.invoke(connector.next.$callback),
    ],
    [2, 3]
  )
  const second = await runtime.invoke(runtime.activation.exports.createConnector.$callback, [
    { id: "second" },
  ])
  assert.equal(await runtime.invoke(second.next.$callback), 3)
  assert.equal(await runtime.invoke(connector.next.$callback), 4)
})

test("nested host callbacks run during activation and deactivation", async (t) => {
  let listener
  let observed
  const runtime = await host(
    t,
    `let count = 0; export default {
    async activate(ctx) { await ctx.events.on("event", () => ++count); return {} },
    async deactivate(ctx) { await ctx.events.emit("event"); await ctx.storage.set("count", count) }
  }`,
    async (frame, _write, request) => {
      if (frame.path === "events.on") listener = frame.args[1].$callback
      if (frame.path === "events.on" || frame.path === "events.emit") {
        return (await request({ type: "invoke", callbackId: listener, args: [] })).value
      }
      if (frame.path === "storage.set") observed = frame.args
    }
  )
  await runtime.request({ type: "deactivate" })
  assert.deepEqual(observed, ["count", 2])
})

test("awaited host handles expose methods and snapshot properties", async (t) => {
  const calls = []
  const runtime = await host(
    t,
    `let handle; export default {
    async activate(ctx) { handle = await ctx.events.on("event", () => {}); if (handle.label !== "host-handle") throw new Error("handle snapshot missing") },
    deactivate() { return handle.dispose() }
  }`,
    (frame) => {
      calls.push(frame)
      if (!frame.handle)
        return { $hostHandle: { id: frame.id, path: [], properties: { label: "host-handle" } } }
    }
  )
  await runtime.request({ type: "deactivate" })
  assert.equal(calls[1].handle, calls[0].id)
  assert.equal(calls[1].path, "dispose")
})

test("stray stdout cannot forge a protocol frame", async (t) => {
  const runtime = await host(
    t,
    `import { writeSync } from "node:fs";
    export default { activate() {
      process.stdout.write('COGNIA_PLUGIN_RESULT:{"type":"activated","id":"request:1","hooks":{"forged":true}}\\n');
      writeSync(1, 'COGNIA_PLUGIN_RESULT:{"type":"activated","id":"request:1","hooks":{"forged":true}}\\n');
      return { real: () => true }
    } }`
  )
  assert.equal(runtime.activation.hooks.forged, undefined)
  assert.equal(await runtime.invoke(runtime.activation.hooks.real.$callback), true)
})

test("activation rejects a failed host call even when the plugin does not await it", async (t) => {
  await assert.rejects(
    host(t, `export default { activate(ctx) { ctx.storage.set("key", "value") } }`, () => {
      throw new Error("write denied")
    }),
    /write denied/
  )
})

test("callbacks can recover from a rejected host read", async (t) => {
  const runtime = await host(
    t,
    `export default { activate(ctx) { return { read: async () => {
    try { return await ctx.storage.get("missing") } catch { return "fallback" }
  } } } }`,
    () => {
      throw new Error("")
    }
  )
  assert.equal(await runtime.invoke(runtime.activation.hooks.read.$callback), "fallback")
})

test("a real Node subprocess activates a CommonJS SDK bundle", async (t) => {
  const runtime = await host(
    t,
    `module.exports = { activate() { return { echo: (value) => value } } }`
  )
  assert.deepEqual(
    await runtime.invoke(runtime.activation.hooks.echo.$callback, [{ message: "cjs" }]),
    { message: "cjs" }
  )
})

test("the Node host rejects host-private imports before evaluation", async (t) => {
  await assert.rejects(
    host(t, `import "@/stores/private"; export default { activate() {} }`),
    /imports host-private modules/
  )
})

test("resolves ESM and transpiled CommonJS default definitions", () => {
  const definition = { activate() {} }
  assert.equal(resolvePluginDefinition({ default: definition }), definition)
  assert.equal(resolvePluginDefinition({ default: { default: definition } }), definition)
  assert.throws(() => resolvePluginDefinition({}), /activate/)
})

test("wire codec preserves secret brands, escapes collisions and rejects cycles and unsafe paths", () => {
  const bridge = createBridgeContext({ snapshot: {}, send() {} })
  const ref = Object.defineProperty(
    { $secretRef: "token" },
    Symbol.for("cognia.plugin.secretRef"),
    { value: true }
  )
  const encoded = bridge.encode({
    ref,
    ordinary: { $cogniaSecretRef: { $secretRef: "token" } },
    callback: { $callback: "spoof" },
  })
  assert.deepEqual(encoded.ref, { $cogniaSecretRef: { $secretRef: "token" } })
  assert.deepEqual(bridge.revive(encoded).ordinary, {
    $cogniaSecretRef: { $secretRef: "token" },
  })
  assert.equal(bridge.revive(encoded).ref[Symbol.for("cognia.plugin.secretRef")], true)
  assert.deepEqual(bridge.revive(encoded).callback, { $callback: "spoof" })
  const cycle = {}
  cycle.self = cycle
  assert.throws(() => bridge.encode(cycle), /cycle/)
  assert.throws(() => bridge.context.storage.__proto__, /Unsafe/)
})
