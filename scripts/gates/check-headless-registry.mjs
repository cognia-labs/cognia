#!/usr/bin/env node
/**
 * Gate: a runtime side-effect wired only into a React provider initializer is
 * desktop-only, even when the `lib/` code behind it is perfectly host-neutral.
 *
 * ## Why this exists
 *
 * ADR-0059 ("Cloud Deployment — Headless Brain") ends on a hard rule:
 *
 * > new runtime side-effects must register through the headless bootstrap
 * > registry, not raw provider effects — enforce via the wiring audit.
 *
 * That enforcement was the `wiring-auditor` subagent — advisory, invoked by
 * hand, and therefore skipped exactly when a change is large enough to matter.
 * Every other ADR-0059 invariant (command manifest, RPC semantic parity, host
 * parity, capability tables) has a hard gate. This one did not, and the drift
 * was not hypothetical: the whole ADR-0132 issue-tracker runtime — run bridge,
 * four federation sources, notifications, notification commands, GitHub
 * schedule sync, label seeding — booted only in the WebView, so a cloud
 * install ran an issue tracker that never drove a single run. ADR-0045's plan
 * notification actions shipped the same way in the same week.
 *
 * The failure is invisible by construction. Nothing throws: the desktop wires
 * the effect, its tests pass against the desktop wiring, and the brain simply
 * never calls it. Only a reachability question exposes it.
 *
 * ## What this checks
 *
 * For every `components/providers/initializers/*.tsx`, take each symbol it
 * imports from `@/lib/**` whose name reads as a runtime side-effect
 * (`installX` / `startX` / `registerX` / …) AND which the initializer actually
 * calls. That symbol is DORMANT when nothing inside the brain's own module
 * graph calls it.
 *
 * The brain's module graph is computed transitively from the real boot roots —
 * `lib/headless/**` and `cli/src/serve/**` — following static imports AND
 * dynamic `import("…")`, because the headless runtimes deliberately lazy-load
 * their heavy dependencies (`managed-ide-broker` reaches
 * `lib/plugin/ide/broker-runtime` that way).
 *
 * ## Why "is it called", not "is the module reachable"
 *
 * Both weaker rules give wrong answers, in opposite directions:
 *
 *   - Module reachability alone MISSES `installPlanNotificationActions`:
 *     `lib/agent/plan/notify.ts` is reachable from the brain for its other
 *     exports, while the install function itself has one caller — the
 *     provider. Reachable module, dormant effect.
 *   - Call-site search alone (without the reachable set) FLAGS
 *     `ensureEditorLspRuntime`, which is genuinely wired: the brain reaches it
 *     through `managed-ide-broker` → `broker-runtime` → `protocol-runtime`.
 *     Dormant-looking, actually live.
 *
 * The definition that survives both is the one implemented here: called from
 * inside the reachable set.
 *
 * ## Exclusions are per-symbol and carry reasons
 *
 * A genuinely desktop-bound effect (the tray, the selection toolbar, WebView
 * liveness) belongs in `headless-registry-exclusions.json` WITH a reason. This
 * follows `protocol/headless-command-dispositions.json`'s rule, and for the
 * same motive: an unreasoned entry records that someone silenced the gate, not
 * that someone made a decision. A reason under 20 characters is rejected.
 *
 * Exclusions name SYMBOLS, not just files, because the two often mix inside
 * one initializer. `issue-tracker-initializer` boots nine effects: eight are
 * pure brain work, and `installIssueNotificationCommands` needs the App Router
 * to navigate. A file-level excuse would have silenced the eight along with
 * the one — precisely the outcome this gate exists to prevent.
 *
 * Unlike the other ADR-0059 gates this one has no baseline and does not
 * ratchet — it starts clean, because the debt it would have baselined was paid
 * down in the change that introduced it.
 *
 * Usage:
 *   pnpm audit:headless-registry            # check
 *   pnpm audit:headless-registry -- --list  # show every effect and its verdict
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve, relative } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const EXCLUSIONS_FILE = join(REPO_ROOT, "scripts/gates/headless-registry-exclusions.json")

/** Where the desktop shell declares its boot effects. */
export const INITIALIZER_DIR = "components/providers/initializers"

