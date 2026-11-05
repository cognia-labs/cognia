#!/usr/bin/env node
/**
 * Module gate (ADR-0250 §14): who owns each file, which way dependencies
 * point, and how big the shared sinks are allowed to get.
 *
 * Every non-test source file under app/, components/, hooks/, lib/, stores/
 * and types/ belongs to exactly one subsystem (`scripts/gates/lib/subsystems.mjs`
 * names them), and every subsystem is in exactly one class: foundation,
 * kernel, shell or module. A kernel member's app/components/hooks files are its
 * UI module. Ownership comes from a module's manifest (`lib/<id>/module.ts`)
 * or, until it has one, from the transitional table
 * `scripts/gates/module-ownership.json`. Packages, plugins, the CLI and Rust
 * keep their own boundary gates and are not covered here.
 *
 *   G1 ownership   every file resolves to one known owner; a subsystem is in the
 *                  table or has a manifest, never both; manifests are data
 *                  only and name CODEOWNERS handles. Blocking. The table's row
 *                  count is a ratchet (scripts/gates/baseline-growth.json).
 *   G2 direction   value imports from foundation to anything above it, from
 *                  the kernel to a module or the shell, and from a module to
 *                  the shell. Blocking since phase M1 (ADR-0250 §13): an edge
 *                  missing from the baseline fails. A shell's contribution kit
 *                  (the settings section parts, the search provider helpers)
 *                  is listed as that shell's `api` in the ownership table, and
 *                  importing it is not an edge. The generated registries are
 *                  the sanctioned inversion and are not source files here.
 *   G3 public API  an import between two modules where either has a manifest
 *                  reaches only a file the target lists as `api` (its
 *                  manifest's, or its table row's), or `types/**`. An `api`
 *                  file is never a barrel. Existing violations are baselined
 *                  (fingerprint `file -> target`); a new one fails. Imports
 *                  among subsystems still in the table join as each gains a
 *                  manifest.
 *   G4 declared    a manifest's `dependsOn` names exactly the modules its files
 *      = actual    import (types/** aside), its `tables` exist and are
 *                  accessed by its files and claimed by no other module, and
 *                  its `settings.keys` are `SettingsState` members its files
 *                  read and no other module claims. Blocking, 0 mismatches.
 *                  The runtime clauses (brain adapters, runtime-initializers)
 *                  apply once manifests carry `runtimes` and `effects` (M2).
 *   G5 generation  manifests are data only, their lazy entries resolve, and
 *                  `lib/modules/generated/host.ts` and
 *                  `components/modules/generated/ui.ts` equal what
 *                  scripts/build/gen-module-registry.mjs writes, so nothing is
 *                  hand-added to them. Since M1, for settings sections, search
 *                  providers and slash commands.
 *   G6 cycles      `dependsOn` across manifests is acyclic (blocking), and the
 *                  largest strongly connected component of the lib/ owner
 *                  graph may only shrink.
 *   G7 size        module count, experimental modules, Dexie tables,
 *                  `SettingsState` members, settings-store importers and the
 *                  files the generated registries load eagerly may only shrink.
 *   G8 vendors     framework directories (IM connectors, cloud documents,
 *                  issue sync, backup, scheduling) name no vendor and import
 *                  no vendor implementation. Existing violations are
 *                  baselined; a new one fails.
 *
 * Usage:
 *   node scripts/gates/check-modules.mjs                    # check
 *   node scripts/gates/check-modules.mjs --write-baseline   # after paying a measure down
 *   node scripts/gates/check-modules.mjs --json             # machine-readable report
 *   node scripts/gates/check-modules.mjs --root <fixture>   # run against another tree
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import { createContext, importsIn, resolveModule } from "./convergence/counter.mjs"
import {
  GENERATED_FILES,
  GENERATOR,
  lazyEntries,
  manifestKind,
  readManifest,
  renderRegistries,
  unwrap,
  validateHostManifest,
  validateUiManifest,
} from "./lib/module-manifests.mjs"
import { createSubsystemClassifier, LAYERED_ROOTS } from "./lib/subsystems.mjs"

export {
  DEFINE_MODULE,
  HOST_FIELDS,
  SETTINGS_SECTION_FIELDS,
  SLASH_COMMAND_FIELDS,
  UI_FIELDS,
  readManifest,
  validateHostManifest,
  validateUiManifest,
} from "./lib/module-manifests.mjs"

export const OWNERSHIP_FILE = "scripts/gates/module-ownership.json"
export const BASELINE_FILE = "scripts/gates/modules-baseline.json"
export const CODEOWNERS_FILE = ".github/CODEOWNERS"
export const SETTINGS_STORE_FILE = "stores/settings/settings-store.ts"
export const SETTINGS_STORE_ENTRIES = ["stores/settings/index.ts", SETTINGS_STORE_FILE]
export const TABLE_CATALOG_FILE = "lib/data-governance/table-catalog.ts"
/** The Lucide catalog's names, which a settings section's `icon` must be one of. */
export const LUCIDE_NAMES_FILE =
  "packages/plugin-contract/src/lib/icons/lucide-icon-names.generated.json"
