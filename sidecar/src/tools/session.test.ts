import test from "node:test"
import assert from "node:assert/strict"
import { createToolSessionContext } from "./session.ts"
import { createReadTracker } from "./state/read-tracker.ts"
import { createSessionTaskStore } from "./state/tasks.ts"
import { createSessionBgShellRegistry } from "./state/host-background-shells.ts"
import { createBashTool } from "./builtin/core-files/bash.ts"
import { asCallable } from "../../test-support/tool-result.ts"

test(
  "foreground groups remain session-owned after the shell exits",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const context = createToolSessionContext({
      sessionId: "foreground-descendant",
      sendOptions: {},
    })
    const sibling = createToolSessionContext({ sessionId: "foreground-sibling", sendOptions: {} })
    let descendant: number | undefined
    try {
      const tool = asCallable(createBashTool(context.toolContext()))
      const result = await tool.handler(
        { command: "sleep 20 </dev/null >/dev/null 2>&1 & echo $!" },
        {}
      )
      descendant = Number((result.content[0] as { text: string }).text.trim())
      assert.ok(!result.isError)
      assert.equal(await context.hasLiveProcesses(), true)
      assert.equal(await sibling.hasLiveProcesses(), false)
      await assert.rejects(context.disposeProcesses(), /live foreground/)
      assert.equal(await context.hasLiveProcesses(), true, "owner retains final unconfirmed state")
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL")
        } catch {
          /* exited */
        }
      }
      await Promise.allSettled([context.dispose(), sibling.dispose()])
    }
  }
)

function fixture() {
  const events: string[] = []
  let generation = 0
  const dependencies: NonNullable<Parameters<typeof createToolSessionContext>[1]> = {
    createReadTracker,
    createSessionTaskStore,
    createSessionBgShellRegistry(options) {
      const registry = createSessionBgShellRegistry(options)
      registry.killAll = async () => {
        events.push("shells")
      }
      return registry
    },
    makeLazyLspResolver({ sendOptions }) {
      const current = ++generation
      return {
        lspEnabled: !!sendOptions.lsp?.enabled,
        lspResolver: sendOptions.lsp?.enabled
          ? {
              async request() {
                return current
              },
              async getDiagnostics() {
                return []
              },
            }
          : null,
        dispose() {
          events.push(`lsp:${current}`)
        },
      }
    },
    makeLazyCodeGraphResolver() {
      const current = generation
      return {
        codeGraphEnabled: false,
        codeGraphResolver: null,
        dispose() {
          events.push(`graph:${current}`)
        },
      }
    },
    async disposeTerminalRepls(id) {
      events.push(`terminal:${id}`)
    },
  }
  return { events, dependencies }
}

test("session contexts own separate read trackers, tasks and process registries", async () => {
  const a = createToolSessionContext({ sessionId: "a", sendOptions: {} })
  const b = createToolSessionContext({ sessionId: "b", sendOptions: {} })
  assert.notEqual(a.readTracker, b.readTracker)
  assert.notEqual(a.taskStore, b.taskStore)
  assert.notEqual(a.bgShells, b.bgShells)
  assert.equal(a.toolContext().readTracker, a.readTracker)
  assert.equal(a.toolContext().taskStore, a.taskStore)
  assert.equal(a.toolContext().bgShells, a.bgShells)
  assert.equal(a.toolContext().sessionId, "a")
  assert.equal(a.lsp.lspResolver, null)
  assert.equal(a.codeGraph.codeGraphResolver, null)
  await Promise.all([a.dispose(), b.dispose()])
})

test("paused lease refresh replaces resolvers but preserves the session state", async () => {
  const { events, dependencies } = fixture()
  const context = createToolSessionContext({ sessionId: "lease", sendOptions: {} }, dependencies)
  const before = context.toolContext()
  context.refreshResolvers({ cwd: "/workspace", lsp: { enabled: true } })
  const after = context.toolContext()
  assert.equal(after.readTracker, before.readTracker)
  assert.equal(after.taskStore, before.taskStore)
  assert.equal(after.bgShells, before.bgShells)
  assert.equal(context.lsp.lspEnabled, true)
  assert.equal(await after.lspResolver?.request("x", "hover"), 2)
  assert.deepEqual(events, ["lsp:1", "graph:1"])
  await context.dispose()
  assert.deepEqual(events, ["lsp:1", "graph:1", "lsp:2", "graph:2", "terminal:lease", "shells"])
})

test("split and repeated teardown dispose every resource only once", async () => {
  const { events, dependencies } = fixture()
  const context = createToolSessionContext({ sessionId: "session", sendOptions: {} }, dependencies)
  context.disposeResolvers()
  context.disposeResolvers()
  assert.deepEqual(events, ["lsp:1", "graph:1"])
  await Promise.all([context.disposeProcesses(), context.dispose(), context.dispose()])
  assert.deepEqual(events, ["lsp:1", "graph:1", "terminal:session", "shells"])
})

test("one cleanup failure does not skip remaining owned resources", async () => {
  const { events, dependencies } = fixture()
  dependencies.disposeTerminalRepls = async () => {
    throw new Error("terminal cleanup")
  }
  const context = createToolSessionContext({ sessionId: "session", sendOptions: {} }, dependencies)
  await assert.rejects(context.dispose(), /terminal cleanup/)
  assert.deepEqual(events, ["lsp:1", "graph:1", "shells"])
})