/**
 * The brain's boot roots. `lib/headless/**` is the runtime registry and every
 * runtime that registers into it; `cli/src/serve/**` is the `cognia-agent
 * serve` process that imports it. Anything either can reach, the brain runs.
 */
export const BRAIN_ROOTS = ["lib/headless", "cli/src/serve"]

/**
 * Name shapes that read as "this starts something that keeps running".
 *
 * Deliberately verb-prefixed rather than a curated symbol list: a curated list
 * is a second thing to maintain, and the whole point is to catch effects
 * nobody remembered to wire. The `[A-Z]` tail keeps `install` / `start` used
 * as bare local variables out of the match.
 */
export const EFFECT_PATTERN =
  /^(install|start|init|register|schedule|ensure|boot|resume|seed|sync|watch|activate|reconcile|attach|mount|drain|subscribe)[A-Z]/

const SOURCE_EXT = /\.tsx?$/
const TEST_FILE = /\.(test|stories)\.tsx?$/

/**
 * Resolve an import specifier to a file on disk. Handles the `@/` alias and
 * relative paths; bare package specifiers resolve to null (not our graph).
 *
 * @param {string} spec @param {string} fromFile @returns {string | null}
 */
export function resolveSpecifier(spec, fromFile) {
  let base
  if (spec.startsWith("@/")) base = join(REPO_ROOT, spec.slice(2))
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec)
  else return null
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Every in-repo module `file` imports, static or dynamic.
 *
 * @param {string} file @param {(f: string) => string} read @returns {string[]}
 */
export function moduleImports(file, read) {
  let source
  try {
    source = read(file)
  } catch {
    return []
  }
  const out = []
  const patterns = [
    /from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const resolved = resolveSpecifier(m[1], file)
      if (resolved) out.push(resolved)
    }
  }
  return out
}

/** Recursively collect source files under `dir`, skipping tests and stories. */
function collectSources(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) collectSources(p, out)
    else if (SOURCE_EXT.test(entry.name) && !TEST_FILE.test(entry.name)) out.push(p)
  }
  return out
}

/**
 * Transitive closure of the brain's module graph.
 *
 * @param {string[]} roots absolute file paths
 * @param {(f: string) => string} read
 * @returns {Set<string>}
 */
export function reachableFrom(roots, read) {
  const seen = new Set()
  const stack = [...roots]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const dep of moduleImports(file, read)) {
      if (!seen.has(dep)) stack.push(dep)
    }
  }
  return seen
}

/**
 * Index just past the bracket that closes the one at `open`, skipping string,
 * template and comment contents. Returns `src.length` when unbalanced.
 *
 * @param {string} src @param {number} open
 */
export function matchClose(src, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" }
  const stack = [pairs[src[open]]]
  let i = open + 1
  while (i < src.length && stack.length) {
    const c = src[i]
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      const endComment = src.indexOf("*/", i + 2)
      i = endComment === -1 ? src.length : endComment + 2
      continue
    }
    if (c === '"' || c === "'") {
      i += 1
      while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1
      i += 1
      continue
    }
    if (c === "/" && startsRegex(src, i)) {
      i = skipRegex(src, i)
      continue
    }
    if (c === "`") {
      i += 1
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") i += 2
        else if (src[i] === "$" && src[i + 1] === "{") i = matchClose(src, i + 1)
        else i += 1
      }
      i += 1
      continue
    }
    if (c in pairs) stack.push(pairs[c])
    else if (c === stack[stack.length - 1]) stack.pop()
    i += 1
  }
  return i
}

/**
 * Whether the `/` at `at` opens a regex literal rather than dividing: it does
 * after an operator, an opening bracket, a separator, or a keyword that takes
 * an expression, never after a value (an identifier, a number, `)` or `]`).
 */
