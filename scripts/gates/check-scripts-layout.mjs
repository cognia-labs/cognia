#!/usr/bin/env node
/**
 * Keep `scripts/` navigable: a known set of folders, nothing loose at the top
 * level, and no script that nothing runs.
 *
 * The folder grew one subsystem at a time until it held 24 folders, eleven
 * loose top-level scripts and a few dozen files no command, workflow or import
 * reached (docs/plans/2026-11-04-scripts-layout-phase2.md). This gate holds the
 * consolidated layout:
 *
 *   1. Every tracked top-level file is listed in `topLevelFiles`.
 *   2. Every top-level folder is listed in `folders` and named in the README
 *      layout block; every listed folder still exists.
 *   3. Every script has a caller: a reference from a tracked file other than
 *      Markdown, historical records or its own co-located test. A
 *      `package.json` command, a workflow step, an import, a spawned path or a
 *      generated file's header all count. A script nothing calls is listed in
 *      `manual` with the reason it is run by hand; an entry that gains a caller
 *      or loses its file must leave the list.
 *
 * Config: scripts/gates/scripts-layout.json. Usage: pnpm audit:scripts-layout
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix } from "node:path"
import { fileURLToPath } from "node:url"

import { execaSync } from "execa"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const CONFIG_PATH = "scripts/gates/scripts-layout.json"
export const README_PATH = "scripts/README.md"

const SCRIPT_FILE = /\.(?:mjs|mts|cjs|js|ts|py|sh|ps1)$/
const TEST_FILE = /(?:\.test\.[cm]?[jt]sx?|\.test\.py|_test\.py)$/
const NOT_ENTRYPOINT = /(?:^|\/)(?:fixtures|__fixtures__)\/|\.d\.[cm]?ts$/
const JS_SOURCE = /\.(?:mjs|cjs|js|ts|tsx|mts|cts)$/
const RESOLVE_EXTENSIONS = ["", ".mjs", ".ts", ".mts", ".js", ".cjs", "/index.mjs", "/index.ts"]
/** Text that mentions scripts without calling them: prose, records, docs corpora. */
const NOT_A_CALLER =
  /\.(?:md|mdx)$|^docs\/(?:evidence|reports|plans|research)\/|\.generated\.json$|^i18n\/messages\//
const MAX_SOURCE_BYTES = 4 * 1024 * 1024

/** Script files that must be reachable: entry points and helpers, not tests or fixtures. */
export function isCheckedScript(path) {
  return (
    path.startsWith("scripts/") &&
    SCRIPT_FILE.test(path) &&
    !TEST_FILE.test(path) &&
    !NOT_ENTRYPOINT.test(path)
  )
}

/** A test that sits next to `script` and shares its stem exercises it, but does not call it. */
export function isOwnTest(source, script) {
  if (posix.dirname(source) !== posix.dirname(script)) return false
  const stem = posix.basename(script).replace(SCRIPT_FILE, "")
  const base = posix.basename(source)
  return TEST_FILE.test(base) && (base.startsWith(`${stem}.test.`) || base === `${stem}_test.py`)
}

function resolveCandidate(path, tracked) {
  for (const extension of RESOLVE_EXTENSIONS) {
    if (tracked.has(path + extension)) return path + extension
  }
  return null
}

/**
 * Every tracked path under `scripts/` that `text` (from `source`) points at.
 * Recognises repo-relative paths (`scripts/x`, `./scripts/x`, `@/scripts/x`,
 * `$ROOT/scripts/x`, regex-escaped `scripts\/x`), globs over them, relative
 * imports, and bare sibling file names inside `scripts/`. Globs are not calls.
 */
