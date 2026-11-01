#!/usr/bin/env node
/**
 * Gate: the inventory of everything that makes a headless/cloud host less
 * capable than the desktop — kept honest, and prevented from growing.
 *
 * ## Why the existing gates cannot catch this
 *
 * Five gates already compare the command surface:
 *   - `audit:command-parity`             invoke("x") ⟷ generate_handler!
 *   - `audit:companion-command-manifest` manifest ⟷ generate_handler! ⟷ KNOWN_COMMANDS
 *   - `companion-api:check`              committed OpenAPI bytes ⟷ regenerated
 *   - `audit:rpc-semantic-parity`        #[tauri::command] signature ⟷ RPC arm payload
 *   - `audit:adapter-capabilities`       two runtime-capability tables ⟷ each other
 *
 * Every one of them asks "does the same command exist, with the same payload".
 * None asks "can this host actually reach it". A command can be registered,
 * manifested, semantically faithful, and still 503 on one host — which is the
 * entire subject here.
 *
 * ## What this checks
 *
 * Four independent classes of host-parity gap, plus a cross-table consistency
 * check. A/B/C/E are crisp, per-item, and ratcheted. D is a map, not a rule —
 * see below.
 *
 *   A. transport-seam bypass — a renderer file importing `invoke`/`listen`
 *      straight from `@tauri-apps/api/*` instead of going through the swappable
 *      seam. `lib/tauri.ts` calls itself "the SOLE authoritative seam"; every
 *      bypass throws on a non-Tauri host by construction.
 *   B. UI hard-coded to a host — `desktopOnly: true` sections. Even after a
 *      backend reaches parity, a host-keyed UI keeps the feature hidden.
 *   C. one-sided RPC arms — `host.tauri_app(name)?` (desktop-only) and
 *      `host.headless().ok_or_else(RpcError::headless_unsupported)`
 *      (headless-only). Reported in BOTH directions: the asymmetry runs both
 *      ways, and the headless-only arms that are `target=execution` are
 *      reachable by a remote client, which makes them a live defect rather
 *      than bookkeeping.
 *   E. capability tables vs. the manifest — `protocol/companion-commands.json`
 *      is the single source of truth (ADR-0059). A feature that claims a host
 *      it cannot serve, or serves a host it does not claim, is a lie in one
 *      direction or the other.
 *
 * ## Class D is a map, deliberately un-ratcheted
 *
 * `isTauri()` / `isHeadlessHost()` / `usePlatform()` run to ~1k call sites in
 * shipped source across ~500 files. Most are legitimate — a genuine desktop
 * feature SHOULD check. Baselining that number would ratchet noise and say
 * nothing about parity, so class D is emitted as a per-subsystem census for the
 * audit report and never gates. What DOES gate is that every subsystem the
 * census finds carries an annotation in `host-parity-annotations.json`
 * classifying it (see `CLASSIFICATIONS`). That is the judgment this inventory
 * exists to record, and an unannotated subsystem means a gap nobody has looked
 * at.
 *
 * ## Ratchet — enforcing since 2026-08-19
 *
 * Same contract as `check-colocated-tests.mjs` and
 * `check-unreachable-components.mjs`: findings live in
 * `host-parity-baseline.json` and THE LIST MAY ONLY SHRINK.
 *
 * `ENFORCE_RATCHET` was `false` through the buffer period ADR-0059 D7 opened,
 * whose stated end condition was "the connectors seam migration plus the 15
 * remotely-reachable arms". Both landed: all nine IM adapters now subscribe
 * through `lib/connectors/events.ts` (the only production file under
 * lib/connectors importing `@tauri-apps/api/event`, and a declared SEAM_OWNER),
 * and the remotely-reachable headless-only arms are down to the four
 * `codeserver_*` ones D7 itself records as correct. The ADR called that buffer
 * "not open-ended"; this is it closing. New findings now fail the build.
 *
 * Usage:
 *   pnpm audit:host-parity                     # check
 *   pnpm audit:host-parity:report              # full inventory, grouped
 *   pnpm audit:host-parity:baseline            # after paying debt down
 */

import ts from "typescript"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { parseRegisteredCommands } from "./lib/generate-handler.mjs"
import { isRpcSource } from "./lib/companion-source-paths.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const BASELINE_FILE = join(REPO_ROOT, "scripts/gates/host-parity-baseline.json")
export const ANNOTATIONS_FILE = join(REPO_ROOT, "scripts/gates/host-parity-annotations.json")

/**
 * Flip to `true` to make new findings fail the build. See the module docstring.
 * The switch is deliberately a named constant, not a CLI flag: a buffer period
 * that anyone can extend per-invocation never ends.
 */
export const ENFORCE_RATCHET = true

/** The four hosts `lib/platform/detect.ts` models. */
export const HOSTS = Object.freeze(["tauri", "headless", "mobile", "web"])

/**
 * How a subsystem's host guards are to be read.
 *
 * `seam-infrastructure` is the fourth category the original three missed:
 * `lib/tauri` alone carries 121 guards, and they are not a parity gap — they
 * ARE the host-detection and transport-selection layer. Forcing it into
 * "unmigrated" would demand migrating the seam onto itself.
 */
export const CLASSIFICATIONS = Object.freeze([
  "physically-impossible",
  "unmigrated",
  "ui-assumption",
  "seam-infrastructure",
])

/**
 * Files allowed to import `@tauri-apps/api/*` directly, because they ARE the
 * seam (or own an equivalent swappable one). Anything else is a bypass.
 *
 * Keep this list minimal and justified — every entry is a place where the
 * "one implementation, two hosts" property rests on a hand-written swap.
 */
export const SEAM_OWNERS = Object.freeze([
  // The authoritative transport seam (ADR-0059).
  "lib/tauri/transport-tauri.ts",
  // Owns `setConnectorCommandInvoker` — the connectors' own swappable invoker.
  "lib/connectors/tauri/commands.ts",
  // Owns `setConnectorListen` — the connectors' own swappable event seam.
  "lib/connectors/events.ts",
])

/**
 * A runtime import only. `import type { UnlistenFn } from "@tauri-apps/api/event"`
 * is erased at compile time and calls nothing, so it bypasses no seam; flagging
 * it sent lib/browser/downloads-client.ts (all of whose calls go through
 * `transport`) into the inventory as a host-parity gap.
 *
 * The clause between `import` and `from` is limited to binding syntax so a match
 * cannot start at one import and end at the next (the repo omits semicolons).
 */
