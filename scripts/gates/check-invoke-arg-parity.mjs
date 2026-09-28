#!/usr/bin/env node
/**
 * Gate: a renderer `invoke("cmd", { … })` must send the arguments its
 * `#[tauri::command]` actually declares.
 *
 * ## The gap this fills
 *
 * Three gates already compare command NAME sets — `audit:command-parity`
 * (invoke ⟷ generate_handler!), `audit:companion-command-manifest`, and
 * `companion-api:check`. `audit:rpc-semantic-parity` goes further but on a
 * different axis: Companion RPC dispatch arms ⟷ Tauri signatures.
 *
 * Nothing compared the RENDERER's call sites against those signatures. So
 * `lib/plugin/core/manager.ts` could invoke `plugin_install` with
 * `{ source, installType, pluginDir }` while the Rust side declared
 * `(plugin_id, source, payload)` — neither `pluginId` nor `payload` ever
 * crossed the wire, and the marketplace install path was dead. Both call sites
 * are covered only by tests that mock `invoke`, so nothing went red for as long
 * as the mismatch existed. 47 `plugin_*` commands and the whole of
 * `companion_api` / `server_ops` / `terminal_host_bridge` carry the same risk.
 *
 * ## What it checks, and what it deliberately cannot
 *
 * Reuses `parseTauriCommands` (the same signature parser
 * `check-rpc-semantic-parity.mjs` already exports) and `normalizeField`, which
 * makes the comparison case- and underscore-insensitive: Tauri deserializes
 * `plugin_id` from the JS `pluginId`, and that is not a defect.
 *
 * Two findings per call site:
 *   * `unknown-argument`  — a key sent that the signature does not declare. It
 *     is silently dropped, so whatever it carried never arrives.
 *   * `missing-argument`  — a non-`Option` parameter with no key. Tauri fails
 *     the call at runtime.
 *
 * A call site whose second argument is not a literal object (`invoke(cmd, args)`)
 * is `opaque` and skipped: guessing produces noise. A literal carrying `...spread`
 * keeps its unknown-argument check — the keys we read are real — but drops the
 * missing-argument half, since the spread can supply anything.
 *
 * ## Ratchet, not a cliff
 *
 * Pre-existing findings live in `invoke-arg-parity-baseline.json` and the list
 * may only shrink. Deliberately its OWN baseline rather than a row in
 * `rpc-semantic-parity-baseline.json`: that gate's response-schema ceiling is
 * currently breached on `dev` (110 against 86), and mixing an unrelated debt
 * into a red gate hides both.
 *
 *   pnpm audit:invoke-arg-parity
 *   pnpm audit:invoke-arg-parity -- --write-baseline
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { COMMAND_ROOTS, normalizeField, parseTauriCommands } from "./check-rpc-semantic-parity.mjs"
import { findInvokeCallSites } from "./lib/invoke-call-sites.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
const BASELINE_PATH = join(__dirname, "invoke-arg-parity-baseline.json")

/**
 * Renderer trees that may call `invoke`. `plugins` is included on purpose —
 * `check-command-parity.mjs` omits it, so first-party plugin code is the one
 * place invoke calls have never been checked at all.
 */
const RENDERER_ROOTS = ["app", "components", "hooks", "stores", "lib", "plugins", "packages"]

const TS_EXTENSIONS = /\.(ts|tsx|mts|cts)$/

const gitFiles = (patterns) =>
  execFileSync("git", ["ls-files", ...patterns], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64e6,
  })
    .split("\n")
    .filter(Boolean)

const read = (file) => readFileSync(join(REPO_ROOT, file), "utf8")

/**
 * `name -> module` for every command `generate_handler!` registers, from
 * entries like `terminal_host_bridge::terminal_spawn`.
 *
 * Needed because a few command names are defined more than once across crates
 * with DIFFERENT signatures — `terminal_spawn` exists in `cognia-terminal`
 * without a `profile_id` and in `terminal_host_bridge` with one. Picking by
 * file order would compare the renderer against a function the app never
 * registers and invent a mismatch.
 */