/** `MOBILE_SPOT_ICON_NAMES`, which a nav entry's `mobileShortcut.spotIcon` must be one of. */
export const SPOT_ICON_FILE = "components/mobile/mobile-spot-icon.tsx"
/** `CANONICAL_EXTENSION_POINTS`, which a UI manifest's `slots` keys must be. */
export const EXTENSION_POINTS_FILE =
  "packages/plugin-contract/src/lib/plugin/contracts/plugin-points.ts"

export const CLASSES = ["foundation", "kernel", "module", "shell"]
const RANK = { foundation: 0, kernel: 1, module: 2, shell: 3 }
const UI_LAYERS = new Set(["app", "components", "hooks"])

/**
 * Framework directories that must stay vendor-neutral (G8), each with the
 * directories where its vendor implementations belong. Files under an
 * implementation directory are not framework code.
 */
// A catalog is the one list of implementations a framework reads (beside the
// implementations, `_`-prefixed so the framework may import it). It may import
// framework files and each implementation's `entry` file, nothing else, so it
// stays a list and never becomes a way around G8.
export const VENDOR_FRAMEWORKS = [
  {
    path: "lib/connectors/",
    implementations: ["lib/connectors/adapters/"],
    catalogs: [{ file: "lib/connectors/adapters/_vendors.ts", entry: "contribution.ts" }],
  },
  {
    path: "lib/docs-providers/",
    implementations: ["lib/docs-providers/providers/"],
    catalogs: [
      { file: "lib/docs-providers/providers/_builtin.ts", entry: "index.ts" },
      { file: "lib/docs-providers/providers/_document-urls.ts", entry: "document-url.ts" },
    ],
  },
  { path: "lib/issues/sync/", implementations: ["lib/issues/sync/providers/"] },
  { path: "lib/data/", implementations: ["lib/data/destinations/"] },
  { path: "lib/scheduler/", implementations: [] },
]
export const VENDORS = [
  "lark",
  "feishu",
  "dingtalk",
  "discord",
  "slack",
  "telegram",
  "wechat",
  "wecom",
  "qq",
  "onebot",
  "matrix",
  "google",
  "gdrive",
  "github",
  "gitlab",
  "notion",
]
// "matrix" is also an ordinary word (permission matrix, adapter matrix), so it
// counts only as a compared literal or an implementation-directory import.
const PATH_VENDORS = VENDORS.filter((vendor) => vendor !== "matrix")
const VENDOR_SEGMENT = new RegExp(`(?:^|[/._-])(${PATH_VENDORS.join("|")})(?:[/._-]|$)`, "i")
const VENDOR_LITERAL = new RegExp(`^(${VENDORS.join("|")})(?:[-_:.].*)?$`, "i")

const sorted = (values) => [...new Set(values)].sort()

// ------------------------------------------------------------- manifests

