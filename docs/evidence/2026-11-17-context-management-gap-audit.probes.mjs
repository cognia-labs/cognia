#!/usr/bin/env node
/**
 * Synthetic audit probes of current product modules. Assertions deliberately
 * describe defects/limits; passing here does not mean the product is correct.
 * No source rewrites, model calls, real data, or persistent state are used.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(resolve(root, "package.json"))
const ts = require("typescript")

function loadSource(path, stubs = {}) {
  const source = readFileSync(resolve(root, path), "utf8")
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: path,
  }).outputText
  const cjsModule = { exports: {} }
  new Function("require", "module", "exports", code)(
    (id) => (Object.hasOwn(stubs, id) ? stubs[id] : require(id)),
    cjsModule,
    cjsModule.exports
  )
  return cjsModule.exports
}

const { buildContextSourceBreakdown } = loadSource("lib/analysis/context-source-breakdown.ts")
const message = (parts) => [{ id: "synthetic", role: "assistant", parts }]
const assistant = buildContextSourceBreakdown(
  message([{ type: "text", text: "x".repeat(400_000) }])
)
assert.equal(assistant.totalTokens, 0)
console.log("F07a: 400,000 characters of assistant text -> 0 attributed tokens")

const objectResult = buildContextSourceBreakdown(
  message([{ type: "tool-Read", input: {}, output: { content: "x".repeat(400_000) } }])
)
const emptyResult = buildContextSourceBreakdown(
  message([{ type: "tool-Read", input: {}, output: {} }])
)
assert.deepEqual(objectResult, emptyResult)
console.log("F07b: 400,000-character structured tool output -> same attribution as empty object")

const { collectContextContributions, __resetContextContributionsForTests } = loadSource(
  "lib/ai/agent/execution/contributions/context-contributions.ts",
  {
    "@cognia/redact": { hasNoLeakingPii: () => true },
    "@cognia/logging": { loggers: { agent: { warn() {} } } },
    "@/lib/modules/generated/context": { MODULE_CONTEXT_CONTRIBUTIONS: [] },
  }
)
const ctx = {
  session: { id: "synthetic" },
  agent: null,
  settings: { compaction: { contextWindow: 1_000 } },
  activeGoal: null,
  prompts: { snapshot: null, context: {} },
  host: "desktop",
  activeProject: null,
  query: { text: "synthetic", embedding: null },
  hostDeps: {},
  grant: null,
  kernelRetrieval: { identityTexts: [] },
}
const entries = Array.from({ length: 3 }, (_, i) => ({
  module: `synthetic-${i}`,
  stage: "stable",
  load: async () => ({
    contributions: [
      {
        id: "large",
        cache: "turn",
        produce: () => ({ text: "x".repeat(524_288) }),
      },
    ],
  }),
}))
const collected = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
assert.equal(
  collected.tail.reduce((n, text) => n + text.length, 0),
  1_572_864
)
assert.equal(collected.skipped.length, 0)
console.log(
  "G01: collector accepts 1,572,864 characters across three contributions without allocation"
)

__resetContextContributionsForTests()
let producerFinished = false
const timed = await collectContextContributions(ctx, { cacheOptimization: true }, [
  {
    module: "synthetic-timeout",
    stage: "stable",
    load: async () => ({
      contributions: [
        {
          id: "late",
          cache: "turn",
          deadlineMs: 5,
          produce: async () => {
            await new Promise((done) => setTimeout(done, 40))
            producerFinished = true
            return { text: "too late" }
          },
        },
      ],
    }),
  },
])
assert.equal(timed.skipped.length, 1)
assert.equal(producerFinished, false)
await new Promise((done) => setTimeout(done, 60))
assert.equal(producerFinished, true)
console.log("G02: deadline skips the contribution but its producer continues running")
console.log("4 synthetic audit probes completed; no product files or real data changed")
