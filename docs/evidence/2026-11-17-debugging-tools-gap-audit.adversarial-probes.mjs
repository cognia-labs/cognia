#!/usr/bin/env node
/** Synthetic adversarial checks against current source; no external sends. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import test from "node:test"
import vm from "node:vm"

const require = createRequire(resolve("package.json"))
const ts = require("typescript")
const { JSDOM } = createRequire(require.resolve("jest-environment-jsdom"))("jsdom")

function loadTs(path, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: (id) => {
        if (Object.hasOwn(dependencies, id)) return dependencies[id]
        throw new Error(`Unmapped dependency ${id} from ${path}`)
      },
      console,
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      ...globals,
    },
    { filename: path }
  )
  return module.exports
}

test("failed canonical capture loses sealed tail while close resolves", async () => {
  const redact = loadTs("packages/redact/src/index.ts")
  // These validators are re-exported through agent-config-types/plugin-contract.
  const execution = loadTs("packages/agent-contracts/src/canonical-event.ts")
  const usage = loadTs("lib/usage/usage-info.ts")
  const envelope = loadTs("lib/ai/agent/execution/event-envelope.ts", {
    "@cognia/agent-config-types/agent-execution": execution,
    "@/lib/usage/usage-info": usage,
    "@cognia/redact": redact,
  })
  const projection = loadTs("lib/chat/canonical-projection.ts", {
    "@/lib/ai/chat/usage-normalize": loadTs("lib/ai/chat/usage-normalize.ts"),
  })
  const debug = loadTs("lib/observability/debug-session.ts")
  const warnings = []
  const persisted = []
  let calls = 0
  let attemptedBatch = []
  const sink = loadTs(
    "lib/chat/canonical-sink.ts",
    {
      "@/lib/ai/agent/recovery/canonical-log": {
        appendCanonicalEnvelopes: async (_runId, batch) => {
          calls++
          if (calls === 1) {
            attemptedBatch = batch
            throw new Error("synthetic IndexedDB quota failure")
          }
          persisted.push(...batch)
          return batch.length
        },
      },
      "@/lib/ai/agent/execution/event-envelope": envelope,
      "@/lib/observability/debug-session": debug,
      "./canonical-projection": projection,
    },
    { console: { ...console, warn: (...args) => warnings.push(args) } }
  )

  sink.openChatCanonicalLog({ sessionId: "audit-session", runId: "lost-run" })
  sink.recordChatCanonicalEvents("audit-session", [
    { kind: "warning", code: "synthetic-marker", message: "reproduction evidence" },
  ])
  await sink.closeChatCanonicalLog("audit-session")
  assert.equal(calls, 1)
  assert.equal(attemptedBatch.length, 3)
  assert.equal(persisted.length, 0)
  assert.equal(warnings.length, 1)
  assert.equal(sink.chatCanonicalRunId("audit-session"), undefined)
  await sink.closeChatCanonicalLog("audit-session")
  assert.equal(calls, 1)
  sink.openChatCanonicalLog({ sessionId: "audit-session", runId: "next-run" })
  await sink.closeChatCanonicalLog("audit-session")
  assert.equal(calls, 2)
  assert.equal(persisted.length, 2)
  assert.ok(persisted.every((item) => item.runId === "next-run"))
  console.info(
    "canonical capture: 3 failed events not retried; close resolves; only console warning"
  )
})

test("later-turn trace is assigned the first user prompt of the session", async () => {
  const { resolveTracePrompts } = loadTs("lib/ai/eval/trace-prompt.ts")
  const prompts = await resolveTracePrompts(
    [
      { traceId: "first-turn", sessionId: "audit-session" },
      { traceId: "second-turn", sessionId: "audit-session" },
    ],
    async () => [
      { role: "user", parts: [{ type: "text", text: "FIRST successful request" }] },
      { role: "assistant", parts: [{ type: "text", text: "FIRST answer" }] },
      { role: "user", parts: [{ type: "text", text: "SECOND failing request" }] },
    ]
  )
  assert.equal(prompts["first-turn"], "FIRST successful request")
  assert.equal(prompts["second-turn"], "FIRST successful request")
  console.info("trace-to-eval: both turns use FIRST request; SECOND failing request is lost")
})

test("real Storage quota rejection leaves an empty debug session disarmed", () => {
  const dom = new JSDOM("", { url: "https://audit.test", storageQuota: 100 })
  try {
    const debug = loadTs(
      "lib/observability/debug-session.ts",
      {},
      {
        localStorage: dom.window.localStorage,
      }
    )
    const returned = debug.armTraceDebugSession({ tiers: ["rawBodies"] })
    assert.ok(returned.expiresAt > returned.startedAt)
    assert.equal(debug.getTraceDebugSessionSnapshot(), null)
    assert.equal(debug.isTraceDebugArmed("rawBodies"), false)
    console.info("real quota: arm returns a record; actual UI snapshot is null")
  } finally {
    dom.window.close()
  }
})

test("failed narrower arm preserves the old broad session instead of disarming", () => {
  const now = Date.now()
  const key = "cognia.observability.trace-debug-session"
  const old = {
    startedAt: now - 60_000,
    expiresAt: now + 3_540_000,
    tiers: ["deltas", "prompts", "toolDetails", "rawBodies"],
  }
  const raw = JSON.stringify(old)
  const dom = new JSDOM("", { url: "https://audit.test", storageQuota: key.length + raw.length })
  try {
    dom.window.localStorage.setItem(key, raw)
    const debug = loadTs(
      "lib/observability/debug-session.ts",
      {},
      {
        localStorage: dom.window.localStorage,
      }
    )
    const target = "narrow-target-".repeat(20)
    const returned = debug.armTraceDebugSession(
      {
        durationMs: 60_000,
        tiers: ["prompts"],
        sessionId: target,
      },
      now
    )
    assert.equal(returned.sessionId, target)
    assert.equal(debug.getTraceDebugSession(now).sessionId, undefined)
    assert.equal(debug.getTraceDebugSession(now).expiresAt, old.expiresAt)
    assert.equal(debug.isTraceDebugArmed("toolDetails", "unrelated-chat", now), true)
    assert.equal(dom.window.localStorage.getItem(key), raw)
    console.info("failed narrowing: old all-tier unscoped session remains active for 59 minutes")
  } finally {
    dom.window.close()
  }
})

test("native retry loss remains with the actual platform IPC wrapper", async () => {
  const releases = []
  let calls = 0
  const native = loadTs("lib/native/native-logging.ts", {
    "@tauri-apps/api/core": {
      invoke: async () => {
        calls++
        if (calls <= 2) await new Promise((done) => releases.push(done))
        throw new Error("synthetic native invocation failure")
      },
    },
    "@/lib/tauri": { isTauri: () => true },
    "./native-logging-readiness": {},
  })
  const { NativeTransport } = loadTs("lib/logging/transports/native-transport.ts", {
    "@/lib/native/native-logging": native,
    "@/lib/tauri": { isTauri: () => true },
  })
  const transport = new NativeTransport({ batchSize: 2 })
  for (const id of ["a", "b", "c", "d"]) {
    transport.log({ id, message: id, level: "warn", module: "audit" })
  }
  assert.equal(releases.length, 2)
  for (const release of releases) release()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(transport.getPendingCount(), 4)
  await transport.flush()
  assert.equal(transport.getPendingCount(), 2)
  assert.equal(transport.getHealth().droppedEntries, 0)
  await transport.close()
  console.info("native real wrapper: IPC rejects; pending 4 -> 2; droppedEntries=0")
})
