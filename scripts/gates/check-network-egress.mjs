#!/usr/bin/env node
/**
 * Gate: every outbound network call on the desktop Host goes through a
 * transport that knows about the proxy.
 *
 * ## Why this exists
 *
 * The packaged desktop shell serves the renderer under a static CSP whose
 * `connect-src` is `'self' ipc: http://ipc.localhost ws: wss:`. A renderer
 * `fetch("https://anything")` — or `new WebSocket`, or `new EventSource` — is
 * blocked before it leaves the WebView, and even where it is not, it never
 * sees the Off/Manual/Auto proxy the user configured, its bypass list, or its
 * keyring credentials. Those live in Rust.
 *
 * `pnpm dev` has no CSP. That is the whole problem: a bare `fetch` looks
 * perfectly healthy in development and is dead in the packaged app. It has
 * shipped that way repeatedly here — the OTLP/Langfuse log transports, the
 * entire local-provider surface, web search, RAG reranking, cloud OCR, the
 * Site preview readiness probe. Each was found by hand, months later.
 *
 * Code review does not catch this: `await fetch(url)` is the most ordinary
 * line in the language. A gate does.
 *
 * ## What counts as an egress
 *
 * TypeScript:
 *   - a call to the global `fetch`
 *   - `new WebSocket(...)`
 *   - `new EventSource(...)`
 *
 * Rust:
 *   - `reqwest::Client::new()` — no policy can be applied to it
 *   - `.no_proxy()` — an explicit opt-out of the policy
 *   - `TcpStream::connect` / `connect_timeout` — a raw socket the proxy
 *     policy never sees (ADR-0234: remote desktop bridges dial LAN devices)
 *
 * ## The approved paths
 *
 * TS: `proxyFetch` / `createPlatformFetch` (buffered),
 * `createPlatformStreamingFetch` (SSE, NDJSON, large bodies),
 * `createPlatformWebSocket` (WSS). Rust: `apply_reqwest_policy` /
 * `managed_client` / `wsproxy::connect_via_proxy`.
 *
 * ## Exceptions
 *
 * Declared one entry at a time in `network-egress-allowlist.json`, each with a
 * `reason` from a fixed vocabulary. Directory-level wildcards are rejected on
 * purpose: an exception that covers a whole tree stops being read and starts
 * being a hole. An entry whose findings have disappeared is also an error —
 * a stale exception silently re-opens the next bare call written on that line.
 *
 * Usage:
 *   node scripts/gates/check-network-egress.mjs
 *   node scripts/gates/check-network-egress.mjs --write-baseline
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import ts from "typescript"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
const ALLOWLIST_PATH = resolve(__dirname, "network-egress-allowlist.json")

/** Roots whose code can run in the desktop renderer or the Rust host. */
export const TS_ROOTS = ["app", "components", "hooks", "lib", "packages", "plugins", "stores"]
export const RUST_ROOTS = ["crates", "src-tauri/src"]

/**
 * Why an egress may stay unmanaged. Fixed vocabulary — a free-text reason
 * degrades into "because it was there".
 */
export const REASONS = new Set([
  // Talks to 127.0.0.1 / a unix socket that the proxy must never intercept.
  "loopback",
  // Reads a blob:, data:, or bundled asset URL — never a network origin.
  "resource-read",
  // The non-Tauri leg of a call that uses a native command on the desktop.
  "browser-fallback",
  // Capacitor's own native HTTP plugin, or the mobile shell's WebView.
  "capacitor",
  // The companion transport, which pins its own TLS and must not be re-routed.
  "companion-pinned",
  // Runs in Node (headless brain, CLI, sidecar, build script), where the
  // process environment carries the proxy instead.
  "server-side",
  // Test scaffolding, fixtures, or a generated-code template.
  "test",
  // The managed transport's own implementation — the one place a bare call
  // is the point.
  "transport-impl",
  // Dials only addresses this code resolved and checked as public
  // (`resolve_to_addrs` over `egress::is_forbidden_dest_ip`). A forward proxy
  // would re-resolve the hostname on its side and void the check.
  "pinned-public",
  // Raw TCP to an endpoint the user named and confirmed (an SSH forward's
  // destination, a remote desktop server pinned to one address). The protocol
  // is not HTTP, and re-routing would defeat the confirmation.
  "user-endpoint",
])

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/**
 * Files whose egress is scaffolding, not product code.
 *
 * Excluded rather than allowlisted: a test that stubs `fetch` is not a policy
 * decision anyone needs to review, and 40 such entries would bury the ones
 * that are.
 */
