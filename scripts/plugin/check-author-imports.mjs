#!/usr/bin/env node

/**
 * Gate: plugin author code may import ONLY the roots `@cognia/plugin-sdk` and
 * `@cognia/plugin-ui`.
 *
 * ## Why root-only, and why subpaths are forbidden too
 *
 * A plugin bundle is built by `cognia plugin build` and evaluated in the
 * renderer realm. The host hands out its own already-evaluated instances for a
 * closed set of specifiers (`lib/plugin/core/shared-modules.ts`); everything
 * else the author writes is either bundled or refused. Two rules follow:
 *
 *   * **No `@/` alias.** Those resolve only inside this monorepo, so a plugin
 *     using one cannot be developed, typechecked, or built anywhere else — and
 *     `assertNoHostPrivateImports` refuses such a bundle at load time anyway.
 *   * **No `@cognia/plugin-{sdk,ui}` subpath.** The package still exports
 *     several (`./manifest`, `./context`, `./api/context-panel`, …) for host and
 *     tooling use, but five of them have no `jest.config.ts` moduleNameMapper
 *     and no root `tsconfig.json` path, so they do not resolve today at all. The
 *     author-facing contract is one root surface — the shape every comparable
 *     plugin API ships (VS Code, Figma, Obsidian, Zed are each a single root
 *     declaration). Holding authors to the root is what lets the subpaths be
 *     reorganised later without breaking a single plugin.
 *
 * ## Ratchet, not a cliff
 *
 * Same contract as `check-colocated-tests.mjs` and `check-rpc-semantic-parity.mjs`:
 * every finding that existed when this gate landed is recorded in
 * `author-imports-baseline.json` and THE LIST MAY ONLY SHRINK. A finding that
 * disappears is a win and the gate tells you to lock it in; a finding on a
 * file/specifier pair that is not in the baseline fails the build.
 *
 *   pnpm plugin:author-imports
 *   pnpm plugin:author-imports -- --write-baseline   # after paying debt down
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { extname, join, relative, resolve, dirname } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])

/** Scaffold templates. Author-facing by definition — walked from disk. */
const TEMPLATE_ROOTS = [
  "crates/cognia-plugin-template-ts",
  "crates/cognia-plugin-template-hybrid",
  "crates/cognia-plugin-template-vscode-extension",
]

/**
 * First-party plugins, enumerated from git rather than the filesystem so an
 * untracked local `dist/` or stray build artifact can never become a finding.
 */
const PLUGIN_ROOT = "plugins"

const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), "author-imports-baseline.json")

const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s*|import\s*\(|require\s*\(|import\s+(?=["']))\s*["']([^"']+)["']/g

/** Subpath of either author-facing package — the bare root is allowed. */
const SDK_SUBPATH_PATTERN = /^@cognia\/plugin-(?:sdk|ui)\/.+/

/**
 * Drop comments before scanning. A doc comment naming `@/lib/utils` is prose,
 * not an import — and `plugins/impeccable`, one of only two plugins already
 * root-only, has exactly that in its vendored `.d.ts`.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

export function findForbiddenAuthorImports(source) {
  const matches = []
  for (const match of stripComments(source).matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1]
    if (!specifier) continue
    if (specifier.startsWith("@/") || SDK_SUBPATH_PATTERN.test(specifier)) {
      matches.push(specifier)
    }
  }
  return matches
}

function templateFiles(root) {
  const files = []
  if (!existsSync(root)) return files
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...templateFiles(path))
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

function trackedPluginFiles(repoRoot) {
  const out = execFileSync("git", ["ls-files", "-z", PLUGIN_ROOT], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split("\0")
    .filter((file) => file && SOURCE_EXTENSIONS.has(extname(file)))
    .map((file) => resolve(repoRoot, file))
}

/** A finding is identified by file + specifier; repeats within one file collapse. */
export function findingKey(file, specifier) {
  return `${file} :: ${specifier}`
}

export function collectFindings(repoRoot = process.cwd()) {
  const files = [
    ...TEMPLATE_ROOTS.flatMap((root) => templateFiles(resolve(repoRoot, root))),
    ...trackedPluginFiles(repoRoot),
  ]
  const findings = new Set()
  for (const file of files) {
    for (const specifier of findForbiddenAuthorImports(readFileSync(file, "utf8"))) {
      findings.add(findingKey(relative(repoRoot, file), specifier))
    }
  }
  return [...findings].sort()
}

export function diffAgainstBaseline(findings, baseline) {
  const known = new Set(baseline)
  const current = new Set(findings)
  return {
    added: findings.filter((finding) => !known.has(finding)),
    removed: baseline.filter((finding) => !current.has(finding)),
  }
}

export function readBaseline(baselinePath = BASELINE_PATH) {
  if (!existsSync(baselinePath)) return []
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8"))
  return Array.isArray(parsed.findings) ? parsed.findings : []
}

function writeBaseline(findings) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        version: 1,
        note:
          "Plugin author code may import only the roots @cognia/plugin-sdk and " +
          "@cognia/plugin-ui. Every entry below is pre-existing debt recorded when the " +
          "gate landed. THIS LIST MAY ONLY SHRINK — `pnpm plugin:author-imports` fails " +
          "when a file/specifier pair appears that is not listed here. Regenerate with " +
          "`pnpm plugin:author-imports -- --write-baseline` only after paying debt down, " +
          "never to admit a new import.",
        findings,
      },
      null,
      2
    )}\n`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = collectFindings(process.cwd())

  if (process.argv.includes("--write-baseline")) {
    writeBaseline(findings)
    console.log(`[author-imports] baseline written: ${findings.length} findings`)
  } else {
    const { added, removed } = diffAgainstBaseline(findings, readBaseline())

    if (added.length > 0) {
      console.error(
        `[author-imports] ${added.length} NEW forbidden import(s). Plugin author code\n` +
          `may import only the roots "@cognia/plugin-sdk" and "@cognia/plugin-ui" —\n` +
          `no "@/" alias and no package subpath.\n`
      )
      for (const entry of added) console.error(`  ${entry}`)
      process.exitCode = 1
    } else if (removed.length > 0) {
      console.log(
        `[author-imports] ${removed.length} finding(s) paid down — lock it in with\n` +
          `  pnpm plugin:author-imports -- --write-baseline`
      )
      for (const entry of removed) console.log(`  - ${entry}`)
    } else {
      console.log(`[author-imports] no new forbidden imports (${findings.length} known findings).`)
    }
  }
}
