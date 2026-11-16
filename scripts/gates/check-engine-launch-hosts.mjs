#!/usr/bin/env node
/**
 * Gate: the external-agent process hosts name no engine (ADR-0217).
 *
 * Engines declare what they need from the process host in their own packages
 * (`EngineLaunchDescriptor`, generated into `protocol/external-agent-launch.json`);
 * `crates/cognia-external-agent` and `cli/src/runtime/external` interpret those
 * descriptors and never recognise an engine themselves. This gate fails when a
 * host source spells an engine out in a string literal: its id or command, a
 * state, credential or env key it declares, or one of its env families by its
 * prefix. Model-provider keys several engines read (`OPENAI_API_KEY`) are not an
 * engine's. The fix is a descriptor field the hosts interpret generically,
 * never a literal.
 *
 * Out of scope, as Cognia-owned runtimes with their own registered modules: the
 * native bridges (Codebuff, Crush, Hermes), the DeepSeek Harness runtime and the
 * gateway task. Their engines' names may appear where the host drives them.
 * Tests may name engines: they exercise the descriptors.
 *
 * Usage: node scripts/gates/check-engine-launch-hosts.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const HOST_DIRECTORIES = ["crates/cognia-external-agent/src", "cli/src/runtime/external"]

/** Host modules that own a Cognia runtime rather than interpret descriptors. */
export const OWNED_RUNTIME_MODULES = new Map([
  ["crates/cognia-external-agent/src/native_bridge.rs", "native bridge registry"],
  ["cli/src/runtime/external/native-bridges.ts", "native bridge registry"],
  ["cli/src/runtime/external/hermes-acp-bridge.ts", "Hermes native bridge"],
  ["cli/src/runtime/external/hermes-gateway-probe.ts", "Hermes native bridge"],
  ["crates/cognia-external-agent/src/dsh_runtime.rs", "DeepSeek Harness runtime"],
  ["cli/src/runtime/external/dsh-installer.ts", "DeepSeek Harness runtime"],
  ["crates/cognia-external-agent/src/gateway_task.rs", "gateway task"],
  ["cli/src/runtime/external/gateway-task.ts", "gateway task"],
  ["cli/src/runtime/external/codex-model-catalog.ts", "re-export of the Codex package"],
])

/** Engines whose runtime is a registered native bridge the host drives. */
export const NATIVE_BRIDGE_ENGINES = new Set(["codebuff", "crush", "hermes-agent"])

/** Launch runners the host itself declares (`lib/ai/agent/external/policy/launch-runners.ts`). */
const HOST_RUNNERS = new Set(["npx"])

/** The XDG Base Directory keys are the platform's, whichever engine relocates them. */
const PLATFORM_ENV = /^XDG_/

/**
 * Every literal that names an engine, with the engine it names.
 * @param {{ engines: object[] }} table
 * @returns {Map<string, string>}
 */
export function engineVocabulary(table) {
  const exact = new Map()
  const addExact = (value, id) => {
    if (value && !PLATFORM_ENV.test(value) && !exact.has(value)) exact.set(value, id)
  }
  for (const engine of table.engines) {
    const { id } = engine
    if (HOST_RUNNERS.has(id) || NATIVE_BRIDGE_ENGINES.has(id)) continue
    addExact(id, id)
    for (const value of engine.match.values) addExact(value, id)
    for (const key of Object.keys(engine.isolation?.env ?? {})) addExact(key, id)
    for (const key of Object.keys(engine.isolation?.setEnv ?? {})) addExact(key, id)
    for (const key of engine.relocation?.env ?? []) addExact(key, id)
    for (const key of Object.keys(engine.relocation?.setEnv ?? {})) addExact(key, id)
    for (const key of engine.env?.keys ?? []) addExact(key, id)
    for (const key of engine.env?.privateBlank ?? []) addExact(key, id)
    for (const key of engine.env?.secret ?? []) addExact(key, id)
    if (engine.companion) addExact(engine.companion.env, id)
    for (const prefix of [...(engine.env?.prefixes ?? []), ...(engine.env?.reviewedPrefixes ?? [])])
      addExact(prefix, id)
  }
  return exact
}

/** The source without its Rust test module and comments, line numbers kept. */
export function productionSource(source) {
  const tests = source.search(/#\[cfg\(test\)\]\s*mod tests\b/)
  const code = tests >= 0 ? source.slice(0, tests) : source
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
}

/**
 * The engine literals in one host source.
 * @returns {{ line: number, literal: string, engine: string }[]}
 */
export function engineLiterals(source, vocabulary) {
  const found = []
  productionSource(source).forEach((line, index) => {
    for (const match of line.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n$]|\\.)*)`/g)) {
      const literal = match[1] ?? match[2]
      const engine = vocabulary.get(literal)
      if (engine) found.push({ line: index + 1, literal, engine })
    }
  })
  return found
}

export function runChecks(root = REPO_ROOT) {
  const table = JSON.parse(readFileSync(join(root, "protocol/external-agent-launch.json"), "utf8"))
  const vocabulary = engineVocabulary(table)
  const errors = []
  for (const owned of OWNED_RUNTIME_MODULES.keys())
    if (!existsSync(join(root, owned)))
      errors.push(`${owned}: listed as an owned runtime module but missing; drop it from the gate`)
  for (const directory of HOST_DIRECTORIES) {
    for (const name of readdirSync(join(root, directory))) {
      const file = `${directory}/${name}`
      if (!/\.(?:rs|ts|mjs)$/.test(name) || /\.test\.ts$/.test(name)) continue
      if (OWNED_RUNTIME_MODULES.has(file)) continue
      if (name === "stub-acp-agent.mjs") continue
      for (const { line, literal, engine } of engineLiterals(
        readFileSync(join(root, file), "utf8"),
        vocabulary
      ))
        errors.push(
          `${file}:${line}: "${literal}" names ${engine}; declare it in the engine's launch descriptor`
        )
    }
  }
  return errors
}

if (process.argv[1] && process.argv[1].endsWith("check-engine-launch-hosts.mjs")) {
  const errors = runChecks()
  if (errors.length > 0) {
    console.error("[engine-launch-hosts] a process host names an engine:\n")
    for (const error of errors) console.error(`  • ${error}`)
    process.exit(1)
  }
  console.log("[engine-launch-hosts] ok")
}
