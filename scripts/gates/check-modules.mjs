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
 *                  the shell. REPORTING ONLY until phase M1 (ADR-0250 §13):
 *                  it prints new edges and never fails. Its baseline is kept
 *                  so M1 can turn it on without a new count.
 *   G6 cycles      `dependsOn` across manifests is acyclic (blocking), and the
 *                  largest strongly connected component of the lib/ owner
 *                  graph may only shrink.
 *   G7 size        module count, experimental modules, Dexie tables,
 *                  `SettingsState` members and settings-store importers may
 *                  only shrink. The eager graph of each host's generated
 *                  registry joins this list when M1 generates the first one.
 *   G8 vendors     framework directories (IM connectors, cloud documents,
 *                  issue sync, backup, scheduling) name no vendor and import
 *                  no vendor implementation. Existing violations are
 *                  baselined; a new one fails.
 *
 * G3 (public API), G4 (declared equals actual) and G5 (generated registries)
 * arrive with the registries they check, from M1 on.
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
import { createSubsystemClassifier, LAYERED_ROOTS } from "./lib/subsystems.mjs"

export const OWNERSHIP_FILE = "scripts/gates/module-ownership.json"
export const BASELINE_FILE = "scripts/gates/modules-baseline.json"
export const DEFINE_MODULE = "@/lib/modules/define"
export const CODEOWNERS_FILE = ".github/CODEOWNERS"
export const SETTINGS_STORE_FILE = "stores/settings/settings-store.ts"
export const SETTINGS_STORE_ENTRIES = ["stores/settings/index.ts", SETTINGS_STORE_FILE]
export const TABLE_CATALOG_FILE = "lib/data-governance/table-catalog.ts"

export const CLASSES = ["foundation", "kernel", "module", "shell"]
const RANK = { foundation: 0, kernel: 1, module: 2, shell: 3 }
const UI_LAYERS = new Set(["app", "components", "hooks"])

/** Top-level fields of `HostModuleManifest` (`lib/modules/manifest-types.ts`). */
export const HOST_FIELDS = [
  "id",
  "kind",
  "stage",
  "owner",
  "acceptance",
  "owns",
  "dependsOn",
  "api",
  "provides",
  "requires",
  "runtimes",
  "settings",
  "tables",
  "tools",
  "capabilityContributions",
  "taskExecutors",
  "builtinSkills",
  "pluginApi",
  "workflowNodes",
  "searchProviders",
  "slashCommands",
  "prompts",
  "flags",
  "messages",
]
/** Top-level fields of `UiModuleManifest`. */
export const UI_FIELDS = ["id", "slots", "settingsSections", "nav", "effects"]
const KINDS = ["kernel", "module"]
const STAGES = ["kernel", "stable", "beta", "experimental", "deprecated"]

/**
 * Framework directories that must stay vendor-neutral (G8), each with the
 * directories where its vendor implementations belong. Files under an
 * implementation directory are not framework code.
 */
export const VENDOR_FRAMEWORKS = [
  { path: "lib/connectors/", implementations: ["lib/connectors/adapters/"] },
  { path: "lib/docs-providers/", implementations: ["lib/docs-providers/providers/"] },
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

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression
  return node
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text
  return null
}

/**
 * Evaluate a manifest expression as data. Literals, arrays and objects pass
 * through; `() => import("…")` becomes `{ $lazy: "…" }`; anything else is an
 * error, because it would run when a host imports the generated registry.
 */
function literalValue(node, at, errors) {
  node = unwrap(node)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text)
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((element, index) => literalValue(element, `${at}[${index}]`, errors))
  if (ts.isObjectLiteralExpression(node)) {
    const out = {}
    for (const property of node.properties) {
      const name = ts.isPropertyAssignment(property) ? propertyName(property.name) : null
      if (name === null) {
        errors.push(`${at}: only plain \`key: value\` properties are data`)
        continue
      }
      out[name] = literalValue(property.initializer, `${at}.${name}`, errors)
    }
    return out
  }
  if (ts.isArrowFunction(node) && node.parameters.length === 0) {
    const body = unwrap(node.body)
    if (
      ts.isCallExpression(body) &&
      body.expression.kind === ts.SyntaxKind.ImportKeyword &&
      body.arguments.length === 1 &&
      ts.isStringLiteralLike(body.arguments[0])
    )
      return { $lazy: body.arguments[0].text }
  }
  errors.push(`${at}: not data — use a literal or a lazy entry \`() => import("…")\``)
  return undefined
}

/**
 * Read a manifest file: one named import of `helper` from `@/lib/modules/define`
 * and `export default helper({ … })`, nothing else.
 */
