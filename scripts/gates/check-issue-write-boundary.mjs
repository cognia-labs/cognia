#!/usr/bin/env node
/**
 * Issue write-boundary gate (plan 2026-11-05 §6.3).
 *
 * Every write to the issue tracker goes through `lib/issues/service.ts` or
 * `lib/issues/bulk-actions.ts`, which validate what they are handed and do
 * the follow-up the write implies (the run lock, the GitHub refresh schedule
 * after a binding changes). Before the service took them over, eleven
 * components imported `createIssue`, `moveIssue`, `updateIssueProject` and
 * friends straight from `lib/db/issue*`, each with its own idea of what to
 * check and what to do afterwards — the project console unbound a synced
 * repository without retiring its refresh, and a phone could file an issue
 * with an assignee of a kind no board can draw.
 *
 * So nothing under `components/`, `app/` or `hooks/` may use a write from the
 * guarded modules. Reads stay open: a named import must look like a read
 * (`list*`, `get*`, `count*`, `find*`, `is*`, `has*`, `parse*`, `map*`), a
 * type, or a constant. A dynamic import of a guarded module is checked by
 * name instead: the file may not mention any of that module's writes. And a
 * surface may not write the issue tables through `getDb()` either.
 *
 * There is no baseline: the boundary holds today, and a new crossing fails.
 *
 * Usage: pnpm audit:issue-write-boundary
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "../..")

export const SCAN_ROOTS = ["components", "app", "hooks"]
const EXEMPT_SUFFIXES = [".test.ts", ".test.tsx", ".stories.tsx", ".d.ts"]

/** `lib/db/<module>` names the gate guards. */
export const GUARDED_MODULE = /^(issues|issue-[a-z-]+|github-issue-mirror(?:-types)?)$/

/** A named import that reads, is a type, or is a constant/class. */
export const READ_NAME = /^(list|get|count|find|is|has|parse|map)[A-Z0-9]/

/** A write to an issue table through the database handle. */
const TABLE_WRITE =
  /getDb\(\)\s*\.\s*(issues|issue[A-Z]\w*|githubIssue\w*)\s*\.\s*(add|bulkAdd|put|bulkPut|update|bulkUpdate|delete|bulkDelete|clear)\s*\(/g

const STATIC_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g
const NAMESPACE_IMPORT = /import\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/g
const DYNAMIC_IMPORT = /import\(\s*["']([^"']+)["']\s*\)/g

/** Is `name` allowed to cross the boundary? */
export function isReadName(name) {
  return READ_NAME.test(name) || /^[A-Z]/.test(name)
}

/**
 * The guarded module a specifier resolves to, or null. Handles the `@/` alias
 * and relative specifiers from `file` (repo-relative).
 */
export function guardedModuleOf(specifier, file) {
  let target
  if (specifier.startsWith("@/")) target = specifier.slice(2)
  else if (specifier.startsWith("."))
    target = relative(ROOT, resolve(ROOT, dirname(file), specifier))
  else return null
  const match = /^lib\/db\/([a-z-]+?)(?:\.tsx?)?$/.exec(target.replaceAll("\\", "/"))
  return match && GUARDED_MODULE.test(match[1]) ? match[1] : null
}

/** Exported function and const names of a module source that are not reads. */
export function writeExportsOf(source) {
  const names = new Set()
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function\*?|const|let)\s+([A-Za-z_$][\w$]*)/g
  )) {
    if (!isReadName(match[1])) names.add(match[1])
  }
  return names
}

/**
 * Violations in one file. `writesByModule` maps a guarded module to its write
 * exports, for the dynamic-import check.
 */
export function auditSource(file, source, writesByModule) {
  const violations = []
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const guarded = guardedModuleOf(match[3], file)
    if (!guarded || match[1]) continue
    for (const raw of match[2].split(",")) {
      const entry = raw.trim()
      if (!entry || entry.startsWith("type ")) continue
      const name = entry.split(/\s+as\s+/)[0].trim()
      if (!isReadName(name)) violations.push({ file, module: guarded, name, how: "import" })
    }
  }
  for (const match of source.matchAll(NAMESPACE_IMPORT)) {
    const guarded = guardedModuleOf(match[1], file)
    if (guarded) violations.push({ file, module: guarded, name: "*", how: "namespace import" })
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const guarded = guardedModuleOf(match[1], file)
    if (!guarded) continue
    for (const name of writesByModule.get(guarded) ?? []) {
      if (new RegExp(`\\b${name}\\b`).test(source)) {
        violations.push({ file, module: guarded, name, how: "dynamic import" })
      }
    }
  }
  for (const match of source.matchAll(TABLE_WRITE)) {
    violations.push({
      file,
      module: "schema",
      name: `${match[1]}.${match[2]}`,
      how: "getDb() write",
    })
  }
  // One entry per (module, name, how), in source order.
  const seen = new Set()
  return violations.filter((v) => {
    const key = `${v.module}:${v.name}:${v.how}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx)$/.test(entry) && !EXEMPT_SUFFIXES.some((s) => entry.endsWith(s))) {
      out.push(path)
    }
  }
  return out
}

/** Every guarded module's write exports, read from `lib/db/`. */
export function loadWritesByModule(root = ROOT) {
  const out = new Map()
  for (const entry of readdirSync(join(root, "lib/db"))) {
    const match = /^([a-z-]+)\.ts$/.exec(entry)
    if (!match || match[1].endsWith(".test") || !GUARDED_MODULE.test(match[1])) continue
    out.set(match[1], writeExportsOf(readFileSync(join(root, "lib/db", entry), "utf8")))
  }
  return out
}

export function collectViolations(root = ROOT) {
  const writesByModule = loadWritesByModule(root)
  const violations = []
  for (const scanRoot of SCAN_ROOTS) {
    const dir = join(root, scanRoot)
    let files
    try {
      files = walk(dir, [])
    } catch {
      continue
    }
    for (const path of files) {
      const file = relative(root, path).replaceAll("\\", "/")
      violations.push(...auditSource(file, readFileSync(path, "utf8"), writesByModule))
    }
  }
  return violations
}

function main() {
  const violations = collectViolations()
  if (violations.length === 0) {
    console.log("[issue-write-boundary] OK: no surface writes lib/db/issue* directly")
    return
  }
  console.error("[issue-write-boundary] surfaces must write issues through lib/issues/service.ts:")
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.how} of ${v.name} from lib/db/${v.module}`)
  }
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