function startsRegex(src, at) {
  let j = at - 1
  while (j >= 0 && /\s/.test(src[j])) j -= 1
  if (j < 0) return true
  // Not after `<`, `>` or `}`: in TSX those precede the `/` of `</div>` and
  // `<Foo />`, which a regex scan would swallow up to the end of the line.
  if ("(,=:[!&|?{;+-*%~^".includes(src[j])) return true
  const word = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, j - 10), j + 1))?.[1]
  return (
    word !== undefined && /^(return|typeof|case|do|else|in|of|void|yield|await|delete)$/.test(word)
  )
}

/** Index just past the regex literal opening at `at` (classes may hold `/`). */
function skipRegex(src, at) {
  let i = at + 1
  let inClass = false
  while (i < src.length && src[i] !== "\n") {
    const c = src[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "[") inClass = true
    else if (c === "]") inClass = false
    else if (c === "/" && !inClass) break
    i += 1
  }
  i += 1
  while (i < src.length && /[a-z]/i.test(src[i])) i += 1
  return i
}

/**
 * The `@/lib/**` value bindings an initializer has: named imports (static, or
 * destructured from `await import()`, alone or inside `Promise.all([...])`)
 * keyed by local name, and whole-module bindings keyed by local name.
 * Type-only imports are skipped: `import type { StartFooOptions }` is not an
 * effect, and flagging it would train people to silence the gate.
 *
 * @param {string} source
 * @returns {{ named: Map<string, { imported: string, spec: string }>, namespaces: Map<string, string> }}
 */