export function isScaffolding(file) {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /\.stories\.[jt]sx?$/.test(file) ||
    file.includes("/__mocks__/") ||
    file.includes("/__fixtures__/") ||
    /(?:^|\/)tests?\//.test(file) ||
    /(?:^|\/)benches\//.test(file)
  )
}

/**
 * Which of `git ls-files`\' lines this gate should actually open.
 *
 * `exists` is a required argument rather than a defaulted one because the
 * whole point of this function is the third filter, and a default would be the
 * one branch every test stubs away.
 *
 * That third filter is not bookkeeping. `git ls-files` still lists a tracked
 * file that has been deleted from disk but not staged, and reading one threw
 * ENOENT straight out of `collectFindings` — so the gate CRASHED instead of
 * reporting. A crash is not a verdict: it says nothing about the egress in the
 * rest of the tree, and it hid 20 real unmanaged call sites for as long as one
 * unstaged deletion existed. A tree with unstaged deletions is ordinary
 * (mid-refactor, or another session sharing the checkout), so a deleted file is
 * simply not there to scan. `check-static-export.mjs:listSourceFiles` has
 * carried this same guard from the start.
 *
 * @param {string[]} lines raw `git ls-files` output lines
 * @param {string[]} extensions file suffixes this pass understands
 * @param {(file: string) => boolean} exists is the path still on disk
 * @returns {string[]}
 */
export function selectScannableFiles(lines, extensions, exists) {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && extensions.some((ext) => line.endsWith(ext)))
    .filter((line) => !isScaffolding(line))
    .filter((line) => exists(line))
}

function listFiles(roots, extensions) {
  const out = execSync(`git -C "${REPO_ROOT}" ls-files ${roots.map((r) => `"${r}"`).join(" ")}`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return selectScannableFiles(out.split("\n"), extensions, (file) =>
    existsSync(resolve(REPO_ROOT, file))
  )
}

/**
 * Blank out string/template/comment content so a `fetch(` inside a doc comment
 * or a generated-code template is not read as a call. Positions are preserved
 * (each removed character becomes a space) so line/column arithmetic still
 * works on the result.
 */
export function blankNonCode(source) {
  const out = source.split("")
  let index = 0
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " "
    }
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      blank(index, end === -1 ? source.length : end)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2
          continue
        }
        if (source[cursor] === char) break
        cursor += 1
      }
      blank(index + 1, cursor)
      index = cursor + 1
      continue
    }
    index += 1
  }
  return out.join("")
}

/**
 * The Rust counterpart of `blankNonCode`.
 *
 * `blankNonCode` reads `'` as a string delimiter, which is right for
 * TypeScript and wrong for Rust: `MutexGuard<'static, ()>` opens a lifetime,
 * not a literal. Read as a string, it blanked everything up to the next
 * apostrophe — often in a comment hundreds of lines later — which hid real
 * egress calls in that span and threw off the brace count that finds the end
 * of a test module. Here `'` starts a char literal only when one closes
 * (`'x'`, `'\n'`, `'\u{1F600}'`); otherwise it is a lifetime or label and
 * stays code. Raw strings (`r#"…"#`, `br"…"`) and nested block comments are
 * Rust syntax too.
 */