const TAURI_IMPORT_RE =
  /^\s*(?:import|export)\s+(?!type\b)(?:(?!\b(?:import|export)\b)[\w\s{},*$])*?from\s+["']@tauri-apps\/api\/(core|event)["']/m
/** `import type … from "@tauri-apps/api/…"`: erased, unless the file also loads Tauri at runtime. */
const TAURI_TYPE_IMPORT_RE =
  /^\s*import\s+type\s(?:(?!\b(?:import|export)\b)[\w\s{},*$])*?from\s+["']@tauri-apps\/api\/(?:core|event)["']/m
/** `import("@tauri-apps/api/core")` — a runtime import the static pattern above cannot see. */
const DYNAMIC_TAURI_IMPORT_RE = /\bimport\s*\(\s*["'`]@tauri-apps\/api\/(?:core|event)["'`]\s*\)/
/**
 * `id: "x"` … `desktopOnly: true` within the SAME entry. The span forbids a
 * second `id:`, otherwise a lazy match happily reaches past the end of its own
 * object and pins the flag on whichever entry came before the real one.
 */
const DESKTOP_ONLY_RE =
  /id:\s*["']([a-z0-9-]+)["'](?:(?!id:\s*["'])[\s\S]){0,400}?desktopOnly:\s*true/g
/**
 * A dispatch arm label, including the multi-pattern form `"a" | "b" | "c" =>`.
 * Matching only `"name" =>` silently drops every name but the last, and there
 * are 9 such arms in `rpc/` — each one a command that would look ungated.
 */
const RUST_ARM_RE =
  /((?:"[a-z][a-z0-9_]*"\s*\|\s*)*"[a-z][a-z0-9_]*")(?:\s+if\b(?:[^{};]|\{[^{}]*\}){0,400}?)?\s*=>/g
/** A wildcard arm (`_ =>`, `_ if … =>`): it closes the command arm before it. */
const RUST_WILDCARD_ARM_RE = /(?<![\w$])_(?:\s+if\b(?:[^{};]|\{[^{}]*\}){0,400}?)?\s*=>/g

/**
 * Two idioms mean "this arm needs the desktop", and they read almost alike:
 *
 *   let app = host.tauri_app(name)?;                       // the common one
 *   if host.headless().is_some() { return Err(…) }         // belt-and-braces,
 *                                                          // e.g. automation_consent_*
 *
 * And exactly one idiom means the opposite — "this arm is headless-only":
 *
 *   host.headless().ok_or_else(|| RpcError::headless_host_required(name))?
 *
 * The discriminator is `.ok_or_else(` vs `.is_some()`. Matching `host.headless()`
 * loosely conflates them and reports the same arm on both sides.
 *
 * BOTH error constructors are accepted on the headless-only side. The arms were
 * originally written with `headless_unsupported` in both directions — so a
 * desktop caller was told to "use the desktop app" while running on it — and the
 * split into `headless_host_required` renames roughly a hundred arms without
 * changing one thing about their availability. Keying the gate on the error name
 * alone would read that rename as a hundred closed gaps.
 *
 * rustfmt breaks the builder across lines once it exceeds the width —
 *
 *   let services = host
 *       .headless()
 *       .ok_or_else(|| RpcError::headless_unsupported(name))?;
 *
 * so every receiver/method boundary below tolerates whitespace. Matching
 * `host\.headless\(\)` literally silently missed 4 of every 5 real gates.
 */
const H = String.raw`host\s*\.\s*`
const TAURI_APP_GATE_RE = new RegExp(`${H}tauri_app\\s*\\(`, "g")
/**
 * The rejection itself, not any mention of `is_some()`: `with_gateway` in
 * rpc/gateway_plane.rs reads it to label the host kind, and data_sync.rs passes
 * it into a match guard. Matching the bare call marked all 13 gateway commands
 * (served on both hosts) and `background_monitor_register_scheduled` desktop-only.
 */
const HEADLESS_REJECT_RE = new RegExp(
  `if\\s+${H}headless\\s*\\(\\)\\s*\\.\\s*is_some\\s*\\(\\)\\s*\\{\\s*return\\s+Err\\(`,
  "g"
)
/**
 * `.ok_or_else(|| RpcError::…)`, rustfmt's block form `.ok_or_else(|| {⏎ RpcError::…`,
 * and the eager `.ok_or(RpcError::…)`: the same refusal, written three ways.
 */
const REFUSE = String.raw`\s*\.\s*(?:ok_or_else\s*\(\s*(?:move\s*)?\|\|\s*(?:\{\s*)?|ok_or\s*\(\s*)RpcError::`
const HEADLESS_GATE_RE = new RegExp(
  `${H}headless\\s*\\(\\)${REFUSE}(?:headless_unsupported|headless_host_required)`,
  "g"
)
/** `let Some(s) = host.headless() else { return Err(RpcError::…) }`: the same refusal, let-else form. */
const HEADLESS_LET_ELSE_RE = new RegExp(
  `\\blet\\s+Some\\s*\\([^)]*\\)\\s*=\\s*${H}headless\\s*\\(\\)\\s*else\\s*\\{\\s*return\\s+Err\\s*\\(\\s*` +
    `RpcError::(?:headless_unsupported|headless_host_required)\\b`,
  "g"
)
/**
 * `host.<accessor>().ok_or_else(|| RpcError::headless_unsupported(…))` where the
 * headless `RpcHost` impl answers that accessor with a literal `None`: the arm
 * cannot run headless (rpc/codex_app.rs refuses its whole family through
 * `codex_app_host()`). The accessor list is read from rpc_host.rs, not written
 * here, so a new desktop-only accessor is detected rather than hand-listed.
 */
export const RPC_HOST_FILE = "crates/cognia-companion-rpc/src/rpc_host.rs"
const ACCESSOR_REFUSAL_ERRORS = "headless_unsupported"
const FN_DECL_RE = /\bfn\s+([a-z_][a-z0-9_]*)\s*[<(]/g

/**
 * Rust `source` with comments and the contents of string and char literals
 * blanked to spaces (newlines kept), so every offset still lines up with the
 * original. The gate patterns run on this: `fn x(` in a comment or a string is
 * not a function, and a commented-out refusal is not a gate.
 *
 * @param {string} source @returns {string}
 */
export function maskRust(source, { strings = true } = {}) {
  const out = source.split("")
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " "
  }
  // `strings: false` blanks comments only (the arm labels are strings).
  const blankLiteral = (from, to) => {
    if (strings) blank(from, to)
  }
  const raw = /b?r(#*)"/y
  const char = /'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/uy
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i)
      const stop = end < 0 ? source.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (c === "/" && next === "*") {
      let depth = 1
      let j = i + 2
      while (j < source.length && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "*") {
          depth += 1
          j += 2
        } else if (source[j] === "*" && source[j + 1] === "/") {
          depth -= 1
          j += 2
        } else j += 1
      }
      blank(i, j)
      i = j
      continue
    }
    if (!/[\w]/.test(source[i - 1] ?? "")) {
      raw.lastIndex = i
      const r = raw.exec(source)
      if (r) {
        const open = i + r[0].length
        const close = source.indexOf(`"${r[1]}`, open)
        const stop = close < 0 ? source.length : close
        blankLiteral(open, stop)
        i = stop + 1 + r[1].length
        continue
      }
    }
    if (c === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1
      blankLiteral(i + 1, j)
      i = j + 1
      continue
    }
    if (c === "'") {
      char.lastIndex = i
      const m = char.exec(source)
      if (m) {
        blankLiteral(i + 1, i + m[0].length - 1)
        i += m[0].length
        continue
      }
    }
    i += 1
  }
  return out.join("")
}

/**
 * Every `fn` in masked source with the extent of its body (`end` is -1 for a
 * declaration without one), so an offset belongs to the innermost function
 * around it: a nested `fn` ends where its braces close, not at the next `fn`.
 *
 * @param {string} masked
 * @returns {Array<{ name: string, start: number, end: number }>}
 */
function fnExtents(masked) {
  const out = []
  for (const m of masked.matchAll(FN_DECL_RE)) {
    const start = m.index ?? 0
    let depth = 0
    let angle = 0
    let j = start + 2
    let body = -1
    for (; j < masked.length; j += 1) {
      const c = masked[j]
      if (c === "(" || c === "[") depth += 1
      else if (c === ")" || c === "]") depth -= 1
      // Generics, including a const generic `<{ N + 1 }>`; `->` is not one.
      else if (c === "<") angle += 1
      else if (c === ">" && masked[j - 1] !== "-" && masked[j - 1] !== "=") angle -= 1
      else if (depth === 0 && angle <= 0 && c === ";") break
      else if (depth === 0 && angle <= 0 && c === "{") {
        body = j
        break
      }
    }
    let end = -1
    if (body >= 0) {
      let braces = 0
      for (let k = body; k < masked.length; k += 1) {
        if (masked[k] === "{") braces += 1
        else if (masked[k] === "}" && --braces === 0) {
          end = k
          break
        }
      }
      if (end < 0) end = masked.length
    }
    out.push({ name: m[1], start, end })
  }
  return out
}

/**
 * Accessors the headless host (`impl RpcHost for Arc<HeadlessServices>`) returns
 * as a literal `None`.
 *
 * @param {string} source rpc_host.rs
 * @returns {string[]}
 */
export function headlessAbsentAccessors(source) {
  const start = source.search(/impl\s+RpcHost\s+for\s+Arc\s*<\s*HeadlessServices\s*>\s*\{/)
  if (start < 0) return []
  // The impl ends at the first `}` in column 0 after it.
  const rest = source.slice(start)
  const end = rest.search(/\n\}/)
  const body = end < 0 ? rest : rest.slice(0, end)
  const out = []
  for (const m of maskRust(body).matchAll(
    /fn\s+([a-z_][a-z0-9_]*)\s*\(\s*&self\s*\)\s*->\s*Option\s*<[^{]*\{\s*None\s*\}/g
  )) {
    if (m[1] !== "headless") out.push(m[1])
  }
  return [...new Set(out)].sort()
}

/** The innermost `fn` whose body contains `offset`, or undefined. */
function enclosingFn(extents, offset) {
  let found
  for (const fn of extents) {
    if (fn.start < offset && offset <= fn.end && (!found || fn.start > found.start)) found = fn
  }
  return found
}
const GUARD_RE = /\b(isTauri|isHeadlessHost|usePlatform)\s*\(/g
const GUARD_PRESENT_RE = /\b(isTauri|isHeadlessHost|usePlatform)\s*\(/

/** Kinds whose own text is a literal or a name: only their leading trivia can hold a comment. */
const TEXT_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
])
const JSX_TEXT = new Set([ts.SyntaxKind.JsxText, ts.SyntaxKind.JsxTextAllWhiteSpaces])

/** @param {string} path */
function scriptKind(path) {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** path → the last source stripped for it and the result (each file is read by several rules). */
const strippedCache = new Map()

/**
 * TypeScript `source` with its comments blanked to spaces (newlines kept).
 * The comment ranges come from the TypeScript parser, which knows where JSX
 * text, regex literals and template holes are: a hand lexer read `image/*`
 * in JSX text, or a division after `bytes!`, as the start of a comment and
 * hid the code after it. Only the gaps between a node's children (punctuation,
 * keywords, trivia) and the leading trivia of names and literals are scanned,
 * never the text of a literal or of JSX.
 *
 * Every text rule in this gate reads code through this, so the census counts
 * guards, not prose about guards: `lib/agent-trace` once appeared in the
 * inventory on the strength of one doc comment reading "callers guard with
 * `isTauri()` upstream", a subsystem with zero guards demanding a parity
 * classification.
 *
 * @param {string} source
 * @param {string} [path] decides TS vs TSX parsing (default `.ts`)
 * @returns {string}
 */
export function stripComments(source, path = "source.ts") {
  const cached = strippedCache.get(path)
  if (cached?.source === source) return cached.stripped
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, scriptKind(path))
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard)
  /** @type {Array<[number, number]>} */
  const ranges = []
  const scanGap = (start, end) => {
    if (end <= start) return
    scanner.setText(source, start, end - start)
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (
        kind === ts.SyntaxKind.SingleLineCommentTrivia ||
        kind === ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        ranges.push([scanner.getTokenStart(), scanner.getTokenEnd()])
      }
    }
  }
  const visit = (node) => {
    if (JSX_TEXT.has(node.kind)) return
    if (TEXT_KINDS.has(node.kind)) {
      // Trivia before the first newline is the previous token's trailing
      // comment; after it, this token's leading comments.
      for (const range of [
        ...(ts.getTrailingCommentRanges(source, node.pos) ?? []),
        ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
      ]) {
        ranges.push([range.pos, range.end])
      }
      return
    }
    const children = []
    ts.forEachChild(
      node,
      (child) => {
        children.push(child)
      },
      (list) => {
        children.push(...list)
      }
    )
    children.sort((a, b) => a.pos - b.pos)
    let cursor = node.pos
    for (const child of children) {
      scanGap(cursor, child.pos)
      visit(child)
      cursor = Math.max(cursor, child.end)
    }
    scanGap(cursor, node.end)
  }
  visit(file)
  const out = source.split("")
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i += 1) if (out[i] !== "\n") out[i] = " "
  }
  const stripped = out.join("")
  strippedCache.set(path, { source, stripped })
  return stripped
}

/** @returns {string[]} tracked repo-relative paths */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64e6 })
    .split("\n")
    .filter(Boolean)
}

/** A file that exists to be tested or previewed, never shipped as a host path. */
export function isAuxiliaryFile(path) {
  return /\.(test|spec|stories)\.[tj]sx?$/.test(path) || path.includes("/__mocks__/")
}