/** `@handle` tokens CODEOWNERS assigns anywhere. */
export function codeownerHandles(text) {
  const handles = new Set()
  for (const line of text.split("\n")) {
    const content = line.replace(/#.*/, "").trim()
    if (!content) continue
    for (const token of content.split(/\s+/).slice(1)) if (token.startsWith("@")) handles.add(token)
  }
  return handles
}

function collectManifests(ctx, files) {
  const errors = []
  const warnings = []
  const host = new Map()
  const ui = new Map()
  const handles = ctx.exists(CODEOWNERS_FILE)
    ? codeownerHandles(ctx.read(CODEOWNERS_FILE))
    : new Set()
  const vocabulary = {
    iconNames: ctx.exists(LUCIDE_NAMES_FILE)
      ? new Set(JSON.parse(ctx.read(LUCIDE_NAMES_FILE)).iconNames)
      : undefined,
    spotIconNames: constStringList(ctx, SPOT_ICON_FILE, "MOBILE_SPOT_ICON_NAMES"),
    extensionPoints: constStringList(ctx, EXTENSION_POINTS_FILE, "CANONICAL_EXTENSION_POINTS"),
  }
  for (const file of files) {
    const kind = manifestKind(file)
    if (!kind) continue
    const { id, helper } = kind
    const hostMatch = kind.layer === "host"
    const { value, errors: readErrors } = readManifest(ctx, file, helper)
    const shapeErrors =
      value === undefined
        ? []
        : hostMatch
          ? validateHostManifest(value, id, vocabulary)
          : validateUiManifest(value, id, vocabulary)
    const lazyErrors = lazyEntries(value)
      .filter(({ spec }) => !resolveModule(ctx, spec, file))
      .map(({ at, spec }) => `${at}: lazy entry "${spec}" does not resolve`)
    for (const message of [...readErrors, ...shapeErrors, ...lazyErrors])
      errors.push(`${file}: ${message}`)
    if (!value) continue
    if (hostMatch) {
      if (value.owner && !handles.has(value.owner))
        errors.push(`${file}: owner ${value.owner} is not a handle in ${CODEOWNERS_FILE}`)
      for (const api of value.api ?? [])
        if (!ctx.exists(api)) errors.push(`${file}: api file ${api} does not exist`)
      if (
        value.stage === "stable" &&
        !String(value.acceptance?.realSmoke ?? "").startsWith("passed:")
      )
        warnings.push(`${file}: stable module "${id}" has no passed real smoke yet`)
      host.set(id, { file, manifest: value })
    } else ui.set(id, { file, manifest: value })
  }
  for (const [id, { file }] of ui)
    if (!host.has(id)) errors.push(`${file}: no host manifest lib/${id}/module.ts declares "${id}"`)
  errors.push(
    ...duplicateContributions(
      host,
      (manifest) => manifest.slashCommands,
      "name",
      "slash command /"
    ),
    ...duplicateContributions(
      ui,
      (manifest) => manifest.settingsSections,
      "id",
      "settings section "
    ),
    ...duplicateContributions(host, (manifest) => manifest.nav, "id", "navigation entry ")
  )
  return { host, ui, errors, warnings }
}

/**
 * The string literals of `export const <name> = [ … ]` in `file`, or undefined
 * when the file or the list is absent (a fixture tree). Comments between the
 * entries are skipped; anything else that is not a string literal is not a list
 * this can read.
 */
export function constStringList(ctx, file, name) {
  if (!ctx.exists(file)) return undefined
  const sourceFile = ctx.ast(file)
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const list = declaration.initializer && unwrap(declaration.initializer)
      if (!list || !ts.isArrayLiteralExpression(list)) return undefined
      const names = list.elements.map((element) =>
        ts.isStringLiteralLike(element) ? element.text : null
      )
      return names.includes(null) ? undefined : new Set(names)
    }
  }
  return undefined
}

/** Two modules contributing the same slash command, section or nav id would shadow each other. */
function duplicateContributions(manifests, list, key, label) {
  const errors = []
  const seen = new Map()
  for (const [id, { file, manifest }] of manifests)
    for (const entry of Array.isArray(list(manifest)) ? list(manifest) : []) {
      const name = entry?.[key]
      if (typeof name !== "string") continue
      const first = seen.get(name)
      if (first && first !== id)
        errors.push(`${file}: ${label}${name} is also contributed by "${first}"`)
      else seen.set(name, id)
    }
  return errors
}

/**
 * G5: the generated registries on disk equal what the generator writes from
 * these manifests. A tree without `lib/modules/define.ts` (a fixture, a partial
 * checkout) has no registries to check, the generator's own rule.
 */
export function registryErrors(ctx, manifests) {
  if (!ctx.exists("lib/modules/define.ts")) return []
  const entries = (map) => [...map].map(([id, { file }]) => ({ id, file }))
  const expected = renderRegistries({ host: entries(manifests.host), ui: entries(manifests.ui) })
  const errors = []
  for (const [file, content] of Object.entries(expected)) {
    if (!ctx.exists(file)) errors.push(`${file} is missing — run node ${GENERATOR}`)
    else if (ctx.read(file) !== content)
      errors.push(
        `${file} differs from what ${GENERATOR} writes — it is generated, never edited; rerun it`
      )
  }
  return errors
}

/**
 * G7: files a host loads when it imports the generated registries, besides
 * the manifests themselves: what the manifests import eagerly. Lazy entries and
 * type imports do not count; a manifest is data, so this should stay at
 * `lib/modules/define.ts` however many modules there are. (Counting the
 * manifests too would make every new module look like growth.)
 */
