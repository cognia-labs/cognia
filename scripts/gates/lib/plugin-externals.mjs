/**
 * The plugin bundler externals contract, and every surface that restates it.
 *
 * A frontend plugin is bundled separately from the app and then evaluated in
 * the renderer realm, so a small closed set of specifiers must be left
 * unbundled for the host to supply. That set is written down FOUR times, in
 * three languages, and every copy has to agree:
 *
 *   1. `lib/plugin/core/shared-modules.ts` — `PLUGIN_SHARED_MODULES`, the
 *      modules the host actually hands out. Source of truth.
 *   2. `crates/cognia-cli/src/engine/frontend_build.rs` — `ESBUILD_EXTERNALS`,
 *      what `cognia plugin build` passes to esbuild. Must be (1) + `react-dom`.
 *   3. `crates/cognia-plugin-template-ts/package.json` — the build script a
 *      scaffolded author actually runs.
 *   4. `plugins/impeccable/build.mjs` — the reference distributable plugin,
 *      which calls esbuild's API directly with an `external` array.
 *
 * ## SDK subpaths travel as one wildcard
 *
 * Every published `@cognia/plugin-sdk/<subpath>` binds to the host's instance
 * (see `sdk-subpath-loaders.ts`), but esbuild matches import paths literally,
 * so the bare `@cognia/plugin-sdk` external does not cover them. The shared
 * set may name individual subpaths (`api/effort-surface` is listed because the
 * loader's exact-match check needs it); a bundler surface instead externalises
 * them all with the single `@cognia/plugin-sdk/*` wildcard. The expectation
 * below folds named subpaths into that wildcard before comparing.
 *
 * Drift is not cosmetic. A missing external is inlined into the bundle: a
 * second React carries its own hook dispatcher, so the plugin's components
 * throw `Invalid hook call` inside the host's tree. An extra external survives
 * into the bundle text as a bare specifier and `createPluginRequire` refuses it
 * at load. Both failures land on the author, far from the file that caused them.
 *
 * ## `react-dom` is where the two layers legitimately differ
 *
 * The host does not share `react-dom` — giving plugins `createPortal` would let
 * a slot contribution render anywhere in the document, escaping both its
 * extension slot and the `@scope`-d stylesheet that bounds it.
 *
 *   * The CLI DOES externalise it. `cognia plugin build` runs over a tree whose
 *     `node_modules` may well contain `react-dom` transitively; leaving it
 *     external means it is never bundled, so the author gets the loader's
 *     explicit "not available to plugins" error instead of a second reconciler
 *     quietly rendering into a detached tree.
 *   * The author build scripts do NOT, and `template.rs`'s
 *     `ts_template_uses_only_the_public_sdk` pins that. Those trees declare no
 *     `react-dom` dependency, so leaving it unlisted makes esbuild fail at
 *     BUILD time with "Could not resolve react-dom" — earlier and clearer than
 *     shipping a bundle that installs fine and dies on load.
 *
 * So the expectation is layered: the builder gets the shared set plus
 * `react-dom`; an author build script gets the shared set exactly.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

export const SHARED_MODULES_SOURCE = "lib/plugin/core/shared-modules.ts"
export const ESBUILD_EXTERNALS_SOURCE = "crates/cognia-cli/src/engine/frontend_build.rs"

/**
 * Externalised by the CLI builder without the host sharing it. Author build
 * scripts deliberately omit these so their own build fails early instead —
 * see the module docstring.
 */
export const BUILDER_ONLY_EXTERNALS = ["react-dom"]

export const SDK_SUBPATH_PREFIX = "@cognia/plugin-sdk/"
export const SDK_SUBPATH_WILDCARD = "@cognia/plugin-sdk/*"

/**
 * Build scripts that restate the contract. Keep in step with reality: the
 * hybrid and python templates have no `package.json` at all, and the
 * vscode-extension template has one with no `build` script — `noBuildScript`
 * pins that so adding one later has to come here first.
 */
export const BUILD_SCRIPT_SURFACES = [
  { path: "crates/cognia-plugin-template-ts/package.json" },
  { path: "plugins/impeccable/build.mjs", kind: "esbuild-api" },
]

export const NO_BUILD_SCRIPT_SURFACES = [
  { path: "crates/cognia-plugin-template-vscode-extension/package.json" },
]

export const NO_PACKAGE_JSON_SURFACES = [
  "crates/cognia-plugin-template-hybrid",
  "crates/cognia-plugin-template-python",
]

const read = (relativePath) => readFileSync(resolve(REPO_ROOT, relativePath), "utf8")

/** Blank out `//` line comments: the lists document entries inline. */
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
}

