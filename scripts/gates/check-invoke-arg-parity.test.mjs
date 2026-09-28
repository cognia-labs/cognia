import { test } from "node:test"
import assert from "node:assert/strict"

import {
  analyze,
  collectRepositoryFindings,
  diffAgainstBaseline,
  readBaseline,
} from "./check-invoke-arg-parity.mjs"
import { findInvokeCallSites, objectLiteralKeys } from "./lib/invoke-call-sites.mjs"

const command = (name, params, channelParams = []) => ({
  name,
  file: `crates/x/src/${name}.rs`,
  line: 1,
  params,
  channelParams,
  returnType: "Result<()>",
})

const site = (source) => findInvokeCallSites(source, "lib/x.ts")

// ---------------------------------------------------------------------------
// Argument-object parsing
// ---------------------------------------------------------------------------

test("reads shorthand, explicit, and quoted top-level keys", () => {
  assert.deepEqual(objectLiteralKeys(`a, b: 1, "c-d": 2`).keys, ["a", "b", "c-d"])
})

test("ignores keys nested inside objects, arrays, and calls", () => {
  const { keys } = objectLiteralKeys(`
    outer: { inner: 1, deeper: { deepest: 2 } },
    list: [{ nested: 3 }],
    made: build({ hidden: 4 }),
    tail: 5
  `)
  assert.deepEqual(keys, ["outer", "list", "made", "tail"])
})

test("notes a spread rather than pretending the keys are complete", () => {
  const parsed = objectLiteralKeys(`a: 1, ...rest, b: 2`)
  assert.equal(parsed.hasSpread, true)
  assert.deepEqual(parsed.keys, ["a", "b"])
})

test("a brace or colon inside a string does not confuse the scan", () => {
  assert.deepEqual(objectLiteralKeys(`url: "https://x/{y}:z", after: 1`).keys, ["url", "after"])
})

test("classifies the second argument as object, opaque, or none", () => {
  assert.equal(site(`invoke("a", { x: 1 })`)[0].kind, "object")
  assert.equal(site(`invoke("a", args)`)[0].kind, "opaque")
  assert.equal(site(`invoke("a")`)[0].kind, "none")
  assert.equal(site(`invoke<Result>("a", { x: 1 })`)[0].kind, "object")
})

test("records the command name and line of each call site", () => {
  const found = site(`const x = 1\nawait invoke("plugin_load", { pluginId })`)
  assert.equal(found[0].command, "plugin_load")
  assert.equal(found[0].line, 2)
  assert.deepEqual(found[0].keys, ["pluginId"])
})

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

test("the plugin_install shape mismatch is exactly what this gate exists to catch", () => {
  // manager.ts sent { source, installType, pluginDir } against a signature of
  // (plugin_id, source, payload). Neither pluginId nor payload crossed the
  // wire, and every test covering the path mocked invoke().
  const findings = analyze(
    site(`invoke("plugin_install", { source, installType: type, pluginDir: dir })`),
    new Map([
      [
        "plugin_install",
        command("plugin_install", [
          { name: "plugin_id", type: "String" },
          { name: "source", type: "String" },
          { name: "payload", type: "InstallPayload" },
        ]),
      ],
    ])
  )
  const keys = findings.map((f) => f.key.split(":").slice(-2).join(":"))
  assert.deepEqual(keys.sort(), [
    "missing-argument:payload",
    "missing-argument:plugin_id",
    "unknown-argument:installType",
    "unknown-argument:pluginDir",
  ])
})

test("camelCase and snake_case are the same argument", () => {
  // Tauri deserializes `plugin_id` from the JS `pluginId`; that is not a defect.
  assert.deepEqual(
    analyze(
      site(`invoke("x", { pluginId: id })`),
      new Map([["x", command("x", [{ name: "plugin_id", type: "String" }])]])
    ),
    []
  )
})

test("an Option parameter may be omitted", () => {
  assert.deepEqual(
    analyze(
      site(`invoke("x", { a: 1 })`),
      new Map([
        [
          "x",
          command("x", [
            { name: "a", type: "String" },
            { name: "b", type: "Option<String>" },
          ]),
        ],
      ])
    ),
    []
  )
})

test("a Channel parameter is a legitimate key and never a missing one", () => {
  // parseTauriCommands splits channels out of `params` because they are not
  // JSON payload, but the caller really does pass one.
  assert.deepEqual(
    analyze(
      site(`invoke("x", { input })`),
      new Map([["x", command("x", [{ name: "input", type: "Input" }], ["on_event"])]])
    ),
    []
  )
  assert.deepEqual(
    analyze(
      site(`invoke("x", { input, onEvent })`),
      new Map([["x", command("x", [{ name: "input", type: "Input" }], ["on_event"])]])
    ),
    []
  )
})

test("a spread suppresses the missing-argument half but not the unknown half", () => {
  const commands = new Map([["x", command("x", [{ name: "a", type: "String" }])]])
  assert.deepEqual(analyze(site(`invoke("x", { ...rest })`), commands), [])

  const findings = analyze(site(`invoke("x", { ...rest, bogus: 1 })`), commands)
  assert.equal(findings.length, 1)
  assert.match(findings[0].key, /unknown-argument:bogus$/)
})

test("an opaque argument object is skipped rather than guessed at", () => {
  assert.deepEqual(
    analyze(
      site(`invoke("x", buildArgs())`),
      new Map([["x", command("x", [{ name: "a", type: "String" }])]])
    ),
    []
  )
})

test("an unregistered command is command-parity's finding, not ours", () => {
  assert.deepEqual(analyze(site(`invoke("nope", { a: 1 })`), new Map()), [])
})

// ---------------------------------------------------------------------------
// Ratchet
// ---------------------------------------------------------------------------

test("the ratchet reports new findings and celebrates fixed ones", () => {
  const findings = [{ key: "f/a.ts:cmd:unknown-argument:x", detail: "…" }]
  assert.deepEqual(diffAgainstBaseline(findings, []).added, findings)
  assert.deepEqual(diffAgainstBaseline(findings, [findings[0].key]).added, [])
  assert.deepEqual(diffAgainstBaseline([], [findings[0].key]).removed, [findings[0].key])
})

test("the committed baseline still matches the repository", () => {
  // The gate's whole value is this equality. If it drifts, either a call site
  // was fixed (rerun with --write-baseline) or a new mismatch landed.
  assert.deepEqual(diffAgainstBaseline(collectRepositoryFindings(), readBaseline()).added, [])
})

test("the motivating defects are in the baseline, not silently absent", () => {
  // plugin_install and plugin_show_notification are real, load-bearing
  // mismatches this gate found. If a refactor makes them vanish from the
  // scan rather than from the code, this notices.
  const baseline = readBaseline()
  assert.ok(
    baseline.some((key) => key.includes("plugin_install:missing-argument:payload")),
    "plugin_install's dropped payload should be recorded"
  )
  assert.ok(
    baseline.some((key) => key.includes("plugin_show_notification:missing-argument:args")),
    "plugin_show_notification's flattened args should be recorded"
  )
})