/** Renderer source we expect to run on every host. */
export function isRendererSource(path) {
  if (isAuxiliaryFile(path)) return false
  if (!/\.[tj]sx?$/.test(path)) return false
  return /^(lib|components|hooks|stores|app|packages|plugins)\//.test(path)
}

/**
 * Subsystem key for a repo path: the first two segments, which lines up with
 * CLAUDE.md's Subsystem Map (`lib/connectors`, `components/settings`, …).
 *
 * @param {string} path
 * @returns {string}
 */
export function subsystemOf(path) {
  const parts = path.split("/")
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]
}

// ---------------------------------------------------------------------------
// Class A — transport-seam bypass
// ---------------------------------------------------------------------------

/**
 * @param {string[]} files
 * @param {{ read: (p: string) => string }} io
 * @returns {string[]} finding keys
 */
export function findSeamBypasses(files, io) {
  const owners = new Set(SEAM_OWNERS)
  const out = []
  for (const path of files) {
    if (!isRendererSource(path) || owners.has(path)) continue
    const source = io.read(path)
    if (TAURI_IMPORT_RE.test(source) || isTypedDynamicBypass(source, path)) out.push(`A:${path}`)
  }
  return out.sort()
}

/**
 * The type-only exemption covers a file whose Tauri use is erased at compile
 * time. A file that imports Tauri's types statically AND loads its runtime with
 * `await import(…)` is a bypass (lib/automation/audit.ts listens to
 * `automation:event` that way); the type import is what put it in the
 * inventory before the exemption, and the exemption must not take it out.
 *
 * Files whose ONLY Tauri use is a dynamic import (no static import at all) are
 * not reported here yet: they were invisible before the exemption too, and
 * counting them is a separate widening (ledger X21).
 *
 * @param {string} source
 */
export function isTypedDynamicBypass(source, path = undefined) {
  if (!/@tauri-apps\/api/.test(source)) return false
  const code = stripComments(source, path)
  return TAURI_TYPE_IMPORT_RE.test(code) && DYNAMIC_TAURI_IMPORT_RE.test(code)
}

// ---------------------------------------------------------------------------
// Class B — UI hard-coded to a host
// ---------------------------------------------------------------------------

/**
 * @param {string} source contents of components/settings/settings-nav-config.ts
 * @returns {string[]} finding keys
 */
export function findDesktopOnlySections(source) {
  const out = []
  for (const match of source.matchAll(DESKTOP_ONLY_RE)) out.push(`B:${match[1]}`)
  return [...new Set(out)].sort()
}

// ---------------------------------------------------------------------------
// Class C — one-sided RPC arms
// ---------------------------------------------------------------------------

/**
 * Attribute each host gate to the dispatch arms it guards.
 *
 * A gate appearing BEFORE the first arm label is a module-level gate (e.g.
 * `rpc/codex_app.rs` gates its whole family at the top of dispatch), so it is
 * attributed to every arm in that file rather than to none.
 *
 * @param {string} source Rust source of one rpc module
 * @returns {Array<{ command: string, side: "desktop-only" | "headless-only" }>}
 */
/**
 * @typedef {{ module: string, name: string, side: "desktop-only" | "headless-only" }} RefusingHelper
 * @typedef {{ path?: string, isCommand?: (name: string) => boolean }} RpcModuleOptions
 */

/**
 * The host gates in one rpc module, attributed to the dispatch arms they guard.
 *
 * Every gate kind is scoped to the `fn` it sits in: before the first arm of
 * that `fn` it guards all of them (`rpc/codex_app.rs` refuses its whole family
 * at the top of dispatch); inside an arm, that arm (every name of a
 * multi-pattern label). A gate in a `fn` that dispatches no real command makes
 * that `fn` a refusing helper of that side, and the arms that call it are
 * gated in turn (`refusingHelpers`, resolved to a fixed point).
 *
 * @param {string} source Rust source of one rpc module
 * @param {string[]} [headlessAbsent] accessors the headless host answers with `None`
 * @param {RefusingHelper[]} [refusingHelpers] helpers found in this and other modules
 * @param {RpcModuleOptions} [options] the module's path (for cross-module helper
 *   calls) and which label names are real commands (default: all)
 * @returns {Array<{ command: string, side: "desktop-only" | "headless-only" }>}
 */
export function parseHostGatedArms(
  source,
  headlessAbsent = [],
  refusingHelpers = [],
  options = {}
) {
  const path = options.path ?? "<module>"
  // The module's own helpers, to a fixed point, on top of those found elsewhere.
  const helpers = new Map(refusingHelpers.map((helper) => [helperKey(helper), helper]))
  for (let size = -1; size !== helpers.size;) {
    size = helpers.size
    for (const helper of analyzeRpcModule(source, headlessAbsent, [...helpers.values()], {
      ...options,
      path,
    }).helpers)
      helpers.set(helperKey(helper), helper)
  }
  return analyzeRpcModule(source, headlessAbsent, [...helpers.values()], { ...options, path }).gated
}

/**
 * Functions in `source` that refuse one host without dispatching a command
 * themselves: rpc/service_plane.rs `host_automation` is one, and the arms that
 * call it are desktop-only even when they carry no refusal of their own.
 *
 * @param {string} source
 * @param {string[]} headlessAbsent
 * @param {RefusingHelper[]} [known]
 * @param {RpcModuleOptions} [options]
 * @returns {RefusingHelper[]}
 */
export function refusingHelpers(source, headlessAbsent, known = [], options = {}) {
  return analyzeRpcModule(source, headlessAbsent, known, options).helpers
}

/** @param {RefusingHelper} helper */
function helperKey(helper) {
  return `${helper.module}\u0000${helper.name}\u0000${helper.side}`
}

/** The name other modules reach a module by: its file stem, or its directory for mod.rs. */
function moduleStem(path) {
  const parts = path.replace(/\.rs$/, "").split("/")
  const last = parts.pop() ?? ""
  return last === "mod" || last === "lib" ? (parts.pop() ?? last) : last
}

/**
 * Where `source` (the module at `path`) calls `helper`: by bare name in the
 * helper's own module, or in a module that `use`s it; elsewhere only through
 * a path ending in the helper's module (`service_plane::host_automation(`). A
 * helper name alone is not enough: two modules may both define `require`.
 */