/** Entries of a TS/Rust/JS string-array literal, in declaration order. */
function parseStringArray(source, marker, label) {
  const afterMarker = source.split(marker)[1]
  if (afterMarker === undefined) {
    throw new Error(`${label}: "${marker}" not found — the parser is stale`)
  }
  const body = stripLineComments(afterMarker).split("]")[0]
  const entries = [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (entries.length === 0) {
    throw new Error(`${label}: parsed zero entries — the parser is stale`)
  }
  return entries
}

export function readSharedModules() {
  return parseStringArray(
    read(SHARED_MODULES_SOURCE),
    "PLUGIN_SHARED_MODULES = [",
    SHARED_MODULES_SOURCE
  )
}

export function readEsbuildExternals() {
  return parseStringArray(
    read(ESBUILD_EXTERNALS_SOURCE),
    "const ESBUILD_EXTERNALS: &[&str] = &[",
    ESBUILD_EXTERNALS_SOURCE
  )
}

/**
 * `--external:x` flags in a package.json build script, in order. A flag may be
 * wrapped in double quotes so a shell never globs the `*` of the SDK wildcard.
 */
export function readBuildScriptExternals(packageJsonPath) {
  const parsed = JSON.parse(read(packageJsonPath))
  const build = parsed.scripts?.build
  if (typeof build !== "string") {
    throw new Error(`${packageJsonPath}: no "build" script — the surface list is stale`)
  }
  return [...build.matchAll(/--external:([^\s"']+)/g)].map((match) => match[1])
}

/** The `external: [...]` array a build module passes to esbuild's `build()`. */
export function readEsbuildApiExternals(modulePath) {
  return parseStringArray(read(modulePath), "external: [", modulePath)
}

export function readSurfaceExternals({ path, kind }) {
  return kind === "esbuild-api" ? readEsbuildApiExternals(path) : readBuildScriptExternals(path)
}

/**
 * The shared set as a bundler must spell it: named SDK subpaths fold into the
 * one wildcard that externalises every subpath.
 */
export function bundlerExternalsFor(shared) {
  const subpaths = shared.some((entry) => entry.startsWith(SDK_SUBPATH_PREFIX))
  return [
    ...shared.filter((entry) => !entry.startsWith(SDK_SUBPATH_PREFIX)),
    ...(subpaths ? [SDK_SUBPATH_WILDCARD] : []),
  ]
}

export function hasBuildScript(packageJsonPath) {
  return typeof JSON.parse(read(packageJsonPath)).scripts?.build === "string"
}

/** What `cognia plugin build` must pass to esbuild: shared modules + builder-only. */
export function expectedBuilderExternals() {
  return [...bundlerExternalsFor(readSharedModules()), ...BUILDER_ONLY_EXTERNALS]
}

/** What an author's own build script must pass: the shared modules, exactly. */
export function expectedAuthorExternals() {
  return bundlerExternalsFor(readSharedModules())
}

const sorted = (values) => [...values].sort()
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))

function describeDiff(expected, actual) {
  const missing = expected.filter((entry) => !actual.includes(entry))
  const extra = actual.filter((entry) => !expected.includes(entry))
  return (
    (missing.length ? `\n    missing: ${missing.join(", ")}` : "") +
    (extra.length ? `\n    extra:   ${extra.join(", ")}` : "")
  )
}

/** Every disagreement across the four surfaces. Empty means the contract holds. */
export function findExternalsDrift() {
  const problems = []
  const shared = readSharedModules()

  const builderExpected = expectedBuilderExternals()
  const builder = readEsbuildExternals()
  if (!same(builder, builderExpected)) {
    problems.push(
      `${ESBUILD_EXTERNALS_SOURCE}: ESBUILD_EXTERNALS must equal PLUGIN_SHARED_MODULES ` +
        `plus ${BUILDER_ONLY_EXTERNALS.join(", ")} (SDK subpaths as ${SDK_SUBPATH_WILDCARD}).\n` +
        `    shared: ${shared.join(", ")}` +
        describeDiff(builderExpected, builder)
    )
  }

  const authorExpected = expectedAuthorExternals()
  for (const surface of BUILD_SCRIPT_SURFACES) {
    const { path } = surface
    const actual = readSurfaceExternals(surface)
    if (!same(actual, authorExpected)) {
      const extra = actual.filter((entry) => !authorExpected.includes(entry))
      const reactDomNote = extra.includes("react-dom")
        ? `\n    note: react-dom is externalised by the CLI but NOT by author build ` +
          `scripts — leaving it unlisted makes esbuild fail at build time instead of ` +
          `at load. See ts_template_uses_only_the_public_sdk in ` +
          `crates/cognia-cli/src/engine/template.rs.`
        : ""
      problems.push(
        `${path}: build script externals disagree with the shared-module set.` +
          describeDiff(authorExpected, actual) +
          reactDomNote
      )
    }
  }

  for (const { path } of NO_BUILD_SCRIPT_SURFACES) {
    if (hasBuildScript(path)) {
      problems.push(
        `${path}: gained a "build" script. Add it to BUILD_SCRIPT_SURFACES in ` +
          `scripts/gates/lib/plugin-externals.mjs so its externals are checked too.`
      )
    }
  }

  return problems
}
