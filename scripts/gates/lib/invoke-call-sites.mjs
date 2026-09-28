/**
 * Parse `invoke("command", { … })` call sites for their ARGUMENT KEYS.
 *
 * `check-command-parity.mjs` already finds these call sites, but only compares
 * command NAMES against `generate_handler!`. A call can name a registered
 * command and still send the wrong arguments entirely — `plugin_install` was
 * invoked with `{ source, installType, pluginDir }` against a Rust signature of
 * `(plugin_id, source, payload)`, so neither `pluginId` nor `payload` ever
 * crossed the wire. Every test covering that path mocks `invoke`, so the
 * mismatch was invisible for as long as it existed.
 *
 * This module supplies the missing half: the keys actually sent. Pairing them
 * with `parseTauriCommands` from `check-rpc-semantic-parity.mjs` turns a name
 * check into a shape check.
 *
 * Only statically-known object literals can be compared. `invoke(cmd, args)`
 * where `args` is a variable is reported as `opaque` and skipped — guessing
 * would produce noise, and the honest answer is that this call site cannot be
 * checked without a type checker.
 */

/** Command name plus, when knowable, the top-level keys of its argument object. */
const INVOKE_RE = /\binvoke\s*(?:<[^>()]*>)?\s*\(\s*(["'`])([A-Za-z_][A-Za-z0-9_]*)\1/g

/** Skip whitespace and comments starting at `index`. */
function skipTrivia(source, index) {
  let cursor = index
  for (;;) {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
    if (source.startsWith("//", cursor)) {
      const newline = source.indexOf("\n", cursor)
      cursor = newline === -1 ? source.length : newline + 1
      continue
    }
    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2)
      cursor = end === -1 ? source.length : end + 2
      continue
    }
    return cursor
  }
}

/**
 * Text of the balanced `{ … }` beginning at `start`, or null when unbalanced.
 * String- and comment-aware so a brace inside a literal does not unbalance it.
 */
export function extractBalancedBraces(source, start) {
  if (source[start] !== "{") return null
  let depth = 0
  let cursor = start
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === "/" && source[cursor + 1] === "/") {
      const newline = source.indexOf("\n", cursor)
      cursor = newline === -1 ? source.length : newline + 1
      continue
    }
    if (char === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2)
      cursor = end === -1 ? source.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      cursor += 1
      while (cursor < source.length && source[cursor] !== char) {
        cursor += source[cursor] === "\\" ? 2 : 1
      }
      cursor += 1
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start + 1, cursor)
    }
    cursor += 1
  }
  return null
}

/**
 * Top-level keys of an object-literal body. Nested objects, arrays, calls, and
 * strings are stepped over so only the outermost keys are reported.
 */
export function objectLiteralKeys(body) {
  const keys = []
  let hasSpread = false
  let hasComputed = false
  let depth = 0
  let cursor = 0
  let atEntryStart = true

  while (cursor < body.length) {
    const char = body[cursor]

    if (char === "/" && body[cursor + 1] === "/") {
      const newline = body.indexOf("\n", cursor)
      cursor = newline === -1 ? body.length : newline + 1
      continue
    }
    if (char === "/" && body[cursor + 1] === "*") {
      const end = body.indexOf("*/", cursor + 2)
      cursor = end === -1 ? body.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char
      const start = cursor + 1
      let end = start
      while (end < body.length && body[end] !== quote) {
        end += body[end] === "\\" ? 2 : 1
      }
      if (depth === 0 && atEntryStart) {
        // A quoted key: `"plugin-id": value`
        const after = skipTrivia(body, end + 1)
        if (body[after] === ":") {
          keys.push(body.slice(start, end))
          atEntryStart = false
        }
      }
      cursor = end + 1
      continue
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1
      cursor += 1
      continue
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1
      cursor += 1
      continue
    }
    if (depth === 0 && char === ",") {
      atEntryStart = true
      cursor += 1
      continue
    }
    if (depth === 0 && body.startsWith("...", cursor)) {
      hasSpread = true
      atEntryStart = false
      cursor += 3
      continue
    }
    if (depth === 0 && atEntryStart && /[A-Za-z_$]/.test(char)) {
      const match = body.slice(cursor).match(/^[A-Za-z_$][\w$]*/)
      const name = match[0]
      const after = skipTrivia(body, cursor + name.length)
      // `name:` is a key, `name,` / `name}` / `name` at the end is shorthand.
      if (body[after] === ":" || body[after] === "," || after >= body.length) {
        keys.push(name)
      }
      atEntryStart = false
      cursor += name.length
      continue
    }
    if (depth === 0 && char === "[") {
      hasComputed = true
    }
    if (!/\s/.test(char)) atEntryStart = atEntryStart && false
    cursor += 1
  }

  return { keys, hasSpread, hasComputed }
}

const lineNumberAt = (source, index) => source.slice(0, index).split("\n").length

/**
 * Every literal `invoke("name", …)` in one file.
 *
 * @param {string} source
 * @param {string} file repo-relative path, for reporting
 * @returns {Array<{command: string, file: string, line: number, kind: "object"|"opaque"|"none", keys: string[], hasSpread: boolean}>}
 */
export function findInvokeCallSites(source, file) {
  const sites = []
  INVOKE_RE.lastIndex = 0
  let match
  while ((match = INVOKE_RE.exec(source)) !== null) {
    const command = match[2]
    const line = lineNumberAt(source, match.index)
    // Position just past the closing quote of the command name.
    const afterName = match.index + match[0].length
    const afterTrivia = skipTrivia(source, afterName)

    if (source[afterTrivia] === ")") {
      sites.push({ command, file, line, kind: "none", keys: [], hasSpread: false })
      continue
    }
    if (source[afterTrivia] !== ",") {
      sites.push({ command, file, line, kind: "opaque", keys: [], hasSpread: false })
      continue
    }
    const argStart = skipTrivia(source, afterTrivia + 1)
    if (source[argStart] !== "{") {
      sites.push({ command, file, line, kind: "opaque", keys: [], hasSpread: false })
      continue
    }
    const body = extractBalancedBraces(source, argStart)
    if (body === null) {
      sites.push({ command, file, line, kind: "opaque", keys: [], hasSpread: false })
      continue
    }
    const { keys, hasSpread, hasComputed } = objectLiteralKeys(body)
    sites.push({
      command,
      file,
      line,
      // A spread or a computed key can contribute names we cannot see, so the
      // "missing argument" direction is unknowable — but the keys we DID read
      // are still real, so unknown-argument checking stays valid.
      kind: hasComputed ? "opaque" : "object",
      keys,
      hasSpread,
    })
  }
  return sites
}
