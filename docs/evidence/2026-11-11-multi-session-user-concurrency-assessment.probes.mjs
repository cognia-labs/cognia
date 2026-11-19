/** Bounded, provider-free probes of broker admission and person-agent retention. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import vm from "node:vm"
const root = process.cwd()
const ts = createRequire(path.join(root, "package.json"))("typescript")
const sourcePath = "lib/execution/broker.ts"
const source = fs.readFileSync(path.join(root, sourcePath), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const exported = {}
vm.runInNewContext(compiled, {
  exports: exported,
  AbortController,
  require(name) {
    assert.equal(name, "@cognia/logging", "Only diagnostic logging may be substituted")
    return { createLogger: () => ({ debug() {}, error() {} }) }
  },
})
const { ExecutionBroker, DEFAULT_AI_TURN_LIMIT } = exported
let sequence = 0
const makeBroker = (limit = DEFAULT_AI_TURN_LIMIT) =>
  new ExecutionBroker({ limits: { "ai-turn": limit }, idFactory: () => `probe-${++sequence}` })
const request = (sessionId, extra = {}) => ({ kind: "chat", label: sessionId, sessionId, ...extra })
const counts = (broker) => {
  const entries = broker.list()
  return {
    running: entries.filter((entry) => entry.state === "running").length,
    queued: entries.filter((entry) => entry.state === "queued").length,
    permits: broker.permitsInUse(),
  }
}
const cases = []

const evaluateTs = (body, requirePort, globals = {}) => {
  const exports = {}
  vm.runInNewContext(
    ts.transpileModule(body, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    { exports, require: requirePort, AbortController, TextEncoder, ...globals }
  )
  return exports
}

{
  // Compose the real runner with the complete production addAgent method.
  // Adapter connection, storage, gateway and clock are injected I/O ports.
  const managerPath = "lib/ai/agent/external/manager.ts"
  const managerText = fs.readFileSync(managerPath, "utf8")
  const ast = ts.createSourceFile(managerPath, managerText, ts.ScriptTarget.Latest, true)
  const managerClass = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "ExternalAgentManager"
  )
  const addAgent = managerClass.members.find((node) => node.name?.getText(ast) === "addAgent")
  const defaults = ast.statements
    .flatMap((node) => (ts.isVariableStatement(node) ? [...node.declarationList.declarations] : []))
    .find((node) => node.name.getText(ast) === "DEFAULT_MANAGER_CONFIG")
  assert(addAgent && defaults?.initializer)
  const managerExports = evaluateTs(
    `export const defaults = ${defaults.initializer.getText(ast)}; export class ProbeManager { ${addAgent.getText(ast)} }`,
    () => {
      throw new Error("Unexpected manager import")
    },
    {
      createConfiguredProtocolAdapter: () => ({}),
      getExternalAgentExecutionBlock: () => undefined,
      normalizeExternalAgentValiditySnapshot: (value) => value,
      createUnknownSessionExtensionSupport: () => ({}),
      getExternalAgentEcosystemReadiness: () => ({}),
      protocolAdapterRegistry: { runtimePolicy: () => ({}) },
      externalAgentManagerLogger: { info() {} },
    }
  )
  const manager = new managerExports.ProbeManager()
  Object.assign(manager, {
    config: managerExports.defaults,
    instances: new Map(),
    adapters: new Map(),
    sessionCatalogs: new Map(),
    launchPreparer: async (value) => value,
    enrichConfigWithDynamicReadiness: async (value) => value,
    emitLifecycleEvent() {},
    connect: async () => {},
    removeAgent: async (id) => {
      manager.instances.delete(id)
      manager.adapters.delete(id)
    },
    async *executeStreaming(id) {
      yield { type: "session_start", sessionId: id }
      yield { type: "message_delta", sessionId: id, delta: { type: "text", text: "reply" } }
      yield { type: "done", sessionId: id, success: true, stopReason: "end_turn" }
    },
    cancel: async () => {},
    respondToPermission: async () => {},
    respondToElicitation: async () => {},
  })
  const liveFrames = evaluateTs(
    fs.readFileSync("lib/chat/transcript/live-frames.ts", "utf8"),
    () => {
      throw new Error("Unexpected live-frame import")
    }
  )
  const runnerModule = evaluateTs(
    fs.readFileSync("lib/headless/person-agent/runner.ts", "utf8"),
    (name) => {
      assert.equal(name, "@/lib/chat/transcript/live-frames")
      return liveFrames
    }
  )
  const broker = makeBroker()
  let ids = 0
  const timers = []
  const runner = runnerModule.createPersonAgentRunner({
    manager,
    broker,
    plane: { onStopped() {}, register() {}, release() {}, stopReason() {} },
    prepareLease: async () => ({ ticketId: "probe-ticket", secret: "synthetic", expiresAtMs: 1 }),
    ticketTokens: async () => ({ inputTokens: 0, outputTokens: 0, requests: 0, openRequests: 0 }),
    launchFor: () => ({
      config: { protocol: "acp", process: { command: "synthetic" } },
      family: "claude",
    }),
    history: async () => ({ text: "", visibilityDigest: "same", hasWithheld: false }),
    writeMessage: async () => {},
    removeMessage: async () => {},
    settle: async () => {},
    project: async () => {},
    recordUsage: async () => {},
    publishLive: async () => {},
    transcriptRevision: async () => 1,
    applyEvent: (parts, event) =>
      event.type === "message_delta" ? [...parts, { type: "text", text: event.delta.text }] : parts,
    pickAllowOption() {},
    newId: () => String(++ids),
    now: Date.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms }
      timers.push(timer)
      return timer
    },
    clearTimer() {},
    log() {},
  })
  const turn = (i) => ({
    session: { id: `retained-${i}` },
    runtimeId: "synthetic",
    provider: "test",
    model: "test",
    prompt: "hello",
    actionId: `action-${i}`,
    messageId: `message-${i}`,
  })
  const drain = async () => {
    for (let i = 0; i < 4; i++) await new Promise(setImmediate)
  }
  assert.equal(manager.config.maxConnections, 10)
  for (let i = 0; i < 10; i++) {
    await runner.startTurn(turn(i))
    await drain()
  }
  assert.equal(broker.countRunning(), 0)
  assert.equal(manager.instances.size, 10)
  await assert.rejects(runner.startTurn(turn(10)), /Maximum connections reached: 10/)
  assert.equal(broker.countRunning(), 0)
  await runner.close("retained-0")
  await runner.startTurn(turn(10))
  await drain()
  cases.push({
    name: "idle person-agent connections can exhaust manager capacity with zero active turns",
    retainedConnections: 10,
    activeTurnsAtRefusal: 0,
    refusedConversation: 11,
    refusal: "Maximum connections reached: 10",
    idleTtlMs: runnerModule.PERSON_AGENT_IDLE_MS,
    recoveredAfterClosingOne: !!runner.liveAgent("retained-10"),
    scope:
      "Real runner plus AST-extracted production addAgent and default config; all external I/O injected.",
  })
  await runner.closeAll()

  let finish
  const gate = new Promise((resolve) => {
    finish = resolve
  })
  manager.executeStreaming = async function* (id) {
    yield { type: "session_start", sessionId: id }
    yield { type: "message_delta", sessionId: id, delta: { type: "text", text: "reply" } }
    await gate
    yield { type: "done", sessionId: id, success: true, stopReason: "end_turn" }
  }
  await runner.startTurn(turn(20))
  await runner.startTurn(turn(21))
  await drain()
  assert.equal(broker.countRunning(), 2)
  assert(broker.list().every((entry) => entry.slotKey === undefined))
  assert(
    [...manager.instances.values()].every((entry) => entry.config.process.cwd === "/workspace")
  )
  cases.push({
    name: "two member agent conversations run without a shared workspace slot",
    activeTurns: broker.countRunning(),
    slotKeys: broker.list().map((entry) => entry.slotKey ?? null),
    workingDirectories: [...manager.instances.values()].map((entry) => entry.config.process.cwd),
    scope:
      "Admission reproduced with real runner; common personal Host mount established separately from Rust source. No filesystem writes.",
  })
  finish()
  await drain()
  await runner.closeAll()

  // The production method checks capacity before asynchronous preparation.
  let prepare
  const preparing = new Promise((resolve) => {
    prepare = resolve
  })
  manager.launchPreparer = async (config) => {
    await preparing
    return config
  }
  const registrations = Array.from({ length: 16 }, (_, i) =>
    manager.addAgent({
      id: `racing-${i}`,
      name: `racing-${i}`,
      protocol: "acp",
      enabled: false,
      process: { command: "synthetic" },
    })
  )
  assert.equal(manager.instances.size, 0)
  prepare()
  const registrationResults = await Promise.allSettled(registrations)
  assert.equal(registrationResults.filter((item) => item.status === "fulfilled").length, 16)
  assert.equal(manager.instances.size, 16)
  cases.push({
    name: "concurrent registration bypasses nominal manager threshold",
    configuredThreshold: 10,
    fulfilled: 16,
    rejected: 0,
    registrations: manager.instances.size,
    scope:
      "Complete AST-extracted production addAgent; injected asynchronous launch preparation barrier. No native processes.",
  })
  for (const id of [...manager.instances.keys()]) await manager.removeAgent(id)
  manager.launchPreparer = async (config) => config

  const holders = await Promise.all(
    Array.from({ length: 16 }, (_, i) => broker.acquire(request(`occupied-${i}`)))
  )
  let streamStarts = 0
  manager.executeStreaming = async function* (id) {
    streamStarts++
    yield { type: "session_start", sessionId: id }
    yield { type: "message_delta", sessionId: id, delta: { type: "text", text: "reply" } }
    yield { type: "done", sessionId: id, success: true, stopReason: "end_turn" }
  }
  await runner.startTurn(turn(30))
  await drain()
  assert.equal(counts(broker).queued, 1)
  assert.equal(streamStarts, 0)
  const abortResult = await runner.abort("retained-30")
  assert.equal(abortResult, false)
  await runner.closeAll()
  assert.equal(counts(broker).queued, 1)
  for (const holder of holders) holder.release("ok")
  await drain()
  assert.equal(streamStarts, 1)
  assert(runner.liveAgent("retained-30"))
  cases.push({
    name: "queued member turn starts after abort and closeAll returned",
    abortResult,
    queuedAfterCloseAll: 1,
    streamStartsAfterCapacityFrees: streamStarts,
    liveAgentAfterCloseAll: true,
    scope:
      "Real runner/broker; injected adapter and process plane. Native spawn after Host uninstall is not exercised.",
  })
  await runner.closeAll()
}

{
  // Exercise the complete production chat-lease glue, not a broker-only cancel.
  const listeners = new Set()
  const store = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const chatLeases = evaluateTs(fs.readFileSync("lib/execution/chat-lease.ts", "utf8"), (name) => {
    if (name === "./broker")
      return {
        ...exported,
        getExecutionBroker: () => {
          throw new Error("Inject broker explicitly")
        },
      }
    if (name === "@/stores/chat") return { useChatStore: store }
    if (name === "@/lib/claude/ipc") return { interruptSession: async () => {} }
    throw new Error(`Unexpected chat-lease import: ${name}`)
  })
  const broker = makeBroker(1)
  const slotKey = "dir:/synthetic/repo"
  await chatLeases.acquireChatLease(
    { sessionId: "fallback-a", label: "A", slotKey, providerId: "initial", providerLimit: 1 },
    broker
  )
  await chatLeases.switchChatLeaseProvider("fallback-a", "fallback", 1, broker)
  assert.equal(broker.permitsInUse(), 0)
  assert.equal(broker.slotHolder(slotKey), null)
  assert.equal(broker.list()[0].exempt, true)
  await chatLeases.acquireChatLease({ sessionId: "fallback-b", label: "B", slotKey }, broker)
  assert.equal(broker.countRunning(), 2)
  cases.push({
    name: "provider fallback loses original permit and directory slot",
    configuredPermits: 1,
    runningAfterSameSlotSecondSession: broker.countRunning(),
    afterFallback: { permits: 0, slotHolder: null, exempt: true },
    scope:
      "Production broker and chat-lease module, injected store/IPC; no model execution or file writes.",
  })
  chatLeases.__resetChatLeasesForTesting()

  await chatLeases.acquireChatLease({ sessionId: "stopping-a", label: "A", slotKey }, broker)
  for (const listener of listeners)
    listener({ sessions: { "stopping-a": { status: "streaming" } } })
  // Foreground Stop seals idle before dispatching/awaiting executor interrupt.
  for (const listener of listeners) listener({ sessions: { "stopping-a": { status: "idle" } } })
  assert.equal(broker.permitsInUse(), 0)
  assert.equal(broker.slotHolder(slotKey), null)
  await chatLeases.acquireChatLease({ sessionId: "stopping-b", label: "B", slotKey }, broker)
  assert.equal(broker.countRunning(), 1)
  cases.push({
    name: "optimistic idle releases directory before executor stop proof",
    releasedOnIdle: true,
    anotherSessionAdmitted: true,
    scope:
      "Real broker/chat-lease store watcher. Controller source establishes idle-before-interrupt ordering; native stop delay and writes not exercised.",
  })
  chatLeases.__resetChatLeasesForTesting()
}

{
  const slots = evaluateTs(fs.readFileSync("lib/execution/slot-key.ts", "utf8"), (name) => {
    throw new Error(`Unexpected slot-key import: ${name}`)
  })
  const aliased = `${root}/.`
  assert.equal(fs.realpathSync(root), fs.realpathSync(aliased))
  const keys = [slots.slotKeyForPath(root), slots.slotKeyForPath(aliased)]
  assert.notEqual(keys[0], keys[1])
  const broker = makeBroker(2)
  const leases = await Promise.all(
    keys.map((slotKey, i) => broker.acquire(request(`alias-${i}`, { slotKey })))
  )
  assert.equal(broker.countRunning(), 2)
  cases.push({
    name: "same physical directory aliases acquire different slots in one broker",
    equalRealpaths: true,
    differentSlotKeys: true,
    running: broker.countRunning(),
    scope:
      "Production slot-key/broker with realpath reads of the existing checkout only; no filesystem mutations.",
  })
  for (const lease of leases) lease.release("ok")
}

{
  const broker = makeBroker()
  const pending = Array.from({ length: 32 }, (_, i) => broker.acquire(request(`session-${i}`)))
  const observed = counts(broker)
  assert.deepEqual(observed, { running: 16, queued: 16, permits: 16 })
  await Promise.all(pending.map(async (pendingLease) => (await pendingLease).release("ok")))
  assert.equal(broker.list().length, 0)
  cases.push({ name: "32 independent sessions in one broker", observed })
}

{
  const brokers = Array.from({ length: 8 }, () => makeBroker())
  const pending = brokers.flatMap((broker, user) =>
    Array.from({ length: 17 }, (_, i) => broker.acquire(request(`user-${user}-session-${i}`)))
  )
  const perBroker = brokers.map(counts)
  assert(perBroker.every((entry) => entry.running === 16 && entry.queued === 1))
  const aggregate = perBroker.reduce(
    (sum, entry) => ({ running: sum.running + entry.running, queued: sum.queued + entry.queued }),
    { running: 0, queued: 0 }
  )
  assert.deepEqual(aggregate, { running: 128, queued: 8 })
  await Promise.all(pending.map(async (pendingLease) => (await pendingLease).release("ok")))
  cases.push({ name: "eight independent broker domains (no server or agents)", aggregate })
}

{
  const broker = makeBroker(2)
  const first = await broker.acquire(request("same-tree-a", { slotKey: "tree-a" }))
  const waiting = broker.acquire(request("same-tree-b", { slotKey: "tree-a" }))
  const other = await broker.acquire(request("other-tree", { slotKey: "tree-b" }))
  const observed = counts(broker)
  assert.deepEqual(observed, { running: 2, queued: 1, permits: 2 })
  first.release("ok")
  const admitted = await waiting
  other.release("ok")
  admitted.release("ok")
  cases.push({ name: "same-tree wait does not consume a shared permit", observed })
}

{
  const broker = makeBroker(4)
  const first = await broker.acquire(request("provider-a-1", { providerId: "a", providerLimit: 1 }))
  const waiting = broker.acquire(request("provider-a-2", { providerId: "a", providerLimit: 1 }))
  const other = await broker.acquire(request("provider-b", { providerId: "b", providerLimit: 1 }))
  const observed = counts(broker)
  assert.deepEqual(observed, { running: 2, queued: 1, permits: 2 })
  first.release("ok")
  const admitted = await waiting
  other.release("ok")
  admitted.release("ok")
  cases.push({ name: "one saturated provider does not block another provider", observed })
}

{
  const broker = makeBroker(1)
  const running = await broker.acquire(request("running"))
  const waiting = broker.acquire(request("queued"))
  const rejected = assert.rejects(waiting, /cancelled while queued/)
  broker.cancelBySession("queued")
  await rejected
  broker.cancelBySession("running")
  assert.equal(running.signal.aborted, true)
  assert.equal(broker.permitsInUse(), 1, "Cancellation alone is not executor settlement")
  running.release("cancelled")
  assert.equal(broker.permitsInUse(), 0)
  cases.push({ name: "queued cancellation and running settlement", heldUntilRelease: true })
}

{
  const broker = makeBroker(1)
  const first = await broker.acquire(request("continuing"))
  const continuation = await broker.acquire(request("continuing"))
  assert.equal(continuation.exempt, true)
  assert.deepEqual(counts(broker), { running: 2, queued: 0, permits: 1 })
  continuation.release("ok")
  first.release("ok")
  cases.push({
    name: "continuation legs are not independent active-turn capacity",
    running: 2,
    permits: 1,
  })
}

{
  const broker = makeBroker()
  const pending = Array.from({ length: 1024 }, (_, i) =>
    broker.acquire(request(`backlog-${i}`)).catch((error) => error)
  )
  const observed = counts(broker)
  assert.deepEqual(observed, { running: 16, queued: 1008, permits: 16 })
  broker.cancelAll()
  for (const item of await Promise.all(pending))
    if (typeof item.release === "function") item.release("cancelled")
  assert.equal(broker.list().length, 0)
  cases.push({ name: "1024 requests accepted without a queue-length refusal", observed })
}

const benchmark = []
for (const sessions of [64, 256, 1024]) {
  for (const snapshotSubscriber of [false, true]) {
    const runs = []
    for (let trial = 0; trial < 3; trial++) {
      const broker = makeBroker()
      if (snapshotSubscriber) broker.subscribe(() => broker.getSnapshot())
      const started = performance.now()
      const pending = Array.from({ length: sessions }, (_, i) =>
        broker.acquire(request(`bench-${i}`))
      )
      await Promise.all(pending.map(async (pendingLease) => (await pendingLease).release("ok")))
      runs.push(Number((performance.now() - started).toFixed(3)))
      assert.equal(broker.list().length, 0)
    }
    benchmark.push({ sessions, snapshotSubscriber, totalControlMs: runs })
  }
}

const hashPaths = [
  sourcePath,
  "lib/execution/chat-lease.ts",
  "lib/execution/session-turn-lock.ts",
  "lib/execution/slot-key.ts",
  "lib/workspace/effective-cwd.ts",
  "lib/claude/routing-fallback.ts",
  "lib/claude/ipc.ts",
  "hooks/chat/use-claude-chat-controller.ts",
  "lib/headless/person-agent/runner.ts",
  "lib/headless/runtimes/person-agent.ts",
  "lib/headless/person-agent/index.ts",
  "lib/sync/host-state-service.ts",
  "components/execution/execution-monitor-panel.tsx",
  "crates/cognia-companion-rpc/src/person_execution.rs",
  "crates/cognia-companion-rpc/src/rpc/service_plane.rs",
  "crates/cognia-companion/src/host_surface_gate.rs",
  "crates/cognia-companion/src/person_partition.rs",
  "crates/cognia-companion/src/ws_bridge.rs",
  "crates/cognia-companion/src/environment_pool.rs",
  "crates/cognia-sandbox-pool/src/docker.rs",
  "crates/cognia-external-agent/src/person_workspace.rs",
  "lib/ai/agent/external/manager.ts",
  "lib/chat/transcript/live-frames.ts",
  "crates/cognia-server/src/persons.rs",
  "crates/cognia-server/src/brain.rs",
  "crates/cognia-server/src/main.rs",
  "crates/cognia-server/src/tenant_lease.rs",
  "crates/cognia-gateway/src/types.rs",
  "crates/cognia-gateway/src/server.rs",
  "crates/cognia-gateway/src/concurrency.rs",
  "crates/cognia-gateway/src/route_ticket.rs",
  "crates/cognia-environment/src/baseline.rs",
  "crates/cognia-external-agent/src/container_backend.rs",
  "cli/src/serve/persistence/sqlite.ts",
  "cli/src/serve/persistence/store.ts",
]
const result = {
  scope:
    "Real broker/runner/live-frame code transpiled in a VM plus AST-extracted production manager addAgent/defaults. Logging and external I/O ports injected. No UI, database, Host process, model, network or agent work.",
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
  },
  cases,
  benchmark,
  hashes: Object.fromEntries(
    hashPaths.map((file) => [
      file,
      createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    ])
  ),
}
const output = path.join(root, ".cache/multi-session-user-concurrency/2026-11-11/probes.json")
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify({ output, ...result }, null, 2))
