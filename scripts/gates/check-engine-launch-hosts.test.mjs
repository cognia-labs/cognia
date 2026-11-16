import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import {
  HOST_DIRECTORIES,
  OWNED_RUNTIME_MODULES,
  engineLiterals,
  engineVocabulary,
  productionSource,
  runChecks,
} from "./check-engine-launch-hosts.mjs"

const table = {
  engines: [
    { id: "npx", match: { kind: "base", values: ["npx"] } },
    { id: "crush", match: { kind: "base", values: ["crush"] } },
    {
      id: "kimi",
      match: { kind: "base", values: ["kimi"] },
      isolation: { env: { KIMI_CODE_HOME: "kimi", XDG_DATA_HOME: "data" }, denyReadable: [] },
      env: { keys: ["KIMI_MODEL_NAME"], reviewedPrefixes: ["KIMI_"], secret: ["KIMI_BLOB"] },
    },
  ],
}

test("the vocabulary names each engine's commands and keys, not runners, bridges or platform keys", () => {
  const vocabulary = engineVocabulary(table)
  for (const literal of ["kimi", "KIMI_CODE_HOME", "KIMI_MODEL_NAME", "KIMI_", "KIMI_BLOB"])
    assert.equal(vocabulary.get(literal), "kimi")
  for (const literal of ["npx", "crush", "XDG_DATA_HOME"])
    assert.equal(vocabulary.has(literal), false)
})

test("only production code counts: comments and the Rust test module are ignored", () => {
  const source = [
    'let a = "kimi"; // "KIMI_CODE_HOME" in a comment',
    '/* "KIMI_MODEL_NAME" */ let b = `KIMI_`',
    "#[cfg(test)]",
    "mod tests {",
    '    const C: &str = "kimi";',
    "}",
  ].join("\n")
  assert.ok(!productionSource(source).join("\n").includes("mod tests"))
  assert.deepEqual(engineLiterals(source, engineVocabulary(table)), [
    { line: 1, literal: "kimi", engine: "kimi" },
    { line: 2, literal: "KIMI_", engine: "kimi" },
  ])
})

test("the repository's process hosts name no engine", () => {
  assert.deepEqual(runChecks(), [])
})

test("a host file naming an engine fails, and owned runtime modules and tests are exempt", () => {
  const root = mkdtempSync(join(tmpdir(), "engine-launch-hosts-"))
  try {
    const write = (relative, text) => {
      mkdirSync(dirname(join(root, relative)), { recursive: true })
      writeFileSync(join(root, relative), text)
    }
    write("protocol/external-agent-launch.json", JSON.stringify(table))
    for (const directory of HOST_DIRECTORIES) mkdirSync(join(root, directory), { recursive: true })
    for (const owned of OWNED_RUNTIME_MODULES.keys()) write(owned, 'const A = "kimi"')
    write("cli/src/runtime/external/node-backend.test.ts", 'const A = "kimi"')
    write("crates/cognia-external-agent/src/process.rs", 'if base == "kimi" {}')
    assert.deepEqual(runChecks(root), [
      `crates/cognia-external-agent/src/process.rs:1: "kimi" names kimi; declare it in the engine's launch descriptor`,
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