export function referencedScripts(source, text, tracked) {
  const found = new Set()
  const unescaped = text.replace(/\\([/.])/g, "$1")
  const pathPattern =
    /(?:(?<![\w.\-/$}])(?:\.{1,2}\/)*(?:@\/)?|(?:\$\{?\w+\}?|\}\})\/)scripts\/([\w.\-/*{},]+)/g
  for (const match of unescaped.matchAll(pathPattern)) {
    const token = `scripts/${match[1].replace(/[.,/]+$/, "")}`
    // A glob names a folder or a set of tests (a workflow path filter, a
    // `node --test dir/*.test.mjs` command, an editor or knip config); it
    // never calls one script.
    if (/[*{]/.test(token)) continue
    const resolved = resolveCandidate(token, tracked)
    if (resolved) found.add(resolved)
  }

  const sourceDir = posix.dirname(source)
  if (JS_SOURCE.test(source)) {
    const specifier =
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew URL\(\s*|\bimport\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/g
    for (const match of text.matchAll(specifier)) {
      const resolved = resolveCandidate(posix.normalize(posix.join(sourceDir, match[1])), tracked)
      if (resolved?.startsWith("scripts/")) found.add(resolved)
    }
  }

  if (source.startsWith("scripts/")) {
    const sibling = /["'`]((?:\.\/)?[\w.-]+\.(?:mjs|mts|cjs|js|ts|py|sh|ps1))["'`]/g
    for (const match of text.matchAll(sibling)) {
      const path = posix.join(sourceDir, match[1].replace(/^\.\//, ""))
      if (tracked.has(path)) found.add(path)
    }
  }

  found.delete(source)
  return found
}

/** The folder names listed in the README's fenced layout block. */
export function readmeLayoutFolders(readme) {
  const block = readme.match(/## Layout\s+```[^\n]*\n([\s\S]*?)```/)
  if (!block) return null
  return new Set([...block[1].matchAll(/^ {2}([\w.-]+)\/\s/gm)].map((match) => match[1]))
}

/**
 * @param {{
 *   tracked: string[],
 *   readText: (path: string) => string | null,
 *   config: { topLevelFiles: string[], folders: Record<string, string>, manual: Array<{ path: string, why: string }> },
 *   readme: string,
 * }} input
 */
export function auditScriptsLayout({ tracked, readText, config, readme }) {
  const problems = []
  const trackedSet = new Set(tracked)
  const scriptPaths = tracked.filter((path) => path.startsWith("scripts/"))

  const topLevelFiles = new Set(config.topLevelFiles)
  const folders = new Set(Object.keys(config.folders))
  const seenFolders = new Set()
  for (const path of scriptPaths) {
    const rest = path.slice("scripts/".length)
    if (!rest.includes("/")) {
      if (!topLevelFiles.has(rest)) {
        problems.push(
          `${path}: loose top-level file; move it into the folder for what it does (see ${README_PATH})`
        )
      }
      continue
    }
    const folder = rest.split("/")[0]
    seenFolders.add(folder)
    if (!folders.has(folder)) {
      problems.push(
        `scripts/${folder}/: folder is not in ${CONFIG_PATH} "folders"; use an existing folder, or register it with its purpose and add it to the README layout`
      )
      folders.add(folder)
    }
  }
  for (const file of topLevelFiles) {
    if (!trackedSet.has(`scripts/${file}`)) {
      problems.push(`${CONFIG_PATH}: topLevelFiles lists missing scripts/${file}`)
    }
  }
  const readmeFolders = readmeLayoutFolders(readme)
  if (!readmeFolders) problems.push(`${README_PATH}: no "## Layout" code block`)
  for (const folder of Object.keys(config.folders)) {
    if (!seenFolders.has(folder)) {
      problems.push(`${CONFIG_PATH}: folders lists scripts/${folder}/, which has no tracked files`)
    } else if (readmeFolders && !readmeFolders.has(folder)) {
      problems.push(`${README_PATH}: layout block does not list ${folder}/`)
    }
  }

  const callers = new Map()
  for (const source of tracked) {
    // The config names its manual entries; that is the registration, not a call.
    if (NOT_A_CALLER.test(source) || source === CONFIG_PATH) continue
    const text = readText(source)
    if (text === null) continue
    if (!source.startsWith("scripts/") && !text.includes("scripts")) continue
    for (const target of referencedScripts(source, text, trackedSet)) {
      if (isOwnTest(source, target)) continue
      if (!callers.has(target)) callers.set(target, new Set())
      callers.get(target).add(source)
    }
  }

  const manual = new Map()
  for (const entry of config.manual) {
    if (manual.has(entry.path)) problems.push(`${CONFIG_PATH}: manual lists ${entry.path} twice`)
    manual.set(entry.path, entry)
    if (!entry.why?.trim()) problems.push(`${CONFIG_PATH}: manual entry ${entry.path} has no "why"`)
    if (!trackedSet.has(entry.path)) {
      problems.push(`${CONFIG_PATH}: manual lists missing ${entry.path}; remove the entry`)
    } else if (callers.has(entry.path)) {
      const by = [...callers.get(entry.path)].sort()[0]
      problems.push(
        `${CONFIG_PATH}: manual lists ${entry.path}, but ${by} now calls it; remove the entry`
      )
    }
  }

  for (const path of scriptPaths) {
    if (!isCheckedScript(path) || callers.has(path) || manual.has(path)) continue
    problems.push(
      `${path}: nothing runs it; give it a package.json command, call it from another script, list it under "manual" in ${CONFIG_PATH} with why, or delete it`
    )
  }

  return { problems, checked: scriptPaths.filter(isCheckedScript).length, manual: manual.size }
}

/** Tracked files still present in the working tree (a pending deletion is gone). */
function readTracked() {
  return execaSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .stdout.split("\0")
    .filter((path) => path && existsSync(join(REPO_ROOT, path)))
}

function readTextFile(path) {
  const absolute = join(REPO_ROOT, path)
  try {
    if (statSync(absolute).size > MAX_SOURCE_BYTES) return null
    const text = readFileSync(absolute, "utf8")
    return text.includes("\0") ? null : text
  } catch {
    // Tracked but deleted in the working tree: it calls nothing.
    return null
  }
}

function main() {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, CONFIG_PATH), "utf8"))
  const readme = readFileSync(join(REPO_ROOT, README_PATH), "utf8")
  const { problems, checked, manual } = auditScriptsLayout({
    tracked: readTracked(),
    readText: readTextFile,
    config,
    readme,
  })
  if (problems.length) {
    console.error(`[scripts-layout] ${problems.length} problem(s):`)
    for (const problem of problems.sort()) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(
    `[scripts-layout] OK: ${Object.keys(config.folders).length} folders, ${checked} scripts have a caller or a manual entry (${manual} run by hand).`
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