function helperCallPattern(helper, path, masked) {
  const name = escapeRegExp(helper.name)
  const call = String.raw`\s*(?:::\s*<[^()]*>\s*)?\(`
  // Not after a path: `other_crate::module::dispatch(` is another fn.
  const bare = String.raw`(?<![\w.:])(?<!\bfn\s+)${name}${call}`
  if (helper.module === path) return bare
  const stem = escapeRegExp(moduleStem(helper.module))
  const patterns = [
    String.raw`(?<![\w.])(?:[a-z_][a-z0-9_]*\s*::\s*)*${stem}\s*::\s*${name}${call}`,
  ]
  // A direct child module reaches its parent's items as `super::name`, and
  // bare after `use super::*` (all 17 rpc family modules start with it).
  const parentDir = helper.module.replace(/\/(?:mod|lib)\.rs$|\.rs$/, "")
  const isChild =
    path.startsWith(`${parentDir}/`) && !path.slice(parentDir.length + 1).includes("/")
  if (isChild) {
    patterns.push(String.raw`(?<![\w.])super\s*::\s*${name}${call}`)
    if (
      new RegExp(
        String.raw`\buse\s+super\s*::\s*(?:\*|${name}\b|\{[^}]*(?:\*|\b${name}\b)[^}]*\})\s*;`
      ).test(masked)
    )
      patterns.push(bare)
  }
  // `use …::stem::name;`, `use …::stem::{…, name, …};`, `use …::stem::*;`
  if (
    new RegExp(
      String.raw`\buse\s+[^;]*\b${stem}\s*::\s*(?:\*|${name}\b(?!\s+as\b)|\{[^}]*(?:\*|\b${name}\b(?!\s+as\b))[^}]*\})[^;]*;`
    ).test(masked)
  )
    patterns.push(bare)
  // `use …::stem::name as alias;`
  for (const m of masked.matchAll(
    new RegExp(
      String.raw`\buse\s+[^;]*\b${stem}\s*::\s*(?:\{[^}]*)?\b${name}\s+as\s+([a-z_][a-z0-9_]*)`,
      "g"
    )
  ))
    patterns.push(String.raw`(?<![\w.])${m[1]}${call}`)
  // `use …::stem as m;` then `m::name(`
  for (const m of masked.matchAll(
    new RegExp(String.raw`\buse\s+[^;]*\b${stem}\s+as\s+([a-z_][a-z0-9_]*)\s*;`, "g")
  ))
    patterns.push(String.raw`(?<![\w.])${m[1]}\s*::\s*${name}${call}`)
  return patterns.join("|")
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * @param {string} source
 * @param {string[]} headlessAbsent
 * @param {RefusingHelper[]} helperList
 * @param {RpcModuleOptions} options
 * @returns {{ gated: Array<{ command: string, side: "desktop-only" | "headless-only" }>, helpers: RefusingHelper[] }}
 */
function analyzeRpcModule(source, headlessAbsent, helperList, options) {
  const path = options.path ?? "<module>"
  const isCommand = options.isCommand ?? (() => true)
  const masked = maskRust(source)
  // Labels are read with comments blanked but strings kept: a `"old" |` left
  // in a comment must not swallow the real label on the next line. One label
  // may carry several names (`"a" | "b" =>`); they share an offset, so a gate
  // inside that arm is attributed to every name it dispatches. Only real
  // commands count: a helper's own `match mode { "x" => … }` is no arm.
  const commentsMasked = maskRust(source, { strings: false })
  const arms = [...commentsMasked.matchAll(RUST_ARM_RE)].flatMap((m) =>
    [...m[1].matchAll(/"([a-z][a-z0-9_]*)"/g)]
      .filter((n) => isCommand(n[1]))
      .map((n) => ({ name: n[1], at: m.index ?? 0 }))
  )
  // Brace depth at each offset (strings and comments blanked), so a wildcard
  // arm only closes command arms of its own match, not an inner match's.
  const depthAt = new Int32Array(masked.length + 1)
  for (let i = 0, depth = 0; i < masked.length; i += 1) {
    depthAt[i] = depth
    if (masked[i] === "{") depth += 1
    else if (masked[i] === "}") depth -= 1
  }
  const armDepths = new Set(arms.map((arm) => depthAt[arm.at]))
  const wildcards = [...commentsMasked.matchAll(RUST_WILDCARD_ARM_RE)]
    .map((m) => m.index ?? 0)
    .filter((at) => masked[at] === "_" && armDepths.has(depthAt[at]))

  /** @type {Array<{ re: RegExp, side: "desktop-only" | "headless-only" }>} */
  const kinds = [
    { re: TAURI_APP_GATE_RE, side: "desktop-only" },
    { re: HEADLESS_REJECT_RE, side: "desktop-only" },
    { re: HEADLESS_GATE_RE, side: "headless-only" },
    { re: HEADLESS_LET_ELSE_RE, side: "headless-only" },
  ]
  if (headlessAbsent.length) {
    const accessors = headlessAbsent.join("|")
    kinds.push(
      {
        re: new RegExp(
          `${H}(?:${accessors})\\s*\\(\\s*\\)${REFUSE}${ACCESSOR_REFUSAL_ERRORS}\\b`,
          "g"
        ),
        side: "desktop-only",
      },
      {
        re: new RegExp(
          `\\blet\\s+Some\\s*\\([^)]*\\)\\s*=\\s*${H}(?:${accessors})\\s*\\(\\s*\\)\\s*else\\s*\\{\\s*` +
            `return\\s+Err\\s*\\(\\s*RpcError::${ACCESSOR_REFUSAL_ERRORS}\\b`,
          "g"
        ),
        side: "desktop-only",
      }
    )
  }
  for (const helper of helperList) {
    kinds.push({ re: new RegExp(helperCallPattern(helper, path, masked), "g"), side: helper.side })
  }

  const extents = fnExtents(masked)
  const armFn = arms.map((arm) => enclosingFn(extents, arm.at))
  /** @type {Map<string, RefusingHelper>} */
  const helpers = new Map()
  const gated = []
  for (const { re, side } of kinds) {
    for (const gate of masked.matchAll(re)) {
      const at = gate.index ?? 0
      const owner = enclosingFn(extents, at)
      const sameFn = arms.filter((_, index) => armFn[index] === owner)
      const preceding = sameFn.filter((a) => a.at < at)
      if (preceding.length === 0) {
        // Before every arm of its fn (or in a fn with none): the whole fn
        // refuses, so its own arms are gated and so is every caller.
        for (const arm of sameFn) gated.push({ command: arm.name, side })
        if (owner) {
          const helper = { module: path, name: owner.name, side }
          helpers.set(helperKey(helper), helper)
        }
        continue
      }
      // Every name on the nearest preceding label: a multi-pattern arm
      // dispatches them all through the same gated body. A wildcard arm in
      // between (same match, same fn) means the gate is in the fallback.
      const nearest = preceding[preceding.length - 1].at
      if (wildcards.some((w) => w > nearest && w < at && enclosingFn(extents, w) === owner))
        continue
      for (const arm of preceding.filter((a) => a.at === nearest)) {
        gated.push({ command: arm.name, side })
      }
    }
  }
  return { gated, helpers: [...helpers.values()] }
}

/** @param {{ transports?: string[] } | undefined} entry */
function isInternalOnly(entry) {
  const transports = entry?.transports ?? []
  return transports.length > 0 && transports.every((t) => t === "internal")
}

/**
 * `"name" =>` also matches things that are not dispatch arms — `rpc.rs:2519`
 * maps error codes to HTTP status the same way (`"spawn_failed" | … =>`), and
 * those sit close enough to a host gate to be mis-attributed. Cross-checking
 * against the real command surface (manifest ∪ generate_handler!) removes the
 * whole class rather than blacklisting names one at a time.
 *
 * @param {Array<{ path: string, source: string }>} modules
 * @param {Map<string, { target?: string, transports?: string[] }>} manifest
 * @param {Set<string>} knownCommands
 * @returns {{ findings: string[], remotelyReachable: string[] }}
 */
export function findOneSidedArms(
  modules,
  manifest,
  knownCommands = new Set(),
  headlessAbsent = []
) {
  const isCommand = (name) => manifest.has(name) || knownCommands.has(name)
  const counted = manifest.size > 0 || knownCommands.size > 0 ? isCommand : undefined
  // Refusing helpers, to a fixed point: a helper that calls a refusing helper
  // refuses too, and the two may live in different modules.
  /** @type {Map<string, RefusingHelper>} */
  const helpers = new Map()
  for (let size = -1; size !== helpers.size;) {
    size = helpers.size
    for (const { path, source } of modules) {
      for (const helper of refusingHelpers(source, headlessAbsent, [...helpers.values()], {
        path,
        isCommand: counted,
      }))
        helpers.set(helperKey(helper), helper)
    }
  }
  /** @type {Map<string, Set<string>>} */
  const bySide = new Map()
  for (const { path, source } of modules) {
    for (const { command, side } of parseHostGatedArms(
      source,
      headlessAbsent,
      [...helpers.values()],
      { path, isCommand: counted }
    )) {
      if (!bySide.has(side)) bySide.set(side, new Set())
      bySide.get(side).add(command)
    }
  }

  const findings = []
  const remotelyReachable = []
  const isRealCommand = (name) => manifest.has(name) || knownCommands.has(name)
  for (const [side, commands] of bySide) {
    for (const command of commands) {
      if (!isRealCommand(command)) continue
      const entry = manifest.get(command)
      if (side === "headless-only" && knownCommands.has(command) && isInternalOnly(entry)) {
        // The brain's service-plane route to a capability the desktop serves
        // over its own Tauri command of the same name (e.g.
        // connectors_matrix_crypto_* through lib/connectors/tauri/commands.ts).
        // No paired device can reach the arm, so both hosts have the command.
        continue
      }
      findings.push(`C:${command}:${side}`)
      // A headless-only arm that a paired device can address over the wire is
      // not bookkeeping — the remote client gets a 503 whose message names the
      // opposite host.
      const remote = (entry?.transports ?? []).some((t) =>
        ["http", "websocket", "webrtc"].includes(t)
      )
      if (side === "headless-only" && entry?.target === "execution" && remote) {
        remotelyReachable.push(command)
      }
    }
  }
  return { findings: findings.sort(), remotelyReachable: remotelyReachable.sort() }
}

// ---------------------------------------------------------------------------
// Class D — runtime-guard census (map only, never gates)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} files
 * @param {{ read: (p: string) => string }} io
 * @returns {Map<string, { files: number, sites: number }>} keyed by subsystem
 */
export function censusRuntimeGuards(files, io) {
  /** @type {Map<string, { files: number, sites: number }>} */
  const census = new Map()
  for (const path of files) {
    if (!isRendererSource(path)) continue
    const source = io.read(path)
    if (!GUARD_PRESENT_RE.test(source)) continue
    const sites = [...stripComments(source, path).matchAll(GUARD_RE)].length
    if (sites === 0) continue
    const key = subsystemOf(path)
    const row = census.get(key) ?? { files: 0, sites: 0 }
    row.files += 1
    row.sites += sites
    census.set(key, row)
  }
  return census
}

// ---------------------------------------------------------------------------
// Class E — capability tables vs. the manifest
// ---------------------------------------------------------------------------

/**
 * A host feature that gates itself to `tauri` while none of its operations is
 * actually desktop-gated is UNDER-REPORTING: the command works headless and
 * the negotiating client is told it does not.
 *
 * @param {Array<{ feature: string, hosts: string[], operations: string[] }>} features
 * @param {Set<string>} desktopGatedCommands commands behind `host.tauri_app(...)`
 * @returns {string[]} finding keys
 */
export function findCapabilityMisreports(features, desktopGatedCommands) {
  const out = []
  for (const { feature, hosts, operations } of features) {
    const tauriOnly = hosts.length === 1 && hosts[0] === "tauri"
    if (!tauriOnly || operations.length === 0) continue
    const anyDesktopGated = operations.some((op) => desktopGatedCommands.has(op))
    if (!anyDesktopGated) out.push(`E:${feature}:under-reported-headless`)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// Baseline plumbing (mirrors check-unreachable-components.mjs)
// ---------------------------------------------------------------------------

export function readBaseline(read = () => readFileSync(BASELINE_FILE, "utf8")) {
  if (!existsSync(BASELINE_FILE)) return { version: 1, findings: [] }
  try {
    const parsed = JSON.parse(read())
    return { version: parsed.version ?? 1, findings: parsed.findings ?? [] }
  } catch {
    return { version: 1, findings: [] }
  }
}

/**
 * @param {string[]} findings
 * @param {string[]} baseline
 * @returns {{ added: string[], fixed: string[] }}
 */
export function diffAgainstBaseline(findings, baseline) {
  const now = new Set(findings)
  const known = new Set(baseline)
  return {
    added: findings.filter((f) => !known.has(f)).sort(),
    fixed: baseline.filter((f) => !now.has(f)).sort(),
  }
}

export function writeBaseline(findings) {
  const payload = {
    version: 1,
    note:
      "Known headless↔desktop parity gaps, recorded when the gate landed. This list may only " +
      "shrink: `pnpm audit:host-parity` reports (and, once ENFORCE_RATCHET flips, fails on) any " +
      "new one. Keys are `A:<path>` seam bypass, `B:<section>` desktop-only UI, " +
      "`C:<command>:<side>` one-sided RPC arm, `E:<feature>:<kind>` capability misreport. " +
      "Regenerate with `pnpm audit:host-parity:baseline` after paying debt down.",
    findings: [...findings].sort(),
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

/**
 * Every subsystem the census surfaces must carry a recorded judgment. An
 * unannotated subsystem is a gap nobody has classified.
 *
 * @param {Map<string, unknown>} census
 * @param {Record<string, { classification?: string }>} annotations
 * @returns {{ missing: string[], invalid: string[], stale: string[] }}
 */
/** A key naming one file (`lib/native/codex-app-dispatch.ts`) rather than a subsystem. */
export function isFileAnnotation(key) {
  return /\.[tj]sx?$/.test(key)
}

/**
 * @param {Map<string, unknown>} census keyed by subsystem
 * @param {Record<string, { classification: string }>} annotations
 * @param {(path: string) => boolean} [fileExists]
 */
export function checkAnnotations(census, annotations, fileExists = undefined) {
  const exists = fileExists ?? ((p) => existsSync(join(REPO_ROOT, p)))
  const missing = []
  const invalid = []
  for (const key of census.keys()) {
    const row = annotations[key]
    if (!row) {
      missing.push(key)
      continue
    }
    if (!CLASSIFICATIONS.includes(row.classification)) invalid.push(key)
  }
  for (const [key, row] of Object.entries(annotations)) {
    if (!isFileAnnotation(key)) continue
    if (!CLASSIFICATIONS.includes(row.classification)) invalid.push(key)
  }
  // Annotations come at two granularities and the staleness rule differs.
  // A subsystem key is stale once the census stops finding guards there. A FILE
  // key (used for per-file Class A judgments) is never in the subsystem census
  // at all, so comparing it against `census` reported every one of them as
  // stale forever — `lib/native/codex-app-dispatch.ts` carries a dated, fully
  // reasoned classification and was listed as stale on every run. A file
  // annotation is stale only when its file is gone.
  const stale = Object.keys(annotations).filter((key) =>
    isFileAnnotation(key) ? !exists(key) : !census.has(key)
  )
  return { missing: missing.sort(), invalid: [...new Set(invalid)].sort(), stale: stale.sort() }
}

/**
 * Physical desktop contracts remain visible without being counted as missing
 * headless implementations. Each exact command must still have its desktop
 * guard, a native implementation, and a rejection regression in source.
 */
export function classifyDesktopContracts(findings, contracts, io) {
  const known = new Set(findings)
  const classified = []
  const errors = []
  for (const [command, contract] of Object.entries(contracts)) {
    const key = `C:${command}:desktop-only`
    if (
      !/^[a-z][a-z0-9_]*$/.test(command) ||
      contract.classification !== "physically-impossible" ||
      contract.side !== "desktop-only" ||
      !contract.reason?.trim()
    ) {
      errors.push(`${command}: invalid desktop contract`)
      continue
    }
    if (!known.has(key)) {
      errors.push(`${command}: stale or mismatched desktop guard`)
      continue
    }
    const implementation = io.read(contract.implementation)
    const tests = io.read(contract.test)
    const regression = tests.split(`fn ${contract.testName}(`)[1]?.split("\n}")[0] ?? ""
    if (
      !implementation.includes(`fn ${command}(`) ||
      !implementation.includes("AutomationState") ||
      !implementation.includes('#[cfg(feature = "tauri-host")]') ||
      !regression.includes(`"${command}"`) ||
      !regression.includes('"headless_unsupported"') ||
      !regression.includes(".expect_err(")
    ) {
      errors.push(`${command}: missing native implementation or headless rejection regression`)
      continue
    }
    classified.push(key)
  }
  const intentional = new Set(classified)
  return { findings: findings.filter((key) => !intentional.has(key)), classified, errors }
}

/**
 * What a file binds at runtime from `@tauri-apps/api/{core,event}`: the
 * imported names (`{ Channel, invoke as call }` → Channel, invoke; `* as t` or
 * `export *` → `*`; a default import → `default`) and, per imported name, the
 * local names it is called by. Inline `type` specifiers are erased and not
 * counted.
 *
 * @param {string} source
 * @returns {{ names: Set<string>, locals: Map<string, Set<string>>, namespaces: Set<string>, reexports: Set<string> }}
 */
export function tauriRuntimeBindings(source, path = undefined) {
  const re =
    /^\s*(import|export)\s+(?!type\b)((?:(?!\b(?:import|export)\b)[\w\s{},*$])*?)\s*from\s+["']@tauri-apps\/api\/(?:core|event)["']/gm
  const names = new Set()
  const locals = new Map()
  const namespaces = new Set()
  // What the file hands on to its importers (`export { invoke } from …`,
  // `export * from …`): a call made there is out of the pin's sight.
  const reexports = new Set()
  for (const match of stripComments(source, path).matchAll(re)) {
    const clause = match[2]
    const braces = clause.match(/\{([\s\S]*)\}/)
    for (const spec of (braces?.[1] ?? "").split(",")) {
      const [name, local = name] = spec
        .trim()
        .split(/\s+as\s+/)
        .map((part) => part.trim())
      if (!name || /^type\s/.test(name)) continue
      names.add(name)
      if (match[1] === "import") {
        if (!locals.has(name)) locals.set(name, new Set())
        locals.get(name).add(local)
      } else reexports.add(name)
    }
    const outside = clause
      .replace(/\{[\s\S]*\}/, "")
      .replace(/,\s*$/, "")
      .trim()
    const namespace = outside.match(/\*\s*(?:as\s+([A-Za-z_$][\w$]*))?/)
    if (namespace) {
      names.add("*")
      if (namespace[1] && match[1] === "import") namespaces.add(namespace[1])
      else if (match[1] === "export") reexports.add("*")
    } else if (/^[A-Za-z_$][\w$]*/.test(outside)) names.add("default")
  }
  return { names, locals, namespaces, reexports }
}

/** The runtime names a file imports from Tauri (see {@link tauriRuntimeBindings}). */
export function tauriRuntimeImports(source) {
  return [...tauriRuntimeBindings(source).names].sort()
}

/**
 * The source text of each argument of the call whose `(` is at `open`, up to
 * its matching `)`. Brackets, strings and template literals are skipped as
 * units, so `emitTo(label(pick(a), b), "evt")` yields two arguments, not a
 * truncated first one. `null` when the call never closes.
 *
 * @param {string} code @param {number} open
 * @returns {string[] | null}
 */
export function callArguments(code, open) {
  const closers = { "(": ")", "[": "]", "{": "}" }
  const stack = []
  const args = []
  let start = open + 1
  let i = open + 1
  while (i < code.length) {
    const c = code[i]
    if (c === '"' || c === "'") {
      i = skipQuoted(code, i)
      continue
    }
    if (c === "`") {
      i = skipTemplate(code, i)
      continue
    }
    if (Object.hasOwn(closers, c)) {
      stack.push(closers[c])
      i += 1
      continue
    }
    if (stack.length && c === stack[stack.length - 1]) {
      stack.pop()
      i += 1
      continue
    }
    if (!stack.length && (c === "," || c === ")")) {
      args.push(code.slice(start, i))
      if (c === ")") return args.length === 1 && !args[0].trim() ? [] : args
      start = i + 1
    }
    i += 1
  }
  return null
}

/** Offset just past the quoted string starting at `i`. */
function skipQuoted(code, i) {
  const quote = code[i]
  let j = i + 1
  while (j < code.length && code[j] !== quote && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1
  return j + 1
}

/** Offset just past the template literal starting at `i`, `${…}` holes included. */
function skipTemplate(code, i) {
  let j = i + 1
  while (j < code.length && code[j] !== "`") {
    if (code[j] === "\\") j += 2
    else if (code[j] === "$" && code[j + 1] === "{") {
      let depth = 1
      j += 2
      while (j < code.length && depth > 0) {
        if (code[j] === '"' || code[j] === "'") j = skipQuoted(code, j)
        else if (code[j] === "`") j = skipTemplate(code, j)
        else {
          if (code[j] === "{") depth += 1
          else if (code[j] === "}") depth -= 1
          j += 1
        }
      }
    } else j += 1
  }
  return j + 1
}

/**
 * What one argument names: the text of a plain string literal (a template
 * without holes counts); for a bare identifier, its same-file constant when
 * `constants` is given, else `<dynamic:NAME>` (or `<dynamic>` without
 * constants); anything else — a concatenation, a hole, a call — `<dynamic>`.
 * `"pinned" + x` is never read as `pinned`.
 *
 * @param {string | undefined} arg @param {Map<string, string>} [constants]
 */
function argumentName(arg, constants) {
  const text = (arg ?? "").trim()
  const quoted = text.match(/^(["'])((?:\\.|(?!\1)[^\\\n])*)\1$/)
  if (quoted) return quoted[2]
  const template = text.match(/^`([^`\\$]*)`$/)
  if (template) return template[1]
  if (constants && /^[A-Za-z_$][\w$]*$/.test(text)) {
    return constants.get(text) ?? `<dynamic:${text}>`
  }
  return "<dynamic>"
}

/** `code` with import and export-from statements removed (binding syntax only). */
function withoutImports(code) {
  // The clause cannot run past another import/export keyword: the repo omits
  // semicolons, and a lazy match from `export default x` to a later
  // `export { y } from "…"` would delete everything between them.
  return code.replace(
    /^\s*(?:import|export)\s+(?:type\s+)?(?:(?!\b(?:import|export)\b)[\w\s{},*$])*?\s*from\s+["'][^"']+["']/gm,
    ""
  )
}

/**
 * Same-file string constants a bare identifier argument may name: a top-level
 * `const NAME = "literal"` that is the only declaration of NAME and that no
 * function parameter shadows. Anything else stays `<dynamic:NAME>`.
 *
 * @param {string} code
 * @returns {Map<string, string>}
 */
function fileConstants(code) {
  const declared = new Map()
  const declare = (name) => declared.set(name, (declared.get(name) ?? 0) + 1)
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declare(m[1])
  // Destructured bindings (`const { CMD } = o`, `for (const [CMD] of o)`).
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^=;]*?)[}\]]\s*(?:=|of\b|in\b)/g)) {
    for (const name of m[1].matchAll(/(?<![\w$.:])([A-Za-z_$][\w$]*)(?!\s*:)/g)) declare(name[1])
  }
  const out = new Map()
  for (const m of code.matchAll(
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(["'`])([^"'`$\\\n]*)\2(?:\s+as\s+const)?\s*;?[ \t]*$/gm
  )) {
    const name = m[1]
    if (declared.get(name) !== 1) continue
    const id = name.replace(/\$/g, "\\$")
    const parameter = new RegExp(
      String.raw`(?:\bfunction\b[^(]*\(|\()(?:[^()]|\([^()]*\))*?(?<![\w$.])${id}(?![\w$])(?:[^()]|\([^()]*\))*\)\s*(?::[^=>{]+)?(?:=>|\{)|(?<![\w$.])${id}\s*=>`
    )
    if (parameter.test(code)) continue
    out.set(name, m[3])
  }
  return out
}

/**
 * `<reference>` for each place a namespace import is used other than as
 * `ns.member` (`const t2 = t`, `t["invoke"]`): it hands every function on.
 */
function namespaceReferences(code, bindings) {
  const out = []
  for (const ns of bindings.namespaces ?? []) {
    const re = new RegExp(`(?<![\\w$.])${ns.replace(/\$/g, "\\$")}(?![\\w$])(?!\\s*\\.)`, "g")
    for (const _ of code.matchAll(re)) out.push("<reference>")
  }
  return out
}

/**
 * The first argument of every call of `invoke`, under any local alias
 * (`invoke as call` → `call(`) or through a namespace (`t.invoke(`), read with
 * {@link argumentName}.
 */
function invokedCommands(source, bindings, path = undefined) {
  const callees = [...(bindings.locals.get("invoke") ?? [])].map((local) =>
    local.replace(/\$/g, "\\$")
  )
  for (const ns of bindings.namespaces) callees.push(`${ns.replace(/\$/g, "\\$")}\\s*\\.\\s*invoke`)
  const reexports = bindings.reexports ?? new Set()
  const out = reexports.has("invoke") || reexports.has("*") ? ["<reference>"] : []
  // Binding syntax only, as in tauriRuntimeBindings: an `export const` that
  // runs code is not an import statement.
  const code = withoutImports(stripComments(source, path))
  out.push(...namespaceReferences(code, bindings))
  if (callees.length === 0) return out
  const call = new RegExp(`(?<![\\w$.])(?:${callees.join("|")})\\s*(?:<[^>()]*>)?\\s*\\(`, "g")
  const constants = fileConstants(code)
  for (const m of code.matchAll(call)) {
    const args = callArguments(code, (m.index ?? 0) + m[0].length - 1)
    out.push(argumentName(args?.[0], constants))
  }
  // Handing `invoke` on as a value (`const f = invoke`) would let any command
  // through the pin, so a use that is not a call fails as well.
  const reference = new RegExp(
    `(?<![\\w$.])(?:${callees.join("|")})(?![\\w$])(?!\\s*(?:<[^>()]*>)?\\s*\\()`,
    "g"
  )
  for (const _ of code.matchAll(reference)) out.push("<reference>")
  return out
}

/** The Tauri event functions whose event name a physical seam pins, and which argument names it. */
const EVENT_FUNCTIONS = Object.freeze({ listen: 0, once: 0, emit: 0, emitTo: 1 })

/**
 * The event-name argument of every call of a Tauri event function
 * under any local alias or through a namespace; `<reference>` for a use that is
 * not a call (handing `emitTo` on as a value would let any event through).
 *
 * @param {string} source
 * @param {{ locals: Map<string, Set<string>>, namespaces: Set<string> }} bindings
 * @returns {string[]}
 */
export function eventNames(source, bindings, path = undefined) {
  const code = withoutImports(stripComments(source, path))
  const constants = fileConstants(code)
  const reexports = bindings.reexports ?? new Set()
  const out = namespaceReferences(code, bindings)
  for (const [fn, position] of Object.entries(EVENT_FUNCTIONS)) {
    if (reexports.has(fn) || reexports.has("*")) out.push("<reference>")
    const callees = [...(bindings.locals.get(fn) ?? [])].map((local) => local.replace(/\$/g, "\\$"))
    for (const ns of bindings.namespaces)
      callees.push(`${ns.replace(/\$/g, "\\$")}\\s*\\.\\s*${fn}`)
    if (callees.length === 0) continue
    const call = new RegExp(
      `(?<![\\w$.])(?:${callees.join("|")})\\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\\s*\\(`,
      "g"
    )
    for (const m of code.matchAll(call)) {
      // The whole argument, resolved through a same-file string constant, so
      // the pin names the event itself; anything not reducible to one name is
      // `<dynamic…>` and has to be pinned as such.
      const args = callArguments(code, (m.index ?? 0) + m[0].length - 1)
      out.push(argumentName(args?.[position], constants))
    }
    const reference = new RegExp(
      `(?<![\\w$.])(?:${callees.join("|")})(?![\\w$])(?!\\s*(?:<(?:[^<>()]|<[^<>()]*>)*>)?\\s*\\()`,
      "g"
    )
    for (const _ of code.matchAll(reference)) out.push("<reference>")
  }
  return [...new Set(out)].sort()
}

/**
 * A Class A finding a file annotation proves physical: the file is the one place
 * a desktop-only primitive the Transport contract cannot express is used (a
 * Tauri `Channel` carrying raw frames, `emitTo` addressing one webview window).
 * The annotation pins the exact runtime imports (`physicalSeam.imports`),
 * when it imports `invoke` the exact commands (`physicalSeam.invokes`), and when
 * it imports an event function the exact event names (`physicalSeam.events`,
 * resolved through same-file string constants). Any other import, command
 * or event fails rather than riding on the judgment, and so does a dynamic
 * Tauri import, which no pin can see. Like
 * {@link classifyDesktopContracts}, the finding stays visible but is not
 * counted as a gap.
 *
 * @param {string[]} findings
 * @param {Record<string, any>} annotations
 * @param {{ read: (p: string) => string }} io
 */
export function classifyPhysicalSeams(findings, annotations, io) {
  const known = new Set(findings)
  const classified = []
  const errors = []
  for (const [path, row] of Object.entries(annotations)) {
    if (!isFileAnnotation(path) || row?.physicalSeam === undefined) continue
    const seam = row.physicalSeam
    const key = `A:${path}`
    if (
      row.classification !== "physically-impossible" ||
      !row.note?.trim() ||
      !Array.isArray(seam?.imports) ||
      seam.imports.length === 0
    ) {
      errors.push(`${path}: invalid physical seam annotation`)
      continue
    }
    if (!known.has(key)) {
      errors.push(`${path}: stale physical seam (the file no longer imports Tauri directly)`)
      continue
    }
    const source = io.read(path)
    const bindings = tauriRuntimeBindings(source, path)
    const extra = [...bindings.names].sort().filter((name) => !seam.imports.includes(name))
    if (extra.length) {
      errors.push(`${path}: imports ${extra.join(", ")} beyond its physical seam`)
      continue
    }
    // A dynamic `import("@tauri-apps/api/…")` loads the runtime outside the
    // static bindings the pins are read from, so nothing it calls is pinned.
    if (DYNAMIC_TAURI_IMPORT_RE.test(stripComments(source, path))) {
      errors.push(`${path}: imports Tauri dynamically, which its physical seam cannot pin`)
      continue
    }
    // A namespace import (`*`) reaches every function, so both pins apply.
    const everything = seam.imports.includes("*")
    if (everything || seam.imports.includes("invoke")) {
      const allowed = Array.isArray(seam.invokes) ? seam.invokes : []
      const stray = invokedCommands(source, bindings, path).filter(
        (command) => !allowed.includes(command)
      )
      if (stray.length) {
        errors.push(`${path}: invokes ${stray.join(", ")} beyond its physical seam`)
        continue
      }
    }
    if (everything || seam.imports.some((name) => Object.hasOwn(EVENT_FUNCTIONS, name))) {
      const allowed = Array.isArray(seam.events) ? seam.events : []
      const used = eventNames(source, bindings, path)
      const stray = used.filter((event) => !allowed.includes(event))
      if (stray.length) {
        errors.push(`${path}: uses events ${stray.join(", ")} beyond its physical seam`)
        continue
      }
      const unused = allowed.filter((event) => !used.includes(event))
      if (unused.length) {
        errors.push(`${path}: physical seam pins events it no longer uses: ${unused.join(", ")}`)
        continue
      }
    }
    classified.push(key)
  }
  const physical = new Set(classified)
  return { findings: findings.filter((key) => !physical.has(key)), classified, errors }
}

// ---------------------------------------------------------------------------
// localTransport pins
// ---------------------------------------------------------------------------

/**
 * `localTransport` (lib/tauri/transport-instance.ts) always reaches THIS
 * machine's Tauri runtime, whichever host the client drives. That is right for
 * a client.local family, and it is also a way around every class above: a
 * bypass "fixed" by switching `invoke` to `localTransport.call` disappears from
 * class A while still failing on any other host. So each use is pinned, per
 * file, in `host-parity-local-transport.json`: the method and command (or
 * event) of every call, any other member it reads, and how many times the file
 * hands `localTransport` on as a value (`isTauri() ? localTransport :
 * transport`, a `{ localTransport: transport }` rename). A use the pin does
 * not list fails; a pin nothing uses any more fails until it is removed. The
 * calls made through such an alias are pinned only by that count (ledger X21).
 */
export const LOCAL_TRANSPORT_FILE = join(
  REPO_ROOT,
  "scripts/gates/host-parity-local-transport.json"
)
export const LOCAL_TRANSPORT_OWNERS = Object.freeze([
  "lib/tauri.ts",
  "lib/tauri/transport-instance.ts",
])

const GENERIC = String.raw`(?:<(?:[^<>()]|<(?:[^<>()]|<[^<>()]*>)*>)*>)?`

/** A module specifier naming lib/tauri or its transport instance, by alias or relative path. */
const LIB_TAURI_SPEC = String.raw`["'](?:@\/lib|\.{1,2}(?:\/\.\.)*)\/tauri(?:\/index|\/transport-instance)?(?:\.tsx?)?["']`
/** `import * as t from "@/lib/tauri"`: a namespace that can hand localTransport on. */
const LIB_TAURI_NAMESPACE_RE = new RegExp(
  String.raw`^\s*import\s+\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s+${LIB_TAURI_SPEC}`,
  "m"
)
const STAR_REEXPORT_RE = new RegExp(
  String.raw`^\s*export\s*\*\s*(?:as\s+[\w$]+\s*)?from\s+${LIB_TAURI_SPEC}`,
  "m"
)

/**
 * @param {string} source
 * @returns {{ uses: string[], references: number }}
 */
export function localTransportUses(source, path = undefined) {
  const stripped = stripComments(source, path)
  const uses = new Set()
  // Every local name `localTransport` is bound to: itself, an import rename
  // (`import { localTransport as transport }`, the settings cards' idiom), a
  // destructuring of a dynamic import (`const { transport, localTransport: lt }
  // = await import("@/lib/tauri")`), and an alias of the value or of a module
  // member (`let local = transportModule.localTransport`). A call through any
  // of them is a localTransport call. An alias is also counted as a hand-off.
  const names = new Set(["localTransport"])
  for (const m of stripped.matchAll(
    /^\s*import\s+(?!type\b)[\w\s{},$]*?\blocalTransport\s+as\s+([A-Za-z_$][\w$]*)[\w\s{},$]*?from\s+["'][^"']+["']/gm
  ))
    names.add(m[1])
  // A non-owner re-export hands the value to importers under any name, out of
  // this file's sight: pinned as `export:<name>`.
  for (const m of stripped.matchAll(/^\s*export\s+(?!type\b)\{([^}]*)\}/gm)) {
    for (const spec of m[1].split(",")) {
      const [name, exported = name] = spec
        .trim()
        .split(/\s+as\s+/)
        .map((part) => part.trim())
      if (name === "localTransport") uses.add(`export:${exported}`)
    }
  }
  if (STAR_REEXPORT_RE.test(stripped)) uses.add("export:*")
  const destructure = /\{([^{}]*)\}\s*=(?![=>])/g
  for (const m of stripped.matchAll(destructure)) {
    // Key position only: `cond ? localTransport : remote` is no rename.
    for (const prop of `{${m[1]}`.matchAll(/(?<=[{,]\s*)localTransport\s*:\s*([A-Za-z_$][\w$]*)/g))
      names.add(prop[1])
    // A default (`{ transport = localTransport } = opts`): the binding may be
    // localTransport itself, so it is an alias, and the default a hand-off.
    for (const prop of m[1].matchAll(
      /([A-Za-z_$][\w$]*)\s*=(?![=>])[^,}]*(?<![\w$.])localTransport(?![\w$])/g
    ))
      names.add(prop[1])
  }
  const alias =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:\(?\s*await\s+import\s*\([^)]*\)\s*\)?|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)?\s*\.?\s*localTransport\s*(?=;|\n|$)/g
  for (const m of stripped.matchAll(alias)) names.add(m[1])

  const code = withoutImports(stripped)
    .replace(/^\s*export\s+(?!type\b)\{[^}]*\}/gm, "")
    .replace(destructure, (whole, inner) =>
      /\blocalTransport\b/.test(inner)
        ? // Only where localTransport is the key being read, never a default value.
          whole
            .replace(/(?<=[{,]\s*)localTransport(?:\s*:\s*[A-Za-z_$][\w$]*)?(?=\s*[,}=])/g, "")
            // The alias a default binds is a declaration, not a use of it;
            // the default expression stays, and its localTransport counts.
            .replace(
              /[A-Za-z_$][\w$]*\s*=(?![=>])(?=[^,}]*(?<![\w$.])localTransport(?![\w$]))/g,
              ""
            )
        : whole
    )
  const alt = [...names].map((name) => name.replace(/\$/g, "\\$")).join("|")
  // A bound name, or `localTransport` read as a member of anything.
  // (A quoted `"localTransport"` is a string key, counted below.)
  const head = String.raw`(?:(?<![\w$."'\x60])(?<!\b(?:const|let|var)\s+)(?:${alt})|(?<=\.\s*)localTransport)`
  const call = new RegExp(String.raw`${head}\s*\.\s*([A-Za-z_$][\w$]*)\s*${GENERIC}\s*\(`, "g")
  const constants = fileConstants(code)
  for (const m of code.matchAll(call)) {
    const args = callArguments(code, (m.index ?? 0) + m[0].length - 1)
    uses.add(`${m[1]}:${argumentName(args?.[0], constants)}`)
  }
  const member = new RegExp(
    String.raw`${head}\s*\.\s*([A-Za-z_$][\w$]*)(?![\w$])(?!\s*${GENERIC}\s*\()`,
    "g"
  )
  for (const m of code.matchAll(member)) uses.add(`member:${m[1]}`)
  const reference = new RegExp(String.raw`${head}(?![\w$])(?!\s*\.)`, "g")
  const strings = /(["'`])localTransport\1/g
  // A lib/tauri namespace used other than as `ns.member` (`export { t }`,
  // `t["local" + "Transport"]`) hands localTransport on with everything else.
  let namespaceUses = 0
  for (const m of stripped.matchAll(new RegExp(LIB_TAURI_NAMESPACE_RE.source, "gm"))) {
    const ns = m[1].replace(/\$/g, "\\$")
    const bare = new RegExp(String.raw`(?<![\w$./"'\x60-])${ns}(?![\w$"'\x60/-])(?!\s*\.)`, "g")
    namespaceUses += [...withoutImports(stripped).matchAll(bare)].length
  }
  const references =
    [...code.matchAll(reference)].length + [...code.matchAll(strings)].length + namespaceUses
  return { uses: [...uses].sort(), references }
}

/** A non-owner file that re-exports all of lib/tauri, localTransport with it. */

/**
 * @param {string[]} files
 * @param {{ read: (p: string) => string }} io
 * @returns {Record<string, { uses: string[], references: number }>}
 */
export function collectLocalTransportUses(files, io) {
  const owners = new Set(LOCAL_TRANSPORT_OWNERS)
  /** @type {Record<string, { uses: string[], references: number }>} */
  const out = {}
  for (const path of [...files].sort()) {
    if (!isRendererSource(path) || owners.has(path)) continue
    const source = io.read(path)
    if (
      !/\blocalTransport\b/.test(source) &&
      !STAR_REEXPORT_RE.test(source) &&
      !LIB_TAURI_NAMESPACE_RE.test(source)
    )
      continue
    const found = localTransportUses(source, path)
    if (found.uses.length || found.references) out[path] = found
  }
  return out
}

/**
 * @param {Record<string, { uses: string[], references: number }>} found
 * @param {Record<string, { uses?: string[], references?: number }>} pinned
 * @returns {string[]} errors
 */
export function checkLocalTransportPins(found, pinned) {
  const errors = []
  for (const [path, use] of Object.entries(found)) {
    const pin = pinned[path]
    const allowed = new Set(pin?.uses ?? [])
    const stray = use.uses.filter((u) => !allowed.has(u))
    if (stray.length) errors.push(`${path}: unpinned localTransport use ${stray.join(", ")}`)
    const unused = [...allowed].filter((u) => !use.uses.includes(u))
    if (unused.length) errors.push(`${path}: localTransport pin lists unused ${unused.join(", ")}`)
    if (use.references !== (pin?.references ?? 0)) {
      errors.push(
        `${path}: hands localTransport on as a value ${use.references} time(s), pinned ${pin?.references ?? 0}`
      )
    }
  }
  for (const path of Object.keys(pinned)) {
    if (!found[path]) errors.push(`${path}: localTransport pin for a file that no longer uses it`)
  }
  return errors
}

/**
 * The pins `--prune-local-transport` may write: each surviving pin intersected
 * with what the file still uses, its hand-off count lowered to what is found.
 * A use, a file or a higher count the pins do not already hold is refused; a
 * pin is added by hand, in review, never by the writer.
 *
 * @param {Record<string, { uses: string[], references: number }>} found
 * @param {Record<string, { uses?: string[], references?: number }>} pinned
 * @returns {{ pins: Record<string, { uses: string[], references: number }>, refused: string[] }}
 */
export function pruneLocalTransportPins(found, pinned) {
  const refused = []
  /** @type {Record<string, { uses: string[], references: number }>} */
  const pins = {}
  for (const path of Object.keys(found).sort()) {
    const use = found[path]
    const pin = pinned[path]
    if (!pin) {
      refused.push(`${path}: not pinned`)
      continue
    }
    const allowed = new Set(pin.uses ?? [])
    const stray = use.uses.filter((u) => !allowed.has(u))
    if (stray.length) refused.push(`${path}: unpinned localTransport use ${stray.join(", ")}`)
    if (use.references > (pin.references ?? 0)) {
      refused.push(
        `${path}: hands localTransport on as a value ${use.references} time(s), pinned ${pin.references ?? 0}`
      )
    }
    pins[path] = {
      uses: [...allowed].filter((u) => use.uses.includes(u)).sort(),
      references: Math.min(use.references, pin.references ?? 0),
    }
  }
  return { pins, refused }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** @returns {{ findings: string[], census: Map<string, {files:number,sites:number}>, remotelyReachable: string[], desktopGated: Set<string>, errors: string[] }} */
export function collect(files, io) {
  const findings = [...findSeamBypasses(files, io)]

  const navConfig = io.read("components/settings/settings-nav-config.ts")
  findings.push(...findDesktopOnlySections(navConfig))

  const rpcModules = files
    .filter(
      (p) =>
        isRpcSource(p) &&
        // rpc/tests.rs enumerates command names as fixtures, not dispatch arms.
        !p.endsWith("/tests.rs")
    )
    .map((path) => ({ path, source: io.read(path) }))

  /** @type {Map<string, any>} */
  const manifest = new Map()
  try {
    const raw = JSON.parse(io.read("protocol/companion-commands.json"))
    for (const cmd of raw.commands ?? []) manifest.set(cmd.name, cmd)
  } catch {
    /* manifest unreadable — class C still reports, just without remote flagging */
  }

  let registered = new Set()
  try {
    registered = new Set(parseRegisteredCommands(io.read("src-tauri/src/lib.rs")))
  } catch {
    /* fall back to manifest-only membership */
  }

  // An empty list turns the accessor rule off without a word, so every arm it
  // reports would silently read as served on both hosts.
  const errors = []
  const headlessAbsent = headlessAbsentAccessors(io.read(RPC_HOST_FILE))
  if (headlessAbsent.length === 0) {
    errors.push(
      `${RPC_HOST_FILE}: no headless accessor answers None (is \`impl RpcHost for Arc<HeadlessServices>\` still there?)`
    )
  }
  const { findings: armFindings, remotelyReachable } = findOneSidedArms(
    rpcModules,
    manifest,
    registered,
    headlessAbsent
  )
  findings.push(...armFindings)

  const desktopGated = new Set(
    armFindings.filter((f) => f.endsWith(":desktop-only")).map((f) => f.split(":")[1])
  )
  findings.push(...findCapabilityMisreports(parseHostFeatures(io), desktopGated))

  return {
    findings: [...new Set(findings)].sort(),
    census: censusRuntimeGuards(files, io),
    remotelyReachable,
    desktopGated,
    errors,
  }
}

/**
 * Extract per-host feature declarations from `lib/platform/host-feature-manifest.ts`.
 * The file guards each feature with `if (platform === "…")`, so the hosts a
 * feature claims are the platforms named in its enclosing guard.
 *
 * @param {{ read: (p: string) => string }} io
 * @returns {Array<{ feature: string, hosts: string[], operations: string[] }>}
 */
export function parseHostFeatures(io) {
  const source = io.read("lib/platform/host-feature-manifest.ts")
  const out = []
  const blockRe = /if\s*\(([^)]*platform\s*===[^)]*)\)\s*\{([\s\S]*?)\n {2}\}/g
  for (const block of source.matchAll(blockRe)) {
    const hosts = [...block[1].matchAll(/platform\s*===\s*["']([a-z]+)["']/g)].map((m) => m[1])
    for (const feat of block[2].matchAll(
      /features\[["']([^"']+)["']\]\s*=\s*\{([\s\S]*?)\n {4}\}/g
    )) {
      const operations = [...feat[2].matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((m) => m[1])
      out.push({ feature: feat[1], hosts, operations })
    }
  }
  return out
}

export function main(argv = []) {
  // Each renderer file is read by several rules (bypasses, census, pins).
  const reads = new Map()
  const io = {
    read: (p) => {
      if (reads.has(p)) return reads.get(p)
      let text = ""
      try {
        text = readFileSync(join(REPO_ROOT, p), "utf8")
      } catch {
        /* missing: read as empty */
      }
      reads.set(p, text)
      return text
    },
  }
  const files = trackedFiles()
  const {
    findings: collectedFindings,
    census,
    remotelyReachable,
    errors: collectErrors,
  } = collect(files, io)
  const annotationDocument = JSON.parse(io.read("scripts/gates/host-parity-annotations.json"))
  const contracts = classifyDesktopContracts(
    collectedFindings,
    annotationDocument.desktopContracts ?? {},
    io
  )
  const seams = classifyPhysicalSeams(contracts.findings, annotationDocument.subsystems ?? {}, io)
  const { findings } = seams
  const localUses = collectLocalTransportUses(files, io)
  const localPins = JSON.parse(io.read("scripts/gates/host-parity-local-transport.json") || "{}")
  if (argv.includes("--prune-local-transport")) {
    const { pins, refused } = pruneLocalTransportPins(localUses, localPins.files ?? {})
    if (refused.length) {
      for (const error of refused) console.error(`[host-parity] refusing to pin: ${error}`)
      return 1
    }
    writeFileSync(
      LOCAL_TRANSPORT_FILE,
      `${JSON.stringify({ ...localPins, files: pins }, null, 2)}\n`
    )
    console.log(`[host-parity] localTransport pins pruned: ${Object.keys(pins).length} file(s)`)
    return 0
  }
  const errors = [
    ...collectErrors,
    ...contracts.errors,
    ...seams.errors,
    ...checkLocalTransportPins(localUses, localPins.files ?? {}),
  ]
  if (errors.length) {
    for (const error of errors) console.error(`[host-parity] ${error}`)
    return 1
  }
  if (contracts.classified.length) {
    console.log(`[host-parity] ${contracts.classified.length} verified physical desktop contracts:`)
    for (const key of contracts.classified) console.log(`    ${key}`)
  }
  if (seams.classified.length) {
    console.log(`[host-parity] ${seams.classified.length} verified physical seam file(s):`)
    for (const key of seams.classified) console.log(`    ${key}`)
  }

  if (argv.includes("--write-baseline")) {
    const { added } = diffAgainstBaseline(findings, readBaseline().findings)
    if (added.length) {
      console.error(`[host-parity] refusing to baseline new debt: ${added.join(", ")}`)
      return 1
    }
    const payload = writeBaseline(findings)
    console.log(`[host-parity] baseline written: ${payload.findings.length} known gap(s)`)
    return 0
  }

  const annotations = annotationDocument.subsystems ?? {}
  const annotationStatus = checkAnnotations(census, annotations)

  if (argv.includes("--report")) {
    printReport(findings, census, remotelyReachable, annotations, annotationStatus)
    return 0
  }

  const baseline = readBaseline()
  const { added, fixed } = diffAgainstBaseline(findings, baseline.findings)

  if (fixed.length) {
    console.log(
      `[host-parity] ${fixed.length} baselined gap(s) are closed — ` +
        "run `pnpm audit:host-parity:baseline` to lock the gain in."
    )
  }
  if (remotelyReachable.length) {
    console.log(
      `[host-parity] NOTE: ${remotelyReachable.length} headless-only arm(s) are ` +
        "`target=execution` over http/ws/webrtc — a remote client on a DESKTOP host reaches " +
        "them and gets a 503 naming the opposite host:"
    )
    for (const c of remotelyReachable) console.log(`    ${c}`)
  }
  if (annotationStatus.missing.length) {
    // The Class D docstring has always said this gates ("an unannotated
    // subsystem means a gap nobody has looked at"), but the code only printed
    // it. Now that every subsystem the census finds carries a classification,
    // the claim and the behaviour agree.
    console.error(
      `[host-parity] ${annotationStatus.missing.length} subsystem(s) have host guards but no ` +
        "recorded classification in host-parity-annotations.json:"
    )
    for (const s of annotationStatus.missing) console.error(`    ${s}`)
    console.error(
      `\n  Classify each one (${CLASSIFICATIONS.join(" | ")}) with a note saying what its\n` +
        "  guards actually are. An unclassified subsystem is a gap nobody has adjudicated."
    )
    return 1
  }
  if (annotationStatus.stale.length) {
    console.error(
      `[host-parity] ${annotationStatus.stale.length} annotation(s) no longer match anything — ` +
        "the subsystem lost its guards, or the annotated file is gone:"
    )
    for (const s of annotationStatus.stale) console.error(`    ${s}`)
    return 1
  }
  if (annotationStatus.invalid.length) {
    console.error(
      `[host-parity] ${annotationStatus.invalid.length} annotation(s) carry an unknown ` +
        `classification (expected one of ${CLASSIFICATIONS.join(", ")}):`
    )
    for (const s of annotationStatus.invalid) console.error(`    ${s}`)
    return 1
  }

  if (added.length) {
    const verb = ENFORCE_RATCHET ? "FAIL" : "REPORT-ONLY"
    console.error(`[host-parity] ${verb}: ${added.length} new parity gap(s):`)
    for (const f of added) console.error(`  ${f}`)
    console.error(
      "\n  A: route the call through `transport` (lib/tauri) instead of importing\n" +
        "     `invoke`/`listen` directly — a direct import throws on every non-Tauri host.\n" +
        "  B: declare the capability the section needs instead of keying it to the host.\n" +
        "  C: give the arm a host-neutral accessor on `DispatchHost` (see `sidecar_state()`).\n" +
        "  E: the feature works headless — stop gating its declaration to `tauri`.\n" +
        "  If the gap is genuinely physical, record it in host-parity-annotations.json\n" +
        "  and re-baseline."
    )
    return ENFORCE_RATCHET ? 1 : 0
  }

  console.log(
    `[host-parity] OK: ${findings.length} known gap(s), none new ` +
      `(baseline holds ${baseline.findings.length}); ` +
      `${census.size} subsystem(s) carry host guards.`
  )
  return 0
}

function printReport(findings, census, remotelyReachable, annotations, annotationStatus) {
  const byClass = new Map()
  for (const f of findings) {
    const cls = f[0]
    if (!byClass.has(cls)) byClass.set(cls, [])
    byClass.get(cls).push(f)
  }
  const titles = {
    A: "transport-seam bypass (throws on every non-Tauri host)",
    B: "UI hard-coded to a host",
    C: "one-sided RPC arm",
    E: "capability table vs. manifest",
  }
  for (const cls of ["A", "B", "C", "E"]) {
    const rows = byClass.get(cls) ?? []
    console.log(`\n== Class ${cls}: ${titles[cls]} — ${rows.length}`)
    for (const r of rows) console.log(`   ${r.slice(2)}`)
  }
  console.log(`\n== Class D: runtime-guard census (map only, never gates)`)
  const sorted = [...census.entries()].sort((a, b) => b[1].sites - a[1].sites)
  for (const [key, row] of sorted) {
    const cls = annotations[key]?.classification ?? "UNANNOTATED"
    console.log(
      `   ${String(row.sites).padStart(5)} sites / ${String(row.files).padStart(3)} files  ${key}  [${cls}]`
    )
  }
  const totals = sorted.reduce(
    (acc, [, r]) => ({ sites: acc.sites + r.sites, files: acc.files + r.files }),
    { sites: 0, files: 0 }
  )
  console.log(
    `   ----- ${totals.sites} sites across ${totals.files} files, ${census.size} subsystems`
  )
  if (remotelyReachable.length) {
    console.log(`\n== Remotely reachable headless-only arms — ${remotelyReachable.length}`)
    for (const c of remotelyReachable) console.log(`   ${c}`)
  }
  if (annotationStatus.stale.length) {
    console.log(
      `\n== Stale annotations (subsystem no longer has guards) — ${annotationStatus.stale.length}`
    )
    for (const s of annotationStatus.stale) console.log(`   ${s}`)
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-host-parity.mjs")
) {
  process.exit(main(process.argv.slice(2)))
}