export function registryEagerFiles(ctx, manifests) {
  const seen = new Set()
  const roots = [...manifests.host.values(), ...manifests.ui.values()].map(({ file }) => file)
  const queue = [...roots]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file) || !ctx.exists(file)) continue
    seen.add(file)
    for (const record of importsIn(ctx, file)) {
      if (record.typeOnly || record.kind !== "static") continue
      const target = resolveModule(ctx, record.spec, file)
      if (target && !seen.has(target)) queue.push(target)
    }
  }
  const manifestFiles = new Set(roots)
  return [...seen].filter((file) => !manifestFiles.has(file)).length
}

// ------------------------------------------------------------- ownership

/**
 * Owners, their classes, and every file's owner. A manifest's `owns` and the
 * table's `paths` are prefix overrides; the longest prefix wins.
 */
export function resolveOwnership(ctx, files, table, manifests) {
  const errors = []
  const registry = new Map()
  for (const [key, row] of Object.entries(table.subsystems ?? {})) {
    if (!CLASSES.includes(row.class))
      errors.push(`${OWNERSHIP_FILE}: "${key}" has class "${row.class}"`)
    registry.set(key, { class: row.class, source: "table" })
  }
  for (const [id, { file, manifest }] of manifests.host) {
    if (registry.has(id))
      errors.push(
        `${file}: "${id}" has a manifest, so remove its row from ${OWNERSHIP_FILE} (one owner, one source)`
      )
    registry.set(id, { class: manifest.kind === "kernel" ? "kernel" : "module", source: file })
  }

  const overrides = []
  for (const row of table.paths ?? []) overrides.push({ ...row, source: OWNERSHIP_FILE })
  for (const [id, { file, manifest }] of manifests.host)
    for (const prefix of manifest.owns ?? []) overrides.push({ prefix, owner: id, source: file })
  const byPrefix = new Map()
  for (const row of overrides) {
    const previous = byPrefix.get(row.prefix)
    if (previous && previous.owner !== row.owner)
      errors.push(
        `${row.prefix} is claimed by "${previous.owner}" (${previous.source}) and "${row.owner}" (${row.source})`
      )
    byPrefix.set(row.prefix, row)
    if (!registry.has(row.owner))
      errors.push(`${row.source}: ${row.prefix} names unknown owner "${row.owner}"`)
  }
  const prefixes = [...byPrefix.values()].sort((a, b) => b.prefix.length - a.prefix.length)

  const { classify } = createSubsystemClassifier(files)
  const owners = new Map()
  const used = new Set()
  for (const file of files) {
    const layer = file.split("/")[0]
    const override = prefixes.find((row) => file.startsWith(row.prefix))
    const owner = override ? override.owner : classify(file)?.key
    if (!owner) continue
    used.add(owner)
    const entry = registry.get(owner)
    if (!entry) {
      errors.push(
        `${file}: subsystem "${owner}" has no owner — add lib/${owner}/module.ts, or a row in ${OWNERSHIP_FILE} (a growth exception)`
      )
      continue
    }
    const kernelUi = entry.class === "kernel" && UI_LAYERS.has(layer)
    owners.set(file, {
      owner,
      layer,
      class: kernelUi ? "module" : entry.class,
      node: kernelUi ? `${owner}:ui` : owner,
    })
  }
  for (const [key, entry] of registry)
    if (entry.source === "table" && !used.has(key))
      errors.push(`${OWNERSHIP_FILE}: "${key}" owns no file — remove the row`)

  // A shell's contribution kit: files modules build their contributions with.
  // A module's `api` (its manifest's, or its table row's): the files other
  // modules may import (G3).
  const shellApi = new Set()
  const moduleApi = new Map()
  const listApi = (key, files, source) => {
    for (const file of files) {
      const owned = owners.get(file)
      if (owned?.owner !== key)
        errors.push(`${source}: "${key}" lists api file ${file}, which it does not own`)
      else if (registry.get(key).class === "shell") shellApi.add(file)
      else if (owned.class !== "module")
        // A kernel member lists api only for its UI module: modules import its lib freely.
        errors.push(`${source}: "${key}" lists api file ${file}, which is not in its UI module`)
      else {
        if (!moduleApi.has(key)) moduleApi.set(key, new Set())
        moduleApi.get(key).add(file)
      }
    }
  }
  for (const [key, row] of Object.entries(table.subsystems ?? {})) {
    if (row.api === undefined) continue
    if (row.class === "foundation" || !Array.isArray(row.api)) {
      errors.push(
        `${OWNERSHIP_FILE}: "${key}": only a shell, a module or a kernel member's UI lists \`api\` files, as a list`
      )
      continue
    }
    listApi(key, row.api, OWNERSHIP_FILE)
  }
  for (const [id, { file, manifest }] of manifests.host)
    if (Array.isArray(manifest.api)) listApi(id, manifest.api, file)
  return { owners, registry, shellApi, moduleApi, errors }
}

