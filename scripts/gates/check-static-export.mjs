#!/usr/bin/env node
/**
 * CI gate: no Node-only imports in code that enters the static-export bundle.
 *
 * The app is a Next.js static export (`output: "export"`) consumed by Tauri
 * AND Capacitor — `app/api/` does not exist at runtime and Node built-ins are
 * fatal to the client bundle (next.config.ts merely stubs them out for
 * third-party deps, which silently no-ops first-party misuse instead of
 * failing the build). This gate makes the constraint deterministic.
 *
 * Deny set:
 *   - `NODE_ONLY_MODULES` parsed live out of next.config.ts (never drifts;
 *     the gate hard-errors if the marker disappears),
 *   - every Node built-in from `node:module`'s builtinModules (bare and
 *     `node:`-prefixed forms),
 *   - a small server-SDK denylist (SERVER_SDK_DENY below).
 *
 * Exemptions:
 *   - `import type … from "x"` is exempt automatically (erased at emit),
 *   - inline `// static-export-exempt: <reason>` on the import's first line
 *     or the line directly above it (a bare marker without a reason fails),
 *   - scripts/gates/static-export-allowlist.json entries `{file, module,
 *     reason}` for whole-file/module pairs (stale entries are warnings so the
 *     list self-cleans). `nodeOnly: true` additionally fences the file from
 *     runtime imports by other scanned sources, resolving relative paths and
 *     the repository's tsconfig aliases. Only fenced Node files may import it.
 *
 * Scope: .ts/.tsx under app/ components/ hooks/ stores/ lib/ packages/ (tracked and non-ignored new sources),
 * excluding tests/stories/mocks. `.mjs` hook scripts (hooks/builtin/) run
 * under Node by design and are naturally out of scope.
 *
 * Usage:
 *   node scripts/gates/check-static-export.mjs
 */

import { readFileSync, realpathSync, existsSync } from "node:fs"
import { resolve, dirname, relative, posix } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { builtinModules } from "node:module"
import { parse } from "jsonc-parser"
import ts from "typescript"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, "../..")
const NEXT_CONFIG = resolve(REPO_ROOT, "next.config.ts")
const ALLOWLIST_PATH = resolve(__dirname, "static-export-allowlist.json")
const SEARCH_DIRS = ["app", "components", "hooks", "stores", "lib", "packages"]

// Server-only npm packages that must never be imported from bundled code.
const SERVER_SDK_DENY = ["@modelcontextprotocol/sdk/server"]

const EXEMPT_RE = /\/\/\s*static-export-exempt:(.*)$/

/** Parse the NODE_ONLY_MODULES array out of next.config.ts. Hard-errors if absent. */
export function parseNodeOnlyModules(configSrc) {
  const m = configSrc.match(/const NODE_ONLY_MODULES\s*=\s*\[([\s\S]*?)\]/)
  if (!m) {
    throw new Error(
      "Could not locate `const NODE_ONLY_MODULES = [...]` in next.config.ts — " +
        "the gate's source assumptions are stale."
    )
  }
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
}

/** Full deny set: NODE_ONLY_MODULES ∪ all Node built-ins (both forms) ∪ server SDKs. */
export function buildDenySet(configSrc) {
  const deny = new Set(parseNodeOnlyModules(configSrc))
  for (const mod of builtinModules) {
    deny.add(mod)
    deny.add(`node:${mod}`)
  }
  for (const sdk of SERVER_SDK_DENY) deny.add(sdk)
  return deny
}

/**
 * Extract module specifiers from one source file. Returns
 * [{ module, line, typeOnly }]. Covers static import / export-from /
 * require() / dynamic import(). Multi-line statements anchor to the line
 * where the statement starts.
 */