export function readManifest(ctx, file, helper) {
  const errors = []
  const sourceFile = ctx.ast(file)
  let value
  for (const statement of sourceFile.statements) {
    const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      const names =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements.map((element) => element.name.text)
          : []
      const ok =
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === DEFINE_MODULE &&
        !clause?.name &&
        !clause?.isTypeOnly &&
        names.length === 1 &&
        names[0] === helper
      if (!ok)
        errors.push(`line ${line}: a manifest imports only { ${helper} } from "${DEFINE_MODULE}"`)
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const call = unwrap(statement.expression)
      if (
        !ts.isCallExpression(call) ||
        !ts.isIdentifier(call.expression) ||
        call.expression.text !== helper ||
        call.arguments.length !== 1
      )
        errors.push(`line ${line}: export default ${helper}({ … })`)
      else value = literalValue(call.arguments[0], "manifest", errors)
    } else {
      errors.push(
        `line ${line}: a manifest's top level holds only its import and \`export default ${helper}(…)\``
      )
    }
  }
  if (value === undefined && errors.length === 0) errors.push(`exports no ${helper}(…) manifest`)
  return { value, errors }
}

function lazyEntries(value, at = "manifest", out = []) {
  if (Array.isArray(value))
    value.forEach((item, index) => lazyEntries(item, `${at}[${index}]`, out))
  else if (value && typeof value === "object") {
    if (typeof value.$lazy === "string") out.push({ at, spec: value.$lazy })
    else for (const [key, item] of Object.entries(value)) lazyEntries(item, `${at}.${key}`, out)
  }
  return out
}

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

export function validateHostManifest(manifest, id) {
  const errors = []
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return ["manifest is not an object"]
  for (const key of Object.keys(manifest))
    if (!HOST_FIELDS.includes(key)) errors.push(`unknown field "${key}"`)
  if (manifest.id !== id) errors.push(`id "${manifest.id}" must equal its directory "${id}"`)
  if (!KINDS.includes(manifest.kind)) errors.push(`kind must be one of ${KINDS.join(", ")}`)
  if (!STAGES.includes(manifest.stage)) errors.push(`stage must be one of ${STAGES.join(", ")}`)
  if ((manifest.kind === "kernel") !== (manifest.stage === "kernel"))
    errors.push(`stage "kernel" goes with kind "kernel", and only with it`)
  if (manifest.owner !== undefined && typeof manifest.owner !== "string")
    errors.push("owner is one CODEOWNERS handle")
  for (const field of ["owns", "dependsOn", "api", "requires", "tables"])
    if (manifest[field] !== undefined && !isStringArray(manifest[field]))
      errors.push(`${field} is a list of strings`)
  if (manifest.settings !== undefined && !isStringArray(manifest.settings?.keys))
    errors.push("settings.keys is a list of strings")
  const smoke = manifest.acceptance?.realSmoke
  if (smoke !== undefined && smoke !== "pending" && !/^passed:\d{4}-\d{2}-\d{2}$/.test(smoke))
    errors.push(`acceptance.realSmoke is "pending" or "passed:<YYYY-MM-DD>"`)
  return errors
}

export function validateUiManifest(manifest, id) {
  const errors = []
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return ["manifest is not an object"]
  for (const key of Object.keys(manifest))
    if (!UI_FIELDS.includes(key)) errors.push(`unknown field "${key}"`)
  if (manifest.id !== id) errors.push(`id "${manifest.id}" must equal its directory "${id}"`)
  return errors
}

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
  for (const file of files) {
    const hostMatch = /^lib\/([^/]+)\/module\.ts$/.exec(file)
    const uiMatch = /^components\/([^/]+)\/module\.ui\.ts$/.exec(file)
    if (!hostMatch && !uiMatch) continue
    const id = (hostMatch ?? uiMatch)[1]
    const helper = hostMatch ? "defineHostModule" : "defineUiModule"
    const { value, errors: readErrors } = readManifest(ctx, file, helper)
    const shapeErrors =
      value === undefined
        ? []
        : hostMatch
          ? validateHostManifest(value, id)
          : validateUiManifest(value, id)
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
  return { host, ui, errors, warnings }
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
  return { owners, registry, errors }
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

function settingsStateMembers(ctx) {
  if (!ctx.exists(SETTINGS_STORE_FILE)) return 0
  const sourceFile = ctx.ast(SETTINGS_STORE_FILE)
  const interfaces = new Map()
  for (const statement of sourceFile.statements)
    if (ts.isInterfaceDeclaration(statement)) interfaces.set(statement.name.text, statement)
  const count = (name, seen = new Set()) => {
    const declaration = interfaces.get(name)
    if (!declaration || seen.has(name)) return 0
    seen.add(name)
    let total = declaration.members.length
    for (const clause of declaration.heritageClauses ?? [])
      for (const type of clause.types)
        if (ts.isIdentifier(type.expression)) total += count(type.expression.text, seen)
    return total
  }
  return count("SettingsState")
}

function coreTableCount(ctx) {
  if (!ctx.exists(TABLE_CATALOG_FILE)) return 0
  let total = 0
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CORE_TABLE_NAMES" &&
      node.initializer
    ) {
      const array = unwrap(node.initializer)
      if (ts.isArrayLiteralExpression(array))
        total = array.elements.filter((element) => ts.isStringLiteralLike(element)).length
    }
    ts.forEachChild(node, visit)
  }
  visit(ctx.ast(TABLE_CATALOG_FILE))
  return total
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