/**
 * A file that only re-exports, from two or more modules: a barrel, which an
 * `api` list never names (G3). One re-export is a forwarder, such as the shim a
 * move into a package leaves at the old path, and pulls in nothing extra.
 */
export function isBarrel(sourceFile) {
  const statements = sourceFile.statements
  return (
    statements.length > 1 &&
    statements.every((statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier)
  )
}

// ---------------------------------------------------------------- graphs

/** Largest strongly connected component size (Tarjan). */
export function largestComponent(graph) {
  let index = 0
  let largest = 0
  const indices = new Map()
  const low = new Map()
  const stack = []
  const onStack = new Set()
  const components = []
  const connect = (node) => {
    indices.set(node, index)
    low.set(node, index)
    index++
    stack.push(node)
    onStack.add(node)
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        connect(next)
        low.set(node, Math.min(low.get(node), low.get(next)))
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)))
    }
    if (low.get(node) === indices.get(node)) {
      const component = []
      let member
      do {
        member = stack.pop()
        onStack.delete(member)
        component.push(member)
      } while (member !== node)
      components.push(component)
      if (component.length > largest) largest = component.length
    }
  }
  for (const node of graph.keys()) if (!indices.has(node)) connect(node)
  return { largest, components }
}

function dependsOnErrors(manifests, registry) {
  const errors = []
  const graph = new Map()
  for (const [id, { file, manifest }] of manifests.host) {
    graph.set(id, new Set())
    for (const target of manifest.dependsOn ?? []) {
      if (!registry.has(target)) errors.push(`${file}: dependsOn names unknown "${target}"`)
      if (target === id) errors.push(`${file}: "${id}" depends on itself`)
      graph.get(id).add(target)
    }
  }
  for (const component of largestComponent(graph).components)
    if (component.length > 1)
      errors.push(`dependsOn cycle: ${component.sort().join(" → ")} (G6 requires an acyclic graph)`)
  return errors
}

// ------------------------------------------------------------ measures

/** `SettingsState` members, inherited ones included: the flat `AppSettings` keys. */
function settingsStateMemberList(ctx) {
  if (!ctx.exists(SETTINGS_STORE_FILE)) return []
  const sourceFile = ctx.ast(SETTINGS_STORE_FILE)
  const interfaces = new Map()
  for (const statement of sourceFile.statements)
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement)
  const collect = (name, seen = new Set()) => {
    const declaration = interfaces.get(name)
    if (!declaration || seen.has(name)) return []
    seen.add(name)
    const members = [...declaration.members]
    for (const clause of declaration.heritageClauses ?? [])
      for (const type of clause.types)
        if (ts.isIdentifier(type.expression)) members.push(...collect(type.expression.text, seen))
    return members
  }
  return collect("SettingsState")
}

function settingsStateMembers(ctx) {
  return settingsStateMemberList(ctx).length
}

function settingsStateKeys(ctx) {
  const keys = new Set()
  for (const member of settingsStateMemberList(ctx)) {
    const name = member.name
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) keys.add(name.text)
  }
  return keys
}

function coreTableNames(ctx) {
  if (!ctx.exists(TABLE_CATALOG_FILE)) return []
  let names = []
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CORE_TABLE_NAMES" &&
      node.initializer
    ) {
      const array = unwrap(node.initializer)
      if (ts.isArrayLiteralExpression(array))
        names = array.elements
          .filter((element) => ts.isStringLiteralLike(element))
          .map((element) => element.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ctx.ast(TABLE_CATALOG_FILE))
  return names
}

function coreTableCount(ctx) {
  return coreTableNames(ctx).length
}

/**
 * Names a file reads: property names (`db.agentTeams`, `settings.locale`),
 * destructured names and string literals (`db.table("x")`, `get("key")`). G4
 * asks only whether a declared table or key is touched at all, so a broad
 * reading is the right one: it can miss nothing a module really uses.
 */