export function blankRustNonCode(source) {
  const out = source.split("")
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " "
    }
  }
  let index = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      const stop = end === -1 ? source.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (char === "/" && next === "*") {
      let depth = 1
      let cursor = index + 2
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "/" && source[cursor + 1] === "*") {
          depth += 1
          cursor += 2
        } else if (source[cursor] === "*" && source[cursor + 1] === "/") {
          depth -= 1
          cursor += 2
        } else cursor += 1
      }
      blank(index, cursor)
      index = cursor
      continue
    }
    const identifierBefore = index > 0 && /[\w$]/.test(source[index - 1])
    const raw = identifierBefore ? null : /^b?r(#*)"/.exec(source.slice(index, index + 260))
    if (raw) {
      const open = index + raw[0].length
      const closing = `"${raw[1]}`
      const end = source.indexOf(closing, open)
      const stop = end === -1 ? source.length : end
      blank(open, stop)
      index = stop + closing.length
      continue
    }
    if (char === '"') {
      let cursor = index + 1
      while (cursor < source.length && source[cursor] !== '"') {
        cursor += source[cursor] === "\\" ? 2 : 1
      }
      blank(index + 1, cursor)
      index = cursor + 1
      continue
    }
    if (char === "'") {
      const literal = /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n]{1,2})'/u.exec(
        source.slice(index, index + 14)
      )
      // `[^\\'\n]{1,2}` admits a surrogate pair; a two-character run that is
      // not one is a lifetime followed by a quote, so check it is one code point.
      const body = literal?.[0].slice(1, -1)
      if (body !== undefined && (body.startsWith("\\") || [...body].length === 1)) {
        blank(index + 1, index + literal[0].length - 1)
        index += literal[0].length
        continue
      }
    }
    index += 1
  }
  return out.join("")
}

/**
 * Blank every `#[cfg(test)]` item: an inline `mod … { … }`, a test-only `fn`
 * or `impl`, or a `mod tests;` / `use` declaration.
 *
 * Rust keeps its unit tests in the source file, and those tests build bare
 * `reqwest::Client::new()` / `.no_proxy()` clients by design. Without this they
 * would each need an allowlist entry that says nothing. Other attributes may
 * sit between `#[cfg(test)]` and the item (`#[allow(…)]`, `#[path = …]`).
 * Run it on `blankRustNonCode` output so braces in strings do not count.
 */
export function blankRustTestItems(code) {
  const out = code.split("")
  const pattern = /#\[cfg\(test\)\]/g
  let match
  while ((match = pattern.exec(code)) !== null) {
    let depth = 0
    let end = -1
    for (let i = match.index + match[0].length; i < code.length; i += 1) {
      const char = code[i]
      if (char === "(" || char === "[") depth += 1
      else if (char === ")" || char === "]") depth -= 1
      else if (depth === 0 && char === ";") {
        end = i
        break
      } else if (depth === 0 && char === "{") {
        let braces = 0
        for (let j = i; j < code.length; j += 1) {
          if (code[j] === "{") braces += 1
          else if (code[j] === "}") {
            braces -= 1
            if (braces === 0) {
              end = j
              break
            }
          }
        }
        if (end === -1) end = code.length - 1
        break
      }
    }
    if (end === -1) continue
    for (let i = match.index; i <= end && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " "
    }
    pattern.lastIndex = end + 1
  }
  return out.join("")
}

/** Index → 1-based line number. */
function lineAt(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1
  }
  return line
}

