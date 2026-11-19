#!/usr/bin/env node
/**
 * Synthetic counterexamples for the debugging-tools audit, not product tests.
 * Run from the repo root with node --test <this file>.
 * Passing assertions document current failures, not repaired behavior.
 * TypeScript is compiled from the current owning source. Only boundary ports
 * (native IPC, app version, section registry, storage, timers) are substituted.
 * No user files, providers or network endpoints are contacted.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import test from "node:test"
import vm from "node:vm"

const require = createRequire(resolve("package.json"))
const ts = require("typescript")

function loadTs(path, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: (id) => {
        if (Object.hasOwn(dependencies, id)) return dependencies[id]
        throw new Error(`Unstubbed import ${id} from ${path}`)
      },
      console,
      setInterval: () => 1,
      clearInterval: () => {},
      ...globals,
    },
    { filename: path }
  )
  return module.exports
}

const entry = (id, more = {}) => ({
  id,
  timestamp: "2026-11-17T00:00:00.000Z",
  level: "warn",
  module: "synthetic-audit",
  message: id,
  ...more,
})
const drain = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test("native retry silently discards 2 of 4 queued entries", async () => {
  const releases = []
  let calls = 0
  const { NativeTransport } = loadTs("lib/logging/transports/native-transport.ts", {
    "@/lib/tauri": { isTauri: () => true },
    "@/lib/native/native-logging": {
      forwardPlatformLoggingEntries: () => {
        calls++
        return calls <= 2 ? new Promise((done) => releases.push(done)) : Promise.resolve(false)
      },
    },
  })
  const transport = new NativeTransport({ batchSize: 2, flushInterval: 60000 })
  for (const id of ["a", "b", "c", "d"]) transport.log(entry(id))
  assert.equal(releases.length, 2)
  for (const release of releases) release(false)
  await drain()
  assert.equal(transport.getPendingCount(), 4)
  await transport.flush()
  assert.equal(transport.getPendingCount(), 2)
  assert.equal(transport.getHealth().droppedEntries, 0)
  console.info("native retry: queued 4 -> 2; droppedEntries remains 0")
  await transport.close()
})

test("native forwarding drops span and execution correlation fields", async () => {
  let payload
  const { NativeTransport } = loadTs("lib/logging/transports/native-transport.ts", {
    "@/lib/tauri": { isTauri: () => true },
    "@/lib/native/native-logging": {
      forwardPlatformLoggingEntries: async (rows) => {
        payload = rows[0]
        return true
      },
    },
  })
  const transport = new NativeTransport({ batchSize: 1 })
  transport.log(
    entry("correlated", {
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      parentSpanId: "3".repeat(16),
      executionId: "synthetic-execution",
      requestId: "synthetic-request",
    })
  )
  await drain()
  assert.equal(payload.traceId, "1".repeat(32))
  for (const field of ["spanId", "parentSpanId", "executionId", "requestId"]) {
    assert.equal(payload[field], undefined)
    assert.equal(payload.data?.[field], undefined)
  }
  console.info("native forwarding keeps traceId; loses spanId/parentSpanId/executionId/requestId")
  await transport.close()
})

test("legacy ambient async spans observe the other concurrent operation", async () => {
  const { logContext } = loadTs("packages/logging/src/context.ts")
  let releaseA, releaseB
  const a = logContext.withSpanAsync(
    () =>
      new Promise((done) => {
        releaseA = done
      })
  )
  const spanA = logContext.spanId
  const b = logContext.withSpanAsync(
    () =>
      new Promise((done) => {
        releaseB = done
      })
  )
  const spanB = logContext.spanId
  assert.notEqual(spanA, spanB)
  // If A logs now through an unscoped logger it inherits B's ambient span.
  assert.equal(logContext.spanId, spanB)
  releaseA()
  await a
  // A's finally popped B, so B now sees A's ambient span.
  assert.equal(logContext.spanId, spanA)
  releaseB()
  await b
  assert.equal(logContext.spanId, undefined)
  console.info(
    "legacy ambient context: A sees B; after A ends, B sees A. Explicit scoped loggers avoid this."
  )
})

function browser() {
  const jsdomRequire = createRequire(require.resolve("jest-environment-jsdom"))
  const { JSDOM, VirtualConsole } = jsdomRequire("jsdom")
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://audit.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  })
  let finish
  dom.window.fetch = () =>
    new Promise((done) => {
      finish = done
    })
  dom.window.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
  dom.window.eval(readFileSync("lib/browser/overlay.injected.js", "utf8"))
  dom.window.__cogniaSetPushEnabled(
    JSON.stringify({ console: false, network: false, snapshot: false })
  )
  return { dom, finish: () => finish({ status: 200, ok: true }) }
}

test("exact embedded overlay reports event counts as milliseconds", async () => {
  const { dom, finish } = browser()
  try {
    const started = performance.now()
    const slow = dom.window.fetch("https://audit.test/slow")
    await new Promise((done) => setTimeout(done, 120))
    finish()
    await slow
    const elapsed = Math.round(performance.now() - started)
    const slowRows = JSON.parse(dom.window.__cogniaDrainNetwork())
    assert.equal(slowRows[0].durationMs, 1)
    const noisy = dom.window.fetch("https://audit.test/noisy")
    for (let i = 0; i < 10; i++) dom.window.console.log("unrelated message")
    finish()
    await noisy
    const noisyRows = JSON.parse(dom.window.__cogniaDrainNetwork())
    assert.equal(noisyRows[0].durationMs, 11)
    console.info(`embedded timing: measured ${elapsed}ms -> 1ms; ten unrelated logs -> 11ms`)
  } finally {
    dom.window.close()
  }
})

test("exact embedded overlay reduces a standard Error to empty JSON", () => {
  const { dom } = browser()
  try {
    dom.window.console.error(new dom.window.Error("SYNTHETIC_AUTH_FAILED"))
    const rows = JSON.parse(dom.window.__cogniaDrainConsole())
    assert.equal(rows.at(-1).text, "{}")
    console.info("embedded console.error(Error): message and stack become {}")
  } finally {
    dom.window.close()
  }
})

test("plugin frontend normalization drops structured args and stack", () => {
  const source = readFileSync("lib/plugin/devtools/runtime-log-stream.ts", "utf8")
  const start = source.indexOf("export function normalizeFrontendEntry(")
  const end = source.indexOf("const PYTHON_LEVELS", start)
  assert.ok(start >= 0 && end > start)
  const { normalizeFrontendEntry } = (() => {
    const code = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText
    const module = { exports: {} }
    vm.runInNewContext(code, { module, exports: module.exports })
    return module.exports
  })()
  const input = {
    id: "audit",
    pluginId: "audit",
    generation: 1,
    level: "error",
    timestamp: 1,
    message: "request failed",
    args: [{ status: 502, reason: "upstream unavailable" }],
    stack: "Error: failed at synthetic-plugin.ts:42",
  }
  const output = normalizeFrontendEntry(input)
  assert.equal(output.args, undefined)
  assert.equal(output.stack, undefined)
  assert.ok(!JSON.stringify(output).includes("upstream unavailable"))
  console.info("plugin normalization: message preserved, structured args/stack absent")
})

test("support report scrubber misses header fields", async () => {
  const redact = loadTs("packages/redact/src/index.ts")
  const { buildSupportReport } = loadTs("lib/support-report/build.ts", {
    "@cognia/redact": redact,
    "@/lib/app-version": { APP_VERSION: "synthetic-audit" },
    "./sections": { listAvailableSupportReportSections: () => [] },
  })
  const report = await buildSupportReport({
    context: {
      surface: "error-page",
      route: "/probe/jane.doe@example.com",
      category: "render",
      error: { name: "Error", message: "synthetic", digest: "Bearer synthetic-only-test-token" },
    },
    generatedAt: "2026-11-17T00:00:00.000Z",
    sections: [],
  })
  assert.ok(report.markdown.includes("jane.doe@example.com"))
  assert.ok(report.markdown.includes("Bearer synthetic-only-test-token"))
  assert.equal(redact.hasNoLeakingPii(report.markdown), false)
  console.info("support report: header email/Bearer survive; final PII check would reject")
})

test("debug-session arming reports a session after storage rejected the write", () => {
  const { armTraceDebugSession, getTraceDebugSession, isTraceDebugArmed } = loadTs(
    "lib/observability/debug-session.ts",
    {},
    {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("synthetic quota failure")
        },
        removeItem: () => {},
      },
    }
  )
  const result = armTraceDebugSession({ tiers: ["rawBodies"] })
  assert.ok(result.expiresAt > result.startedAt)
  assert.equal(getTraceDebugSession(), null)
  assert.equal(isTraceDebugArmed("rawBodies"), false)
  console.info(
    "debug session: return value exists; actual snapshot is null and capture is disarmed"
  )
})