export function libBindings(source) {
  const named = new Map()
  const namespaces = new Map()
  const addClause = (list, spec, separator) => {
    for (const clause of list.split(",")) {
      const trimmed = clause.trim()
      if (!trimmed || trimmed.startsWith("type ") || trimmed.startsWith("...")) continue
      const [imported, local = imported] = trimmed.split(separator).map((part) => part.trim())
      if (/^[A-Za-z_$][\w$]*$/.test(local)) named.set(local, { imported, spec })
    }
  }
  const staticRe = /import\s+(type\s+)?\{([^}]+)\}\s*from\s*["'](@\/lib\/[^"']+)["']/g
  for (const m of source.matchAll(staticRe)) {
    if (!m[1]) addClause(m[2], m[3], /\s+as\s+/)
  }
  const nsRe = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*["'](@\/lib\/[^"']+)["']/g
  for (const m of source.matchAll(nsRe)) namespaces.set(m[1], m[2])
  const dynamicRe =
    /(?:const|let)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["'](@\/lib\/[^"']+)["']\s*\)/g
  for (const m of source.matchAll(dynamicRe)) {
    if (m[1].startsWith("{")) addClause(m[1].slice(1, -1), m[2], ":")
    else namespaces.set(m[1], m[2])
  }
  // `import("@/lib/x").then(({ a }) => …)` and `.then(async (ns) => ns.a())`.
  const thenRe =
    /import\(\s*["'](@\/lib\/[^"']+)["']\s*\)\s*\.then\(\s*(?:async\s*)?\(?\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)/g
  for (const m of source.matchAll(thenRe)) {
    if (m[2].startsWith("{")) addClause(m[2].slice(1, -1), m[1], ":")
    else namespaces.set(m[2], m[1])
  }
  // `const [{ a }, ns] = await Promise.all([import("@/lib/x"), import("@/lib/y")])`
  const allRe = /(?:const|let)\s+\[/g
  for (const m of source.matchAll(allRe)) {
    const open = m.index + m[0].length - 1
    const close = matchClose(source, open)
    const rest = source.slice(close).match(/^\s*=\s*await\s+Promise\.all\(\s*\[/)
    if (!rest) continue
    const listOpen = close + rest[0].length - 1
    // Pair destructure slots with list elements by position.
    const slots = splitTopLevel(source.slice(open + 1, close - 1))
    const elements = splitTopLevel(source.slice(listOpen + 1, matchClose(source, listOpen) - 1))
    slots.forEach((slot, index) => {
      const spec = elements[index]?.match(/^import\(\s*["'](@\/lib\/[^"']+)["']\s*\)$/)?.[1]
      if (!spec) return
      if (slot.startsWith("{")) addClause(slot.slice(1, -1), spec, ":")
      else if (/^[A-Za-z_$][\w$]*$/.test(slot)) namespaces.set(slot, spec)
    })
  }
  return { named, namespaces }
}

/** Split a list on its top-level commas, trimming each element. */
function splitTopLevel(list) {
  const out = []
  let current = ""
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i]
    if (c === "(" || c === "[" || c === "{") {
      const close = matchClose(list, i)
      current += list.slice(i, close)
      i = close - 1
      continue
    }
    if (c === ",") {
      out.push(current.trim())
      current = ""
      continue
    }
    current += c
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/**
 * The code an initializer runs as an effect: every `useEffect` /
 * `useLayoutEffect` argument list, plus the bodies of the local functions
 * those call, transitively (a provider routinely moves its boot work into a
 * `run()` or `start()` helper the effect invokes).
 *
 * @param {string} source
 */
export function effectBodies(source) {
  const locals = new Map()
  const localRe =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useCallback\(\s*)?(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=>)/g
  for (const m of source.matchAll(localRe)) {
    const name = m[1] ?? m[2]
    const from = m.index + m[0].length
    const brace = source.slice(from).search(/\S/)
    const at = from + brace
    if (source[at] === "{") locals.set(name, source.slice(at, matchClose(source, at)))
    else if (m[1]) {
      const body = source.indexOf("{", source.indexOf(")", from - 1))
      if (body !== -1) locals.set(name, source.slice(body, matchClose(source, body)))
    } else {
      const line = source.indexOf("\n", at)
      locals.set(name, source.slice(at, line === -1 ? source.length : line))
    }
  }
  const parts = []
  for (const m of source.matchAll(/\b(?:React\.)?use(?:Layout)?Effect\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const args = source.slice(open, matchClose(source, open))
    parts.push(args)
    // `useEffect(run, [])`: React calls `run`, so it counts as a call to it,
    // whether `run` is a local function or an import.
    const reference = /^\(\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(args)?.[1]
    if (reference) parts.push(`${reference}()`)
  }
  const visited = new Set()
  for (let i = 0; i < parts.length; i += 1) {
    for (const [name, body] of locals) {
      if (visited.has(name)) continue
      if (new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*\\(`).test(parts[i])) {
        visited.add(name)
        parts.push(body)
      }
    }
  }
  return parts.join("\n")
}

/**
 * Every `@/lib/**` symbol an initializer calls as an effect (ADR-0250 B6):
 * any value import invoked inside its effects, whatever its name, plus — as
 * before the widening — an effect-shaped name (`installX` / `startX` / …)
 * invoked anywhere in the file. Calls through a whole-module binding count
 * as calls of the member (`sessions.listSessions()` → `listSessions`).
 *
 * Each entry names the export, not a local alias: the brain calls the export.
 *
 * @param {string} source
 * @returns {Array<{ symbol: string, spec: string }>}
 */
export function effectCalls(source) {
  const { named, namespaces } = libBindings(source)
  const effects = effectBodies(source)
  const found = new Map()
  const calls = (text, local) => new RegExp(`\\b${local.replace(/\$/g, "\\$")}\\s*\\(`).test(text)
  for (const [local, { imported, spec }] of named) {
    if (calls(effects, local) || (EFFECT_PATTERN.test(imported) && calls(source, local))) {
      found.set(imported, { symbol: imported, spec })
    }
  }
  for (const [local, spec] of namespaces) {
    const memberRe = new RegExp(
      `\\b${local.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`,
      "g"
    )
    for (const m of effects.matchAll(memberRe)) found.set(m[1], { symbol: m[1], spec })
    for (const m of source.matchAll(memberRe)) {
      if (EFFECT_PATTERN.test(m[1])) found.set(m[1], { symbol: m[1], spec })
    }
  }
  return [...found.values()]
}

/** @param {string} source @returns {string[]} */
export function effectSymbols(source) {
  return effectCalls(source).map((call) => call.symbol)
}

/**
 * Bare packages a UI-only module may import: React, the DOM-facing UI kit,
 * and nothing that reaches storage, network or a native shell.
 */
export const UI_PACKAGES =
  /^(react|react-dom|next\/navigation|next\/link|next-intl|sonner|clsx|tailwind-merge)(\/|$)/

/**
 * A module depends only on React or the DOM when every value import it has is
 * a UI package AND it actually uses one: it imports React, or its code (not
 * its comments) touches `window` / `document`. Calling into such a module can
 * only paint, listen to or measure the renderer, so there is no brain half to
 * wire. A module that merely imports nothing is not UI: a dependency-injected
 * loop (`startVideoJobReconciler`) or an in-memory pub/sub has no imports and
 * still runs work a host owns.
 *
 * @param {string} file @param {(f: string) => string} read
 */
export function isUiOnlyModule(file, read) {
  let source
  try {
    source = read(file)
  } catch {
    return false
  }
  let usesReact = false
  for (const m of source.matchAll(
    /^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/gm
  )) {
    if (m[1]) continue
    if (!UI_PACKAGES.test(m[2])) return false
    if (/^react(-dom)?(\/|$)/.test(m[2])) usesReact = true
  }
  if (/import\s*\(\s*["']/.test(source) || /require\(\s*["']/.test(source)) return false
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""')
  // A real DOM global: a member access or a typeof guard, not the bare word.
  return usesReact || /\b(?:window|document)\s*\.|typeof\s+(?:window|document)\b/.test(code)
}

/**
 * Is `symbol` invoked anywhere in the brain's reachable set?
 *
 * A module's own `export function symbol(` declaration does not count as a
 * call — otherwise every effect would look wired the moment the brain reached
 * the file that defines it, which is precisely the `installPlanNotificationActions`
 * false negative this gate exists to avoid.
 *
 * @param {string} symbol @param {Map<string, string>} corpus reachable file → contents
 */
export function calledInBrain(symbol, corpus) {
  const call = new RegExp(`\\b${symbol}\\s*\\(`)
  const declaration = new RegExp(
    `export\\s+(async\\s+)?function\\s+${symbol}\\b|export\\s+(const|let)\\s+${symbol}\\b`
  )
  for (const [, source] of corpus) {
    if (!call.test(source)) continue
    if (declaration.test(source)) {
      // The defining module. It counts only if it also calls the symbol
      // somewhere other than the declaration itself.
      const withoutDecl = source.replace(
        new RegExp(
          `export\\s+(async\\s+)?function\\s+${symbol}\\s*\\([^)]*\\)|export\\s+(const|let)\\s+${symbol}\\s*=`,
          "g"
        ),
        ""
      )
      if (!call.test(withoutDecl)) continue
    }
    return true
  }
  return false
}

/**
 * @returns {{
 *   initializers: Record<string, { symbols: string[], reason: string }>,
 *   uiOnly?: Record<string, { symbols: string[], reason: string }>,
 *   pending?: Record<string, { symbols: string[], phase: string, reason: string }>,
 *   pendingCeiling?: number,
 * }}
 */
export function readExclusions() {
  if (!existsSync(EXCLUSIONS_FILE)) return { initializers: {} }
  return JSON.parse(readFileSync(EXCLUSIONS_FILE, "utf8"))
}

export const MIN_REASON_LENGTH = 20

/** The identity a `uiOnly` row excuses: one export of one module. */
export function uiOnlyKey(module, symbol) {
  return `${module}#${symbol}`
}

/**
 * The `pendingCeiling` recorded on the base branch (`HEADLESS_REGISTRY_BASE_REF`,
 * default `origin/dev`, at its merge-base with HEAD), or `undefined` when git
 * or the base cannot answer, or the base ledger predates the ceiling.
 *
 * @param {(cmd: string, args: string[]) => string} [exec]
 */
export function readBaseCeiling(
  exec = (cmd, args) =>
    execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
) {
  const ref = process.env.HEADLESS_REGISTRY_BASE_REF ?? "origin/dev"
  try {
    const base = exec("git", ["merge-base", "HEAD", ref]).trim()
    const ledger = JSON.parse(
      exec("git", ["show", `${base}:${relative(REPO_ROOT, EXCLUSIONS_FILE)}`])
    )
    return typeof ledger.pendingCeiling === "number" ? ledger.pendingCeiling : undefined
  } catch {
    return undefined
  }
}

/** Total symbols a `pending` section names: the ratchet's measure. */
export function pendingCount(pending) {
  return Object.values(pending ?? {}).reduce((n, entry) => n + (entry.symbols?.length ?? 0), 0)
}

/**
 * Split findings into what still violates and what the ledger accounts for.
 * Pure, so the test can drive every branch without touching disk.
 *
 * `exclusions` are decisions (the brain must not run these). `ledger.pending`
 * is debt (the brain should, and does not yet): it excuses the same way, but
 * each row names the ADR-0250 phase that moves it, and its symbol count may
 * only shrink — `ledger.pendingCeiling` records the count, and a count above
 * it fails as new debt while a count below it fails until the ceiling is
 * lowered to match, so a paid-down row cannot be quietly re-spent.
 * `ledger.uiOnly` names renderer-only symbols by module; a row nothing calls
 * any more is stale like an exclusion.
 *
 * @param {Array<{ file: string, symbols: string[] }>} findings
 * @param {Record<string, { symbols?: string[], reason?: string }>} exclusions
 * @param {{
 *   pending?: Record<string, { symbols?: string[], phase?: string, reason?: string }>,
 *   pendingCeiling?: number,
 *   uiOnly?: Record<string, { symbols?: string[], reason?: string }>,
 *   uiOnlyUsed?: Set<string>,
 *   baseCeiling?: number,
 * }} [ledger]
 */
export function reconcile(findings, exclusions, ledger = {}) {
  const pending = ledger.pending ?? {}
  const violations = []
  for (const finding of findings) {
    const excused = new Set([
      ...(exclusions[finding.file]?.symbols ?? []),
      ...(pending[finding.file]?.symbols ?? []),
    ])
    const remaining = finding.symbols.filter((s) => !excused.has(s))
    if (remaining.length) violations.push({ file: finding.file, symbols: remaining })
  }

  // A stale row claims a decision about an effect that is no longer dormant —
  // it was wired, renamed, or deleted. Left in place it silences the gate for
  // whatever takes that symbol's name next.
  const staleRows = (rows) => {
    const out = []
    for (const [file, entry] of Object.entries(rows)) {
      const finding = findings.find((f) => f.file === file)
      if (!finding) {
        out.push({ file, symbols: entry.symbols ?? [] })
        continue
      }
      const gone = (entry.symbols ?? []).filter((s) => !finding.symbols.includes(s))
      if (gone.length) out.push({ file, symbols: gone })
    }
    return out
  }
  const stale = staleRows(exclusions)
  const stalePending = staleRows(pending)

  // One symbol is either a decision or debt, never both.
  const doubleBooked = []
  for (const [file, entry] of Object.entries(pending)) {
    const excluded = new Set(exclusions[file]?.symbols ?? [])
    const both = (entry.symbols ?? []).filter((s) => excluded.has(s))
    if (both.length) doubleBooked.push({ file, symbols: both })
  }

  const staleUiOnly = []
  if (ledger.uiOnlyUsed) {
    for (const [module, entry] of Object.entries(ledger.uiOnly ?? {})) {
      const gone = (entry.symbols ?? []).filter((s) => !ledger.uiOnlyUsed.has(uiOnlyKey(module, s)))
      if (gone.length) staleUiOnly.push({ file: module, symbols: gone })
    }
  }

  const rows = [
    ...Object.entries(exclusions),
    ...Object.entries(pending),
    ...Object.entries(ledger.uiOnly ?? {}),
  ]
  const unreasoned = rows
    .filter(([, v]) => !v.reason || v.reason.trim().length < MIN_REASON_LENGTH)
    .map(([file]) => file)
  const symbolless = rows
    .filter(([, v]) => !Array.isArray(v.symbols) || v.symbols.length === 0)
    .map(([file]) => file)
  const phaseless = Object.entries(pending)
    .filter(([, v]) => !v.phase || !v.phase.trim())
    .map(([file]) => file)

  const count = pendingCount(pending)
  const ceiling = ledger.pendingCeiling ?? 0
  const ceilingDrift = count === ceiling ? null : { count, ceiling }
  // The ceiling is in the same editable file as the debt, so the file alone
  // cannot stop both rising together: compare with the base branch's ceiling.
  const ceilingRaised =
    ledger.baseCeiling !== undefined && ceiling > ledger.baseCeiling
      ? { ceiling, baseCeiling: ledger.baseCeiling }
      : null

  return {
    violations,
    stale,
    stalePending,
    staleUiOnly,
    doubleBooked,
    unreasoned,
    symbolless,
    phaseless,
    ceilingDrift,
    ceilingRaised,
  }
}

/**
 * Full analysis. Exported so the test can drive it without a fixture repo.
 *
 * @param {{ read?: (f: string) => string }} [opts]
 */
export function analyze(opts = {}) {
  const read = opts.read ?? ((f) => readFileSync(f, "utf8"))
  const cache = new Map()
  const cachedRead = (f) => {
    if (!cache.has(f)) cache.set(f, read(f))
    return cache.get(f)
  }

  const roots = BRAIN_ROOTS.flatMap((r) => collectSources(join(REPO_ROOT, r)))
  const reachable = reachableFrom(roots, cachedRead)

  // Corpus the call-site search runs over: the reachable set minus the
  // initializer directory (a provider calling its own effect proves nothing)
  // and minus tests.
  const initDirAbs = join(REPO_ROOT, INITIALIZER_DIR)
  const corpus = new Map()
  for (const file of reachable) {
    if (file.startsWith(initDirAbs)) continue
    if (TEST_FILE.test(file)) continue
    try {
      corpus.set(file, cachedRead(file))
    } catch {
      /* unreadable file contributes nothing */
    }
  }

  // Keyed by module AND symbol: a row excuses that export of that module, so a
  // moved or same-named export elsewhere does not inherit it.
  const uiOnlyListed = new Set(
    Object.entries(opts.uiOnly ?? readExclusions().uiOnly ?? {}).flatMap(([module, entry]) =>
      (entry.symbols ?? []).map((symbol) => uiOnlyKey(module, symbol))
    )
  )
  const findings = []
  const uiOnlyUsed = new Set()
  for (const file of collectSources(initDirAbs)) {
    const source = cachedRead(file)
    const rel = relative(REPO_ROOT, file)
    const dormant = []
    for (const { symbol, spec } of effectCalls(source)) {
      if (calledInBrain(symbol, corpus)) continue
      if (uiOnlyListed.has(uiOnlyKey(spec, symbol))) {
        uiOnlyUsed.add(uiOnlyKey(spec, symbol))
        continue
      }
      const defining = resolveSpecifier(spec, file)
      if (defining && isUiOnlyModule(defining, cachedRead)) continue
      dormant.push(symbol)
    }
    if (dormant.length) findings.push({ file: rel, symbols: dormant.sort() })
  }
  findings.sort((a, b) => a.file.localeCompare(b.file))
  return { findings, uiOnlyUsed, reachableCount: reachable.size }
}

function main(argv) {
  const listAll = argv.includes("--list")
  const ledger = readExclusions()
  const exclusions = ledger.initializers ?? {}
  const pending = ledger.pending ?? {}
  const { findings, uiOnlyUsed, reachableCount } = analyze({ uiOnly: ledger.uiOnly ?? {} })

  if (listAll) {
    console.log(`[headless-registry] brain graph: ${reachableCount} modules\n`)
    for (const f of findings) {
      const excused = new Set(exclusions[f.file]?.symbols ?? [])
      const owed = new Set(pending[f.file]?.symbols ?? [])
      console.log(f.file)
      for (const s of f.symbols) {
        const verdict = excused.has(s) ? "EXCLUDED" : owed.has(s) ? "PENDING " : "DORMANT "
        console.log(`         ${verdict} ${s}`)
      }
      if (exclusions[f.file]) console.log(`         reason: ${exclusions[f.file].reason}`)
      if (pending[f.file])
        console.log(`         pending (${pending[f.file].phase}): ${pending[f.file].reason}`)
    }
    return 0
  }

  const baseCeiling = readBaseCeiling()
  const result = reconcile(findings, exclusions, {
    pending,
    pendingCeiling: ledger.pendingCeiling,
    uiOnly: ledger.uiOnly ?? {},
    uiOnlyUsed,
    baseCeiling,
  })

  let failed = false
  const report = (rows, header) => {
    if (!rows.length) return
    console.error(`[headless-registry] ${header}`)
    for (const row of rows) {
      if (typeof row === "string") console.error(`  ${row}`)
      else
        console.error(`  ${row.file}${row.symbols.length ? `  [${row.symbols.join(", ")}]` : ""}`)
    }
    failed = true
  }

  report(
    result.symbolless,
    `${result.symbolless.length} row(s) name no symbols — a row excuses specific effects, never a whole file:`
  )
  report(
    result.unreasoned,
    `${result.unreasoned.length} row(s) carry no usable reason (minimum ${MIN_REASON_LENGTH} characters):`
  )
  report(
    result.phaseless,
    `${result.phaseless.length} pending row(s) name no phase — pending debt says which ADR-0250 phase moves it:`
  )
  report(
    result.doubleBooked,
    `${result.doubleBooked.length} symbol(s) are both excluded and pending — a symbol is a decision or debt, never both:`
  )
  report(
    result.stale,
    `${result.stale.length} exclusion(s) no longer match a dormant effect — the effect was wired, renamed, or deleted. Drop the row or the listed symbols:`
  )
  report(
    result.stalePending,
    `${result.stalePending.length} pending row(s) no longer match a dormant effect — paid down? Drop the symbols and lower pendingCeiling:`
  )
  report(
    result.staleUiOnly,
    `${result.staleUiOnly.length} uiOnly row(s) name symbols no initializer leaves dormant any more. Drop them:`
  )
  if (result.ceilingDrift) {
    const { count, ceiling } = result.ceilingDrift
    console.error(
      count > ceiling
        ? `[headless-registry] pending grew to ${count} symbols, above its ceiling of ${ceiling}. ` +
            "Pending only shrinks: register the new effect in lib/headless/runtimes/ or exclude it with a reason."
        : `[headless-registry] pending shrank to ${count} symbols; lower pendingCeiling from ${ceiling} to ${count} ` +
            "in scripts/gates/headless-registry-exclusions.json so the paid-down debt cannot be re-spent."
    )
    failed = true
  }

  if (result.ceilingRaised) {
    const { ceiling, baseCeiling: base } = result.ceilingRaised
    console.error(
      `[headless-registry] pendingCeiling rose to ${ceiling} from ${base} on ${process.env.HEADLESS_REGISTRY_BASE_REF ?? "origin/dev"}. ` +
        "Pending debt only shrinks: register the effect in lib/headless/runtimes/ or exclude it with a reason."
    )
    failed = true
  }

  if (result.violations.length) {
    console.error(
      `[headless-registry] ${result.violations.length} initializer(s) run effects the headless brain never runs:`
    )
    for (const v of result.violations) {
      console.error(`  ${v.file}`)
      for (const s of v.symbols) console.error(`      ${s}`)
    }
    console.error(
      "\n  ADR-0059 / ADR-0250: runtime side-effects register through the headless\n" +
        "  bootstrap registry, not raw provider effects. Either register the effect in\n" +
        "  lib/headless/runtimes/ (the provider then stays a thin wrapper), exclude it in\n" +
        "  scripts/gates/headless-registry-exclusions.json WITH a reason saying why the\n" +
        "  brain must not run it, or list a renderer-only symbol under uiOnly."
    )
    failed = true
  }

  if (failed) return 1

  console.log(
    `[headless-registry] OK: every provider effect is reachable from the brain ` +
      `(${reachableCount} modules), excluded with a reason ` +
      `(${Object.keys(exclusions).length} initializers), renderer-only, or pending ` +
      `(${pendingCount(pending)} symbols, ceiling ${ledger.pendingCeiling ?? 0}` +
      `${baseCeiling === undefined ? "; no base ceiling to compare" : `, base ${baseCeiling}`}).`
  )
  return 0
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-headless-registry.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