function namesRead(sourceFile) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text)
    else if (ts.isStringLiteralLike(node)) names.add(node.text)
    else if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) names.add(name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

/**
 * G4: what each manifest declares equals what its files do. `actualDeps` maps a
 * module to the modules its files import (`types/**` aside).
 */
export function declaredErrors(ctx, manifests, registry, owners, actualDeps) {
  const errors = []
  const filesOf = new Map()
  for (const [file, { owner }] of owners) {
    if (!filesOf.has(owner)) filesOf.set(owner, [])
    filesOf.get(owner).push(file)
  }
  const tables = new Set(coreTableNames(ctx))
  const keys = settingsStateKeys(ctx)
  const claims = { table: new Map(), "settings key": new Map() }
  for (const [id, { file, manifest }] of manifests.host) {
    const declared = new Set(manifest.dependsOn ?? [])
    const actual = actualDeps.get(id) ?? new Set()
    for (const target of declared) {
      const cls = registry.get(target)?.class
      if (cls === "foundation" || cls === "shell")
        errors.push(
          `G4 ${file}: dependsOn names "${target}", a ${cls}; only modules are depended on`
        )
      else if (cls && !actual.has(target))
        errors.push(`G4 ${file}: dependsOn names "${target}", which no file of "${id}" imports`)
    }
    for (const target of [...actual].sort())
      if (!declared.has(target))
        errors.push(
          `G4 ${file}: "${id}" imports module "${target}" but its dependsOn does not name it`
        )

    const declaredTables = manifest.tables ?? []
    const declaredKeys = manifest.settings?.keys ?? []
    if (!declaredTables.length && !declaredKeys.length) continue
    // The manifests name every table and key they declare, so they do not count.
    const read = new Set()
    for (const owned of filesOf.get(id) ?? [])
      if (!manifestKind(owned)) for (const name of namesRead(ctx.ast(owned))) read.add(name)
    const check = (kind, name, known, catalog) => {
      if (known.size && !known.has(name))
        errors.push(`G4 ${file}: ${kind} "${name}" is not in ${catalog}`)
      const first = claims[kind].get(name)
      if (first && first !== id)
        errors.push(`G4 ${file}: ${kind} "${name}" is also claimed by "${first}"`)
      else claims[kind].set(name, id)
      if (!read.has(name))
        errors.push(`G4 ${file}: declares ${kind} "${name}", which no file of "${id}" touches`)
    }
    for (const table of declaredTables)
      check("table", table, tables, `CORE_TABLE_NAMES (${TABLE_CATALOG_FILE})`)
    for (const key of declaredKeys)
      check("settings key", key, keys, `SettingsState (${SETTINGS_STORE_FILE})`)
  }
  return errors
}

function vendorBranches(sourceFile) {
  const literals = []
  const check = (node) => {
    const value = unwrap(node)
    if (ts.isStringLiteralLike(value) && VENDOR_LITERAL.test(value.text)) literals.push(value.text)
  }
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      check(node.left)
      check(node.right)
    } else if (ts.isCaseClause(node)) check(node.expression)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sorted(literals)
}

function frameworkOf(file) {
  const framework = VENDOR_FRAMEWORKS.find((entry) => file.startsWith(entry.path))
  if (!framework) return null
  if (framework.implementations.some((prefix) => file.startsWith(prefix))) return null
  return framework
}

/** The framework and catalog entry when `file` is a vendor catalog. */
function catalogOf(file) {
  for (const framework of VENDOR_FRAMEWORKS)
    for (const catalog of framework.catalogs ?? [])
      if (catalog.file === file) return { framework, catalog }
  return null
}

/** Whether a catalog may import `target`: a framework file or one implementation's entry. */
function catalogMayImport({ framework, catalog }, target) {
  if (!target.startsWith(framework.path)) return false
  const implementation = framework.implementations.find((prefix) => target.startsWith(prefix))
  if (!implementation) return true
  const [segment, entry, ...rest] = target.slice(implementation.length).split("/")
  return !segment.startsWith("_") && entry === catalog.entry && rest.length === 0
}

// ------------------------------------------------------------------ run