/** Position of the `)` closing the `(` at `openIndex`, or -1. */
function matchParen(source, openIndex) {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1
    else if (source[i] === ")") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Find bare-`fetch` CALL sites, excluding declarations.
 *
 * Three shapes look identical to a naive regex and are not calls:
 *   `async fetch(ref: Ref)` (a class/object method), `fetch(remote?: string)`
 *   (an interface member), and `fetch(ctx) { … }` (an object literal method).
 * A typed parameter or a following `{` gives each of them away.
 */
/** The argument list up to its first depth-0 comma. */
export function firstTopLevelArgument(args) {
  let depth = 0
  for (let i = 0; i < args.length; i += 1) {
    const char = args[i]
    if (char === "(" || char === "[" || char === "{") depth += 1
    else if (char === ")" || char === "]" || char === "}") depth -= 1
    else if (char === "," && depth === 0) return args.slice(0, i)
  }
  return args
}

/** `name: Type` / `name?: Type` — a declaration's first parameter. */
export function isTypedParameter(segment) {
  return /^\s*\.{0,3}\s*[A-Za-z_$][\w$]*\s*\??\s*:/.test(segment)
}

/**
 * The objects a caller can reach the *global* `fetch`, `WebSocket` or
 * `EventSource` through.
 *
 * `globalThis.fetch(url)` is the same unmanaged call as `fetch(url)`, and it is
 * the form that survives a search for the bare one, so the gate has to see both
 * or an exception quietly stops matching the file it was written for. Any other
 * receiver is a caller's own field (`this.fetchImpl`, `deps.fetch`) and stays
 * out.
 */
const GLOBAL_RECEIVER = String.raw`(?:(?:globalThis|window|self)\s*\.\s*)?`

export function findFetchCalls(code) {
  const findings = []
  const pattern = new RegExp(String.raw`(^|[^\w$])${GLOBAL_RECEIVER}fetch\s*\(`, "g")
  let match
  while ((match = pattern.exec(code)) !== null) {
    const nameStart = match.index + match[1].length
    // A dot the alternation did not consume means some other object owns this
    // `fetch`, so it is not the global one.
    if (code[nameStart - 1] === ".") continue
    const before = code.slice(Math.max(0, nameStart - 24), nameStart)
    if (/\b(?:async|function)\s*$/.test(before)) continue

    const open = code.indexOf("(", nameStart)
    const close = matchParen(code, open)
    if (close === -1) continue
    // Only the FIRST top-level argument decides. Looking further would read
    // `fetch(url, { signal: x })` as a typed parameter list, because an object
    // literal's properties have exactly the shape of an annotation.
    if (isTypedParameter(firstTopLevelArgument(code.slice(open + 1, close)))) continue
    // `fetch(...) {` is a method body, not a call.
    if (/^\s*\{/.test(code.slice(close + 1))) continue

    findings.push({ index: nameStart, kind: "fetch" })
  }
  return findings
}

/**
 * Does the `fetch` identifier at `index` name a local binding rather than the
 * global?
 *
 * Injected transports are the house style — `fetch: PlatformFetch` in a deps
 * bag, `const fetch: PlatformFetch = …` around a managed client — and inside
 * them `await fetch(url)` reads exactly like the global call. The regex cannot
 * tell them apart; the binding can. This walks the enclosing scopes (function
 * parameters, block and file declarations, imports, loop and catch bindings)
 * and returns true when one of them declares `fetch`.
 *
 * A binding that is just the global under another name
 * (`const fetch = globalThis.fetch`, `fetch = window.fetch` as a default) is
 * not a shadow: that is the unmanaged call with one more line in front of it.
 *
 * @param {import("typescript").SourceFile} sourceFile parsed original source
 * @param {number} index offset of the `fetch` identifier
 */
export function isShadowedFetch(sourceFile, index) {
  const node = identifierAt(sourceFile, index)
  if (!node) return false
  const aliasesGlobal = (initializer) =>
    initializer !== undefined &&
    /^(?:\(?\s*)?(?:(?:globalThis|window|self)\s*\.\s*)?fetch\b/.test(
      initializer.getText(sourceFile).trim()
    )
  const declares = (name, initializer) => bindsFetch(name) && !aliasesGlobal(initializer)
  const declaresInStatements = (statements) =>
    statements.some((statement) => {
      if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.some((d) => declares(d.name, d.initializer))
      }
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        return statement.name?.text === "fetch"
      }
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (!clause) return false
        if (clause.name?.text === "fetch") return true
        const bindings = clause.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === "fetch"
        return Boolean(bindings?.elements.some((element) => element.name.text === "fetch"))
      }
      return false
    })
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some((p) => declares(p.name, p.initializer))) return true
      if (ts.isFunctionExpression(scope) && scope.name?.text === "fetch") return true
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      if (declaresInStatements(scope.statements)) return true
    }
    if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      if (declaresInStatements(scope.statements)) return true
    }
    if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((d) => declares(d.name, d.initializer))
    ) {
      return true
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      if (bindsFetch(scope.variableDeclaration.name)) return true
    }
  }
  return false
}