function registeredModules() {
  const source = read("src-tauri/src/lib.rs")
  const modules = new Map()
  for (const match of source.matchAll(/(?:^|[\s,[])([a-z_][\w]*)::([a-z_][\w]*)\s*,/gm)) {
    modules.set(match[2], match[1])
  }
  return modules
}

function rustCommands() {
  const modules = registeredModules()
  const commands = new Map()
  for (const file of gitFiles(["*.rs"]).filter((f) =>
    COMMAND_ROOTS.some((root) => f.startsWith(root))
  )) {
    if (!existsSync(join(REPO_ROOT, file))) continue
    for (const command of parseTauriCommands(read(file), file)) {
      const existing = commands.get(command.name)
      if (!existing) {
        commands.set(command.name, command)
        continue
      }
      // Two definitions of the same name: keep whichever module the app
      // actually registers. Falls back to first-wins when the name is not in
      // generate_handler! at all — that is command-parity's finding, not ours.
      const registered = modules.get(command.name)
      if (registered && command.file.includes(`/${registered}`)) {
        commands.set(command.name, command)
      }
    }
  }
  return commands
}

function rendererCallSites() {
  const sites = []
  for (const file of gitFiles(RENDERER_ROOTS)) {
    if (!TS_EXTENSIONS.test(file)) continue
    if (/\.(test|spec)\.[mc]?tsx?$/.test(file)) continue
    sites.push(...findInvokeCallSites(read(file), file))
  }
  return sites
}

const isOptional = (type) => /^Option\s*</.test(type.trim().replace(/^&/, ""))

export function findingKey(site, kind, field) {
  return `${site.file}:${site.command}:${kind}:${field}`
}

/**
 * Every argument-shape disagreement. Pure, so the test can drive it with
 * fixtures instead of the repository.
 */
export function analyze(callSites, commands) {
  const findings = []
  for (const site of callSites) {
    if (site.kind !== "object") continue
    const command = commands.get(site.command)
    // An unregistered command is `audit:command-parity`'s finding, not ours.
    if (!command) continue

    const sent = new Set(site.keys.map(normalizeField))
    const declared = new Map(command.params.map((p) => [normalizeField(p.name), p]))
    // `Channel<T>` parameters are real wire arguments — the caller passes a
    // Channel instance — but `parseTauriCommands` splits them out because they
    // are not JSON payload. They are legitimately sent and never "required" in
    // the missing-argument sense, so they belong in `declared` only.
    const channels = new Set(command.channelParams.map(normalizeField))

    for (const key of site.keys) {
      const normalized = normalizeField(key)
      if (!declared.has(normalized) && !channels.has(normalized)) {
        findings.push({
          key: findingKey(site, "unknown-argument", key),
          detail:
            `${site.file}:${site.line} invoke("${site.command}") sends \`${key}\`, which ` +
            `${command.file}:${command.line} does not declare — it is dropped in transit.`,
        })
      }
    }

    // A spread can supply anything, so absence proves nothing.
    if (site.hasSpread) continue

    for (const param of command.params) {
      if (isOptional(param.type)) continue
      if (!sent.has(normalizeField(param.name))) {
        findings.push({
          key: findingKey(site, "missing-argument", param.name),
          detail:
            `${site.file}:${site.line} invoke("${site.command}") omits \`${param.name}\` ` +
            `(${param.type}), which ${command.file}:${command.line} requires.`,
        })
      }
    }
  }
  return findings.sort((a, b) => a.key.localeCompare(b.key))
}

/** Every finding in the repository as it stands. Used by the gate and its test. */
export function collectRepositoryFindings() {
  return analyze(rendererCallSites(), rustCommands())
}

export function readBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, "utf8"))
  return Array.isArray(parsed.findings) ? parsed.findings : []
}

export function diffAgainstBaseline(findings, baseline) {
  const known = new Set(baseline)
  const current = new Set(findings.map((f) => f.key))
  return {
    added: findings.filter((f) => !known.has(f.key)),
    removed: baseline.filter((key) => !current.has(key)),
  }
}

function writeBaseline(findings) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        version: 1,
        note:
          "Renderer invoke() call sites whose argument keys disagree with the " +
          "#[tauri::command] signature they name. THIS LIST MAY ONLY SHRINK — " +
          "`pnpm audit:invoke-arg-parity` fails when a key appears that is not " +
          "listed here. Regenerate with `--write-baseline` only after fixing call " +
          "sites, never to admit a new mismatch.",
        findings: findings.map((f) => f.key),
      },
      null,
      2
    )}\n`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = collectRepositoryFindings()

  if (process.argv.includes("--write-baseline")) {
    writeBaseline(findings)
    console.log(`[invoke-arg-parity] baseline written: ${findings.length} findings`)
  } else {
    const { added, removed } = diffAgainstBaseline(findings, readBaseline())
    if (added.length > 0) {
      console.error(
        `[invoke-arg-parity] ${added.length} NEW invoke/command argument mismatch(es).\n` +
          `An unknown argument is dropped in transit; a missing required one fails the\n` +
          `call at runtime. Tests that mock invoke() cannot see either.\n`
      )
      for (const finding of added) console.error(`  ${finding.detail}`)
      process.exitCode = 1
    } else if (removed.length > 0) {
      console.log(
        `[invoke-arg-parity] ${removed.length} mismatch(es) fixed — lock it in with\n` +
          `  pnpm audit:invoke-arg-parity -- --write-baseline`
      )
      for (const key of removed) console.log(`  - ${key}`)
    } else {
      console.log(`[invoke-arg-parity] no new argument mismatches (${findings.length} known).`)
    }
  }
}