/** Compute every measure. Pure over `ctx`, so fixtures can drive it. */
export function computeModules(ctx) {
  // The generated registries are the one sanctioned kernel → module import (they
  // collect the modules); G5 checks them, so they are not source files here.
  const files = ctx.files(LAYERED_ROOTS).filter((file) => !GENERATED_FILES.includes(file))
  const table = ctx.exists(OWNERSHIP_FILE)
    ? JSON.parse(ctx.read(OWNERSHIP_FILE))
    : { subsystems: {}, paths: [] }
  const manifests = collectManifests(ctx, files)
  const {
    owners,
    registry,
    shellApi,
    moduleApi,
    errors: ownershipErrors,
  } = resolveOwnership(ctx, files, table, manifests)
  const errors = [
    ...manifests.errors,
    ...ownershipErrors,
    ...dependsOnErrors(manifests, registry),
    ...registryErrors(ctx, manifests),
  ]

  for (const [id, files] of moduleApi)
    for (const file of files)
      if (isBarrel(ctx.ast(file)))
        errors.push(
          `G3 ${file}: "${id}" lists a barrel as api; list the files it re-exports instead`
        )

  const direction = []
  const publicApi = []
  const actualDeps = new Map()
  const libGraph = new Map()
  const vendorNeutral = []
  const settingsImporters = new Set()
  for (const file of files) {
    const source = owners.get(file)
    const framework = frameworkOf(file)
    const catalog = catalogOf(file)
    if (framework && VENDOR_SEGMENT.test(file.slice(framework.path.length)))
      vendorNeutral.push(`${file} :: vendor file`)
    for (const record of importsIn(ctx, file)) {
      const target = resolveModule(ctx, record.spec, file)
      if (!target) continue
      if (SETTINGS_STORE_ENTRIES.includes(target) && !file.startsWith("stores/settings/"))
        settingsImporters.add(file)
      if (framework) {
        const outside = !target.startsWith(framework.path)
        // `_shared/` beside the implementations is common adapter plumbing, not a vendor.
        const implementation = framework.implementations.some(
          (prefix) => target.startsWith(prefix) && !target.slice(prefix.length).startsWith("_")
        )
        const vendorPath = outside && VENDOR_SEGMENT.test(target)
        if (implementation || vendorPath) vendorNeutral.push(`${file} :: imports ${target}`)
      }
      if (catalog && !catalogMayImport(catalog, target))
        vendorNeutral.push(`${file} :: catalog imports ${target}`)
      if (!source) continue
      const destination = owners.get(target)
      if (!destination || destination.node === source.node) continue
      // G3/G4: an import between two modules, one of which has a manifest.
      if (
        source.class === "module" &&
        destination.class === "module" &&
        (manifests.host.has(source.owner) || manifests.host.has(destination.owner)) &&
        !target.startsWith("types/")
      ) {
        if (manifests.host.has(source.owner) && source.owner !== destination.owner) {
          if (!actualDeps.has(source.owner)) actualDeps.set(source.owner, new Set())
          actualDeps.get(source.owner).add(destination.owner)
        }
        if (!moduleApi.get(destination.owner)?.has(target)) publicApi.push(`${file} -> ${target}`)
      }
      if (record.typeOnly) continue
      const contributionKit = destination.class === "shell" && shellApi.has(target)
      if (RANK[source.class] < RANK[destination.class] && !contributionKit)
        direction.push(`${file} -> ${destination.node}`)
      if (source.layer === "lib" && destination.layer === "lib") {
        if (!libGraph.has(source.node)) libGraph.set(source.node, new Set())
        libGraph.get(source.node).add(destination.node)
      }
    }
    if (framework)
      for (const literal of vendorBranches(ctx.ast(file)))
        vendorNeutral.push(`${file} :: compares "${literal}"`)
  }

  errors.push(...declaredErrors(ctx, manifests, registry, owners, actualDeps))

  const classCount = (cls) => [...registry.values()].filter((entry) => entry.class === cls).length
  return {
    errors,
    warnings: manifests.warnings,
    owners,
    registry,
    measures: {
      direction: sorted(direction),
      publicApi: sorted([...new Set(publicApi)]),
      cycles: { largestLibComponent: largestComponent(libGraph).largest },
      size: {
        modules: classCount("module"),
        experimental: [...manifests.host.values()].filter(
          ({ manifest }) => manifest.stage === "experimental"
        ).length,
        tables: coreTableCount(ctx),
        settingsStateMembers: settingsStateMembers(ctx),
        settingsStoreImporters: settingsImporters.size,
        registryEagerFiles: registryEagerFiles(ctx, manifests),
      },
      vendorNeutral: sorted(vendorNeutral),
    },
    tableRows: Object.keys(table.subsystems ?? {}).length,
  }
}

const BASELINE_NOTE =
  "Measures of the module gate (scripts/gates/check-modules.mjs, ADR-0250 §14). Every one may only fall: `direction` (G2, blocking since M1), `publicApi` (G3, blocking since M1), `cycles` (G6), `size` (G7) and `vendorNeutral` (G8). scripts/gates/check-baseline-growth.mjs compares this file against the merge base. Rewrite it with `--write-baseline` only after paying a measure down."