function bindsFetch(name) {
  if (ts.isIdentifier(name)) return name.text === "fetch"
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsFetch(element.name)
  )
}

function identifierAt(sourceFile, index) {
  let found
  const visit = (node) => {
    if (found || index < node.pos || index >= node.end) return
    if (ts.isIdentifier(node) && node.getStart(sourceFile) === index) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function scriptKindOf(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX
  return ts.ScriptKind.TS
}

/** Parse `source` once, only for files that have a candidate to resolve. */
export function parseTypeScript(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file))
}

export function findConstructorCalls(code) {
  const findings = []
  for (const [kind, pattern] of [
    ["websocket", new RegExp(String.raw`new\s+${GLOBAL_RECEIVER}WebSocket\s*\(`, "g")],
    ["eventsource", new RegExp(String.raw`new\s+${GLOBAL_RECEIVER}EventSource\s*\(`, "g")],
  ]) {
    let match
    while ((match = pattern.exec(code)) !== null) {
      findings.push({ index: match.index, kind })
    }
  }
  return findings
}

export function findRustEgress(code) {
  const findings = []
  for (const [kind, pattern] of [
    ["reqwest-client-new", /reqwest::Client::new\s*\(\s*\)/g],
    ["no-proxy", /\.no_proxy\s*\(\s*\)/g],
    ["tcp-connect", /\bTcpStream::connect(?:_timeout)?\s*\(/g],
  ]) {
    let match
    while ((match = pattern.exec(code)) !== null) {
      findings.push({ index: match.index, kind })
    }
  }
  return findings
}

/** Every unmanaged egress in the tree, as `{file, line, kind}`. */
export function collectFindings(
  readFile = (file) => readFileSync(resolve(REPO_ROOT, file), "utf8")
) {
  const findings = []
  for (const file of listFiles(TS_ROOTS, [".ts", ".tsx", ".mts", ".cts"])) {
    const source = readFile(file)
    const code = blankNonCode(source)
    let parsed
    for (const hit of [...findFetchCalls(code), ...findConstructorCalls(code)]) {
      if (hit.kind === "fetch" && code.startsWith("fetch", hit.index)) {
        parsed ??= parseTypeScript(file, source)
        if (isShadowedFetch(parsed, hit.index)) continue
      }
      findings.push({ file, line: lineAt(code, hit.index), kind: hit.kind })
    }
  }
  for (const file of listFiles(RUST_ROOTS, [".rs"])) {
    const code = blankRustTestItems(blankRustNonCode(readFile(file)))
    for (const hit of findRustEgress(code)) {
      findings.push({ file, line: lineAt(code, hit.index), kind: hit.kind })
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return findings
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/** `file:kind` — deliberately NOT line-scoped, so an edit above a known
 * exception does not fail the build for an unrelated reason. Line drift is
 * noise; a NEW file or a NEW kind in an existing file is the signal. */
export function keyOf(finding) {
  return `${finding.file}::${finding.kind}`
}

export function validateAllowlist(allowlist) {
  const errors = []
  if (!Array.isArray(allowlist?.exceptions)) {
    return ["allowlist must have an `exceptions` array"]
  }
  const seen = new Set()
  for (const entry of allowlist.exceptions) {
    const label = `${entry?.file ?? "<no file>"}::${entry?.kind ?? "<no kind>"}`
    if (typeof entry?.file !== "string" || entry.file.length === 0) {
      errors.push(`${label}: \`file\` is required`)
      continue
    }
    // A wildcard exception stops being read and starts being a hole.
    if (/[*?]|\/$/.test(entry.file)) {
      errors.push(`${label}: wildcards and directory prefixes are not allowed — list each file`)
    }
    if (typeof entry?.kind !== "string") errors.push(`${label}: \`kind\` is required`)
    if (!REASONS.has(entry?.reason)) {
      errors.push(`${label}: \`reason\` must be one of ${[...REASONS].sort().join(", ")}`)
    }
    if (typeof entry?.note !== "string" || entry.note.trim().length < 12) {
      errors.push(`${label}: \`note\` must say why, in a sentence`)
    }
    const key = `${entry.file}::${entry.kind}`
    if (seen.has(key)) errors.push(`${label}: duplicate entry`)
    seen.add(key)
  }
  return errors
}

export function diffAgainstAllowlist(findings, allowlist) {
  const allowed = new Set(allowlist.exceptions.map((entry) => `${entry.file}::${entry.kind}`))
  const present = new Set(findings.map(keyOf))
  return {
    unlisted: findings.filter((finding) => !allowed.has(keyOf(finding))),
    stale: [...allowed].filter((key) => !present.has(key)).sort(),
  }
}

function buildBaseline(findings) {
  const byKey = new Map()
  for (const finding of findings) {
    const key = keyOf(finding)
    if (!byKey.has(key)) {
      byKey.set(key, {
        file: finding.file,
        kind: finding.kind,
        reason: "TODO",
        note: "TODO: explain why this egress cannot use a managed transport.",
      })
    }
  }
  return { exceptions: [...byKey.values()] }
}

function main() {
  const findings = collectFindings()

  if (process.argv.includes("--write-baseline")) {
    writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(buildBaseline(findings), null, 2)}\n`)
    console.log(
      `[network-egress] wrote ${buildBaseline(findings).exceptions.length} entries — ` +
        `replace every TODO reason/note before committing.`
    )
    return 0
  }

  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
  const shapeErrors = validateAllowlist(allowlist)
  if (shapeErrors.length > 0) {
    console.error(`[network-egress] ${shapeErrors.length} malformed allowlist entr(ies):`)
    for (const error of shapeErrors) console.error(`  - ${error}`)
    return 1
  }

  const { unlisted, stale } = diffAgainstAllowlist(findings, allowlist)

  if (unlisted.length > 0) {
    console.error(`[network-egress] ${unlisted.length} unmanaged egress site(s):`)
    for (const finding of unlisted) {
      console.error(`  ${finding.file}:${finding.line}  ${finding.kind}`)
    }
    console.error("")
    console.error("  Use a managed transport:")
    console.error("    TS   request/response  → proxyFetch / createPlatformFetch")
    console.error("    TS   SSE, NDJSON, big  → createPlatformStreamingFetch")
    console.error("    TS   WebSocket         → createPlatformWebSocket")
    console.error("    Rust                   → managed_client / apply_reqwest_policy")
    console.error("")
    console.error(
      "  If it genuinely cannot, add ONE entry per file to " +
        "scripts/gates/network-egress-allowlist.json with a reason and a note."
    )
    return 1
  }

  if (stale.length > 0) {
    console.error(`[network-egress] ${stale.length} allowlist entr(ies) match nothing any more:`)
    for (const key of stale) console.error(`  ${key}`)
    console.error("")
    console.error(
      "  Delete them. A stale exception silently re-opens the next bare call written in that file."
    )
    return 1
  }

  console.log(
    `[network-egress] OK: ${findings.length} egress site(s), all ` +
      `${allowlist.exceptions.length} exception(s) accounted for.`
  )
  return 0
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirectRun) process.exit(main())