test("host kill acknowledgement is not proof while jobs are still live or unreadable", async () => {
  for (const unreadable of [false, true]) {
    const context = createToolSessionContext({
      sessionId: "background",
      sendOptions: { processOrigin: { childRunId: "child", dispatchEpoch: 1 } },
      hostRpc: {
        async call(method) {
          if (method === "jobs.spawn") return { id: "job", startedAtMs: 1 }
          if (method === "jobs.killOwnedBy") return { killed: ["job"] }
          if (unreadable) throw new Error("host unavailable")
          return {
            originSessionId: "background",
            jobs: [{ id: "job", status: "running", startedAtMs: 1 }],
          }
        },
      },
    })
    await context.bgShells.spawnBackground({ command: "work", shell: "sh", shellArgs: [] })
    await assert.rejects(context.disposeProcesses(), /live background processes|host unavailable/)
  }
})

test("ordinary disposal preserves detached jobs; durable disposal reaps and verifies them", async () => {
  for (const durable of [false, true]) {
    let live = true
    const scopes: unknown[] = []
    const context = createToolSessionContext({
      sessionId: "origin",
      sendOptions: durable ? { processOrigin: { childRunId: "child", dispatchEpoch: 1 } } : {},
      hostRpc: {
        async call(method, raw) {
          const params = raw as { includeOrigin?: boolean }
          if (method === "jobs.spawn") return { id: "detached", startedAtMs: 1 }
          scopes.push(params)
          if (method === "jobs.killOwnedBy") {
            if (params.includeOrigin) live = false
            return { killed: live ? [] : ["detached"] }
          }
          return {
            ...(params.includeOrigin ? { originSessionId: "origin" } : {}),
            jobs: params.includeOrigin && live ? [{ id: "detached", status: "running" }] : [],
          }
        },
      },
    })
    await context.bgShells.spawnBackground({
      command: "work",
      shell: "sh",
      shellArgs: [],
      detach: true,
    })
    // Lifecycle power liveness includes detached leaders independently of
    // the owner-only scope used by ordinary disposal proof.
    assert.equal(await context.hasRunningProcesses(), true)
    assert.equal(await context.hasLiveProcesses(), durable)
    scopes.length = 0
    const listed = await context.bgShells.list()
    assert.equal(listed.length, durable ? 1 : 0)
    if (durable) assert.equal(listed[0]?.status, "running")
    await context.disposeProcesses()
    assert.equal(live, !durable)
    assert.ok(
      scopes.every(
        (scope) =>
          (scope as { includeOrigin?: boolean }).includeOrigin === (durable ? true : undefined)
      )
    )
  }
})

test("host cleanup waits for the supervisor to reap a job after its kill acknowledgement", async () => {
  let reads = 0
  const context = createToolSessionContext({
    sessionId: "reaping",
    sendOptions: {},
    hostRpc: {
      async call(method) {
        if (method === "jobs.spawn") return { id: "job", startedAtMs: 1 }
        if (method === "jobs.killOwnedBy") return { killed: ["job"] }
        reads++
        return {
          originSessionId: "reaping",
          jobs: reads === 1 ? [{ id: "job", status: "running", startedAtMs: 1 }] : [],
        }
      },
    },
  })
  await context.bgShells.spawnBackground({ command: "work", shell: "sh", shellArgs: [] })
  let stopped = false
  const proof = context.disposeProcesses().then(() => {
    stopped = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  await proof
  assert.equal(reads, 2)
  assert.equal(stopped, true)
})

test("a closed channel is unnecessary only when this session never admitted a spawn", async () => {
  const calls: string[] = []
  const context = createToolSessionContext({
    sessionId: "unused",
    sendOptions: {},
    hostRpc: {
      async call(method) {
        calls.push(method)
        throw new Error("No agent has been spawned")
      },
    },
  })
  await context.disposeProcesses()
  assert.deepEqual(calls, [])
})

test("an ordinary turn with no admitted processes needs no Host wake snapshot", async () => {
  const context = createToolSessionContext({
    sessionId: "idle",
    sendOptions: {},
    hostRpc: {
      async call() {
        throw new Error("No agent has been spawned")
      },
    },
  })
  assert.equal(await context.hasLiveProcesses(), false)
  await context.dispose()
})

test("an ambiguous spawn still requires an authoritative origin read", async () => {
  const context = createToolSessionContext({
    sessionId: "ambiguous",
    sendOptions: {},
    hostRpc: {
      async call() {
        throw new Error("host unavailable")
      },
    },
  })
  await assert.rejects(async () =>
    context.bgShells.spawnBackground({ command: "work", shell: "sh", shellArgs: [] })
  )
  await assert.rejects(context.disposeProcesses(), /host unavailable/)
})

test("Windows-shaped session disposal completes while proof remains unconfirmed", async () => {
  const context = createToolSessionContext({
    sessionId: "windows-proof",
    sendOptions: {},
    groupProofSupported: false,
  })
  const tool = asCallable(createBashTool(context.toolContext()))
  await tool.handler({ command: "exit 0" }, {})
  assert.equal(await context.hasRunningProcesses(), false)
  assert.equal(await context.hasLiveProcesses(), true)
  await context.dispose()
  assert.equal(await context.hasRunningProcesses(), false)
  assert.equal(await context.hasLiveProcesses(), true)
})