/** Compare the computed measures with the baseline. */
export function compare(measures, baseline) {
  const failures = []
  const hints = []
  const listDelta = (name, current, known) => {
    const knownSet = new Set(known ?? [])
    const currentSet = new Set(current)
    return {
      added: current.filter((item) => !knownSet.has(item)),
      repaid: (known ?? []).filter((item) => !currentSet.has(item)),
      name,
    }
  }
  const direction = listDelta("direction", measures.direction, baseline.direction)
  if (direction.added.length)
    failures.push(
      `G2 direction: ${direction.added.length} new edge(s) — foundation must not import above it, the kernel must not import a module or a shell, and a module must not import a shell. Invert the dependency (a manifest contribution, a port, a kernel event), move the code to its owner, or, when the target is a shell's contribution kit, list it in that shell's \`api\` in ${OWNERSHIP_FILE}\n${direction.added
        .map((edge) => `  ${edge}`)
        .join("\n")}`
    )
  const publicApi = listDelta("publicApi", measures.publicApi, baseline.publicApi)
  if (publicApi.added.length)
    failures.push(
      `G3 public API: ${publicApi.added.length} new import(s) of a file the target module does not list as \`api\` — import one of its api files, or list the file in its manifest's \`api\` (or its row's in ${OWNERSHIP_FILE}) when it is meant to be public\n${publicApi.added
        .map((item) => `  ${item}`)
        .join("\n")}`
    )
  const vendor = listDelta("vendorNeutral", measures.vendorNeutral, baseline.vendorNeutral)
  if (vendor.added.length)
    failures.push(
      `G8 vendor-neutral frameworks: ${vendor.added.length} new violation(s) — vendor behaviour belongs in its business implementation (ADR-0250 §14)\n${vendor.added
        .map((item) => `  ${item}`)
        .join("\n")}`
    )
  for (const delta of [direction, publicApi, vendor])
    if (delta.repaid.length)
      hints.push(`${delta.name}: ${delta.repaid.length} baselined item(s) repaid`)
  const numbers = [
    ["cycles", measures.cycles, baseline.cycles ?? {}, "G6"],
    ["size", measures.size, baseline.size ?? {}, "G7"],
  ]
  for (const [group, current, known, gate] of numbers)
    for (const [key, value] of Object.entries(current)) {
      const limit = known[key]
      if (limit === undefined)
        failures.push(`${gate} ${group}.${key}: no baseline — run --write-baseline`)
      else if (value > limit) failures.push(`${gate} ${group}.${key}: ${value} > baseline ${limit}`)
      else if (value < limit) hints.push(`${group}.${key}: ${value} < baseline ${limit}`)
    }
  return { failures, hints }
}

export function baselineDocument(measures) {
  return {
    version: 1,
    note: BASELINE_NOTE,
    cycles: measures.cycles,
    size: measures.size,
    direction: measures.direction,
    publicApi: measures.publicApi,
    vendorNeutral: measures.vendorNeutral,
  }
}

function options(argv) {
  const opts = { write: false, json: false, root: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--write-baseline") opts.write = true
    else if (arg === "--json") opts.json = true
    else if (arg === "--root" && argv[i + 1]) opts.root = resolve(argv[++i])
    else throw new Error(`unknown argument ${arg}`)
  }
  return opts
}

export function main(argv = [], output = console) {
  const opts = options(argv)
  const ctx = createContext(opts.root)
  const result = computeModules(ctx)
  const baselinePath = join(ctx.root, BASELINE_FILE)
  if (opts.write) {
    if (result.errors.length) {
      for (const error of result.errors) output.error(`  ${error}`)
      output.error(
        `[modules] refusing to write a baseline while G1/G3/G4/G5/G6 has ${result.errors.length} error(s)`
      )
      return 1
    }
    writeFileSync(baselinePath, `${JSON.stringify(baselineDocument(result.measures), null, 2)}\n`)
    output.log(`[modules] wrote ${BASELINE_FILE}`)
    return 0
  }
  const baseline = ctx.exists(BASELINE_FILE) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {}
  const { failures, hints } = compare(result.measures, baseline)
  if (opts.json) {
    output.log(
      JSON.stringify(
        {
          errors: result.errors,
          warnings: result.warnings,
          failures,
          hints,
          measures: result.measures,
        },
        null,
        2
      )
    )
    return result.errors.length || failures.length ? 1 : 0
  }
  for (const warning of result.warnings) output.log(`[modules] warning: ${warning}`)
  for (const hint of hints)
    output.log(`[modules] paid down — ${hint}; run --write-baseline to lock it in`)
  if (result.errors.length || failures.length) {
    if (result.errors.length) {
      output.error(`[modules] G1/G3/G4/G5/G6: ${result.errors.length} error(s)`)
      for (const error of result.errors) output.error(`  ${error}`)
    }
    for (const failure of failures) output.error(`[modules] ${failure}`)
    return 1
  }
  output.log(
    `[modules] OK — ${result.owners.size} files across ${result.registry.size} owners (${result.tableRows} still in the transitional table); ${result.measures.direction.length} direction edge(s) baselined, largest lib cycle ${result.measures.cycles.largestLibComponent}`
  )
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