// ------------------------------------------------------------------ run

/** Compute every measure. Pure over `ctx`, so fixtures can drive it. */
export function computeModules(ctx) {
  const files = ctx.files(LAYERED_ROOTS)
  const table = ctx.exists(OWNERSHIP_FILE)
    ? JSON.parse(ctx.read(OWNERSHIP_FILE))
    : { subsystems: {}, paths: [] }
  const manifests = collectManifests(ctx, files)
  const {
    owners,
    registry,
    errors: ownershipErrors,
  } = resolveOwnership(ctx, files, table, manifests)
  const errors = [...manifests.errors, ...ownershipErrors, ...dependsOnErrors(manifests, registry)]

  const direction = []
  const libGraph = new Map()
  const vendorNeutral = []
  const settingsImporters = new Set()
  for (const file of files) {
    const source = owners.get(file)
    const framework = frameworkOf(file)
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
      if (record.typeOnly || !source) continue
      const destination = owners.get(target)
      if (!destination || destination.node === source.node) continue
      if (RANK[source.class] < RANK[destination.class])
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

  const classCount = (cls) => [...registry.values()].filter((entry) => entry.class === cls).length
  return {
    errors,
    warnings: manifests.warnings,
    owners,
    registry,
    measures: {
      direction: sorted(direction),
      cycles: { largestLibComponent: largestComponent(libGraph).largest },
      size: {
        modules: classCount("module"),
        experimental: [...manifests.host.values()].filter(
          ({ manifest }) => manifest.stage === "experimental"
        ).length,
        tables: coreTableCount(ctx),
        settingsStateMembers: settingsStateMembers(ctx),
        settingsStoreImporters: settingsImporters.size,
      },
      vendorNeutral: sorted(vendorNeutral),
    },
    tableRows: Object.keys(table.subsystems ?? {}).length,
  }
}

const BASELINE_NOTE =
  "Measures of the module gate (scripts/gates/check-modules.mjs, ADR-0250 §14). Every one may only fall: `direction` (G2, reporting only until M1), `cycles` (G6), `size` (G7) and `vendorNeutral` (G8). scripts/gates/check-baseline-growth.mjs compares this file against the merge base. Rewrite it with `--write-baseline` only after paying a measure down."

/** Compare the computed measures with the baseline. */
export function compare(measures, baseline) {
  const failures = []
  const hints = []
  const reports = []
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
    reports.push(
      `G2 direction (reporting only until M1): ${direction.added.length} new edge(s)\n${direction.added
        .slice(0, 40)
        .map((edge) => `  ${edge}`)
        .join("\n")}`
    )
  const vendor = listDelta("vendorNeutral", measures.vendorNeutral, baseline.vendorNeutral)
  if (vendor.added.length)
    failures.push(
      `G8 vendor-neutral frameworks: ${vendor.added.length} new violation(s) — vendor behaviour belongs in its business implementation (ADR-0250 §14)\n${vendor.added
        .map((item) => `  ${item}`)
        .join("\n")}`
    )
  for (const delta of [direction, vendor])
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
  return { failures, hints, reports }
}

export function baselineDocument(measures) {
  return {
    version: 1,
    note: BASELINE_NOTE,
    cycles: measures.cycles,
    size: measures.size,
    direction: measures.direction,
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
        `[modules] refusing to write a baseline while G1/G6 has ${result.errors.length} error(s)`
      )
      return 1
    }
    writeFileSync(baselinePath, `${JSON.stringify(baselineDocument(result.measures), null, 2)}\n`)
    output.log(`[modules] wrote ${BASELINE_FILE}`)
    return 0
  }
  const baseline = ctx.exists(BASELINE_FILE) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {}
  const { failures, hints, reports } = compare(result.measures, baseline)
  if (opts.json) {
    output.log(
      JSON.stringify(
        {
          errors: result.errors,
          warnings: result.warnings,
          failures,
          hints,
          reports,
          measures: result.measures,
        },
        null,
        2
      )
    )
    return result.errors.length || failures.length ? 1 : 0
  }
  for (const warning of result.warnings) output.log(`[modules] warning: ${warning}`)
  for (const report of reports) output.log(`[modules] ${report}`)
  for (const hint of hints)
    output.log(`[modules] paid down — ${hint}; run --write-baseline to lock it in`)
  if (result.errors.length || failures.length) {
    if (result.errors.length) {
      output.error(`[modules] G1/G6: ${result.errors.length} error(s)`)
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