export function extractImports(src, filename = "source.ts") {
  const source = ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, false)
  const found = []
  const staticString = (node) => {
    if (!node) return undefined
    if (ts.isStringLiteralLike(node)) return node.text
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return staticString(node.expression)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticString(node.left)
      const right = staticString(node.right)
      if (left !== undefined && right !== undefined) return left + right
    }
    return undefined
  }
  const push = (node, expression, typeOnly = false) => {
    const specifier = staticString(expression)
    if (specifier === undefined) return
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    found.push({ module: specifier, line: line + 1, typeOnly })
  }
  const namedTypesOnly = (bindings) =>
    bindings && bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly)
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      push(
        node,
        node.moduleSpecifier,
        Boolean(
          clause?.isTypeOnly ||
          (!clause?.name && bindings && ts.isNamedImports(bindings) && namedTypesOnly(bindings))
        )
      )
    } else if (ts.isExportDeclaration(node)) {
      const bindings = node.exportClause
      push(
        node,
        node.moduleSpecifier,
        Boolean(
          node.isTypeOnly || (bindings && ts.isNamedExports(bindings) && namedTypesOnly(bindings))
        )
      )
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      push(node, node.moduleReference.expression, node.isTypeOnly)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      push(node, node.argument.literal, true)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      push(node, node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // Dedupe identical (module, line, typeOnly) triples — e.g.
  // `(await import("x")) as typeof import("x")` yields one value + one type hit.
  const seen = new Set()
  return found.filter((f) => {
    const key = `${f.module}\0${f.line}\0${f.typeOnly}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function denyMatch(deny, module) {
  if (deny.has(module)) return true
  // Subpath of a denied package (e.g. @modelcontextprotocol/sdk/server/stdio).
  for (const entry of deny) {
    if (module.startsWith(`${entry}/`)) return true
  }
  return false
}

/**
 * Scan one file. Returns { violations, badExempts } where each entry is
 * { file, line, module }.
 */
export function scanSource(relPath, src, deny, allowlist, imports = extractImports(src, relPath)) {
  const violations = []
  const badExempts = []
  const lines = src.split("\n")

  const exemptState = (lineIdx) => {
    for (const idx of [lineIdx, lineIdx - 1]) {
      if (idx < 0) continue
      const m = lines[idx].match(EXEMPT_RE)
      if (m) return m[1].trim() === "" ? "bare" : "valid"
    }
    return "none"
  }

  for (const imp of imports) {
    if (imp.typeOnly) continue
    if (!denyMatch(deny, imp.module)) continue
    if (allowlist.some((a) => a.file === relPath && a.module === imp.module)) continue
    const exempt = exemptState(imp.line - 1)
    if (exempt === "valid") continue
    const entry = { file: relPath, line: imp.line, module: imp.module }
    if (exempt === "bare") badExempts.push(entry)
    else violations.push(entry)
  }
  return { violations, badExempts }
}

export async function listSourceFiles(repoRoot = REPO_ROOT) {
  const child = spawn(
    "git",
    [
      "-C",
      repoRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...SEARCH_DIRS,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`git ls-files failed (${signal ?? code})`))
    })
  })
  // Drain stderr without retaining arbitrary diagnostics. Git failures still
  // fail the gate; source paths never pass through a shell or a fixed buffer.
  child.stderr.resume()
  const paths = []
  let pending = ""
  child.stdout.setEncoding("utf8")
  await Promise.all([
    completion,
    (async () => {
      for await (const chunk of child.stdout) {
        const entries = (pending + chunk).split("\0")
        pending = entries.pop()
        paths.push(...entries)
      }
      if (pending) throw new Error("git ls-files returned an incomplete path")
    })(),
  ])
  return paths
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
    .filter((p) => existsSync(resolve(repoRoot, p)))
    .filter(
      (p) =>
        !/\.(test|stories)\.tsx?$/.test(p) && !p.includes("__tests__/") && !p.includes("__mocks__/")
    )
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return []
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))
  if (!Array.isArray(parsed)) {
    throw new Error("static-export-allowlist.json must be a JSON array of {file, module, reason}")
  }
  for (const entry of parsed) {
    if (
      typeof entry?.file !== "string" ||
      typeof entry.module !== "string" ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      (entry.nodeOnly !== undefined && typeof entry.nodeOnly !== "boolean")
    )
      throw new Error(
        "Invalid static-export allowlist entry; file, module, reason and optional boolean nodeOnly are required"
      )
  }
  return parsed
}

/** Resolve repository source aliases before enforcing the standalone Node fence. */
function loadSourcePaths() {
  const file = resolve(REPO_ROOT, "tsconfig.json")
  if (!existsSync(file)) return { baseUrl: REPO_ROOT, paths: [] }
  const errors = []
  const config = parse(readFileSync(file, "utf8"), errors, { allowTrailingComma: true })
  if (errors.length)
    throw new Error("Cannot read tsconfig.json aliases for the static-export boundary")
  const options = config?.compilerOptions ?? {}
  return {
    baseUrl: resolve(REPO_ROOT, options.baseUrl ?? "."),
    paths: Object.entries(options.paths ?? {}).sort(([a], [b]) => {
      const specificity = (key) => (key.includes("*") ? key.indexOf("*") : Number.MAX_SAFE_INTEGER)
      return specificity(b) - specificity(a) || b.length - a.length
    }),
  }
}

function standaloneTarget(importer, specifier, nodeOnlyFiles, sourcePaths) {
  let targets = []
  if (specifier.startsWith(".")) {
    targets = [posix.normalize(posix.join(posix.dirname(importer), specifier))]
  } else {
    for (const [pattern, paths] of sourcePaths.paths) {
      const star = pattern.indexOf("*")
      const prefix = star < 0 ? pattern : pattern.slice(0, star)
      const suffix = star < 0 ? "" : pattern.slice(star + 1)
      if (
        star < 0
          ? specifier !== pattern
          : specifier.length < prefix.length + suffix.length ||
            !specifier.startsWith(prefix) ||
            !specifier.endsWith(suffix)
      )
        continue
      const match = star < 0 ? "" : specifier.slice(prefix.length, specifier.length - suffix.length)
      targets = paths.map((target) =>
        relative(
          REPO_ROOT,
          resolve(
            sourcePaths.baseUrl,
            target.replaceAll("*", () => match)
          )
        ).replaceAll("\\", "/")
      )
      break
    }
  }
  for (const target of targets) {
    const stem = target.replace(/\.[cm]?jsx?$/, "")
    const found = [
      target,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}/index.ts`,
      `${stem}/index.tsx`,
    ].find((candidate) => nodeOnlyFiles.has(candidate))
    if (found) return found
  }
  return undefined
}

async function main() {
  const deny = buildDenySet(readFileSync(NEXT_CONFIG, "utf8"))
  const allowlist = loadAllowlist()
  const files = await listSourceFiles()
  const nodeOnlyFiles = new Set(
    allowlist.filter((entry) => entry.nodeOnly).map((entry) => entry.file)
  )
  const sourcePaths = loadSourcePaths()

  const violations = []
  const badExempts = []
  const nodeBoundaryViolations = []
  const usedAllowlist = new Set()

  for (const rel of files) {
    const src = readFileSync(resolve(REPO_ROOT, rel), "utf8")
    const imports = extractImports(src, rel)
    // Track which allowlist entries actually matched so stale ones warn.
    for (const imp of imports) {
      if (imp.typeOnly) continue
      if (!nodeOnlyFiles.has(rel)) {
        const target = standaloneTarget(rel, imp.module, nodeOnlyFiles, sourcePaths)
        if (target) nodeBoundaryViolations.push({ file: rel, ...imp, target })
      }
      if (!denyMatch(deny, imp.module)) continue
      const hit = allowlist.findIndex((a) => a.file === rel && a.module === imp.module)
      if (hit >= 0) usedAllowlist.add(hit)
    }
    const result = scanSource(rel, src, deny, allowlist, imports)
    violations.push(...result.violations)
    badExempts.push(...result.badExempts)
  }

  const stale = allowlist.filter((_, i) => !usedAllowlist.has(i))
  if (stale.length > 0) {
    console.warn(
      `[static-export] WARNING: ${stale.length} stale allowlist entr(y/ies) no longer match — ` +
        `remove from scripts/gates/static-export-allowlist.json:`
    )
    for (const s of stale) console.warn(`  ${s.file} → ${s.module}`)
  }

  if (violations.length === 0 && badExempts.length === 0 && nodeBoundaryViolations.length === 0) {
    console.log(
      `[static-export] OK: ${files.length} TS files audited, ` +
        `${allowlist.length - stale.length} allowlisted import(s), no Node-only imports in the bundle; ` +
        `${nodeOnlyFiles.size} standalone Node source(s) fenced.`
    )
    return 0
  }

  if (violations.length > 0) {
    console.error(
      `[static-export] ${violations.length} Node-only import(s) in static-export bundle code:\n`
    )
    for (const v of violations) {
      console.error(
        `  ${v.file}:${v.line}  imports "${v.module}" (node-only in a static-export bundle)`
      )
    }
    console.error(
      `\n  Move the code behind a Tauri command / sidecar, add an allowlist entry with a\n` +
        `  reason, or append \`// static-export-exempt: <reason>\` on the line (or above).\n`
    )
  }

  if (badExempts.length > 0) {
    console.error(
      `[static-export] ${badExempts.length} exempt marker(s) without a reason ` +
        `(a bare marker is not an exemption):\n`
    )
    for (const v of badExempts) console.error(`  ${v.file}:${v.line}  "${v.module}"`)
    console.error("")
  }

  for (const entry of nodeBoundaryViolations)
    console.error(
      `  ${entry.file}:${entry.line} imports standalone Node module "${entry.module}" (${entry.target})`
    )

  console.error(
    `[static-export] ${violations.length + badExempts.length + nodeBoundaryViolations.length} issue(s).`
  )
  return 1
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isDirectRun) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`[static-export] ${error.message}`)
      process.exitCode = 1
    }
  )
}
