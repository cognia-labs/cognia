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
 *                  accessed by its files (or the data modules they import)
 *                  and claimed by no other module, and its `settings.keys`
 *                  are `AppSettings` keys its files read, no other module
 *                  claims, and its settings section exists. A `lib/db/` data
 *                  module only one manifest module uses must be claimed by
 *                  it. Blocking, 0 mismatches. Since M2, another module
 *                  accessing a claimed table directly is a violation,
 *                  baselined (`tableAccess`, fingerprint `file -> table`); a
 *                  new one fails. Since M3, only a manifest module defines a
 *                  settings view, over its own manifest's `settings.keys`
 *                  (blocking), and any other file that reaches the settings
 *                  (the store, a view, `lib/db/settings.ts`) and names a
 *                  claimed key is a violation, baselined (`settingsAccess`,
 *                  fingerprint `file -> key`); a new one fails. The runtime
 *                  clauses (brain adapters, runtime-initializers) apply once
 *                  manifests carry `runtimes` and `effects`.
 *   G5 generation  manifests are data only, their lazy entries resolve, and
 *                  `lib/modules/generated/host.ts` and
 *                  `components/modules/generated/ui.ts` equal what
 *                  scripts/build/gen-module-registry.mjs writes, so nothing is
 *                  hand-added to them. Since M1, for settings sections, search
 *                  providers and slash commands. Since M3, a tool name is
 *                  declared by one module, and every per-call tool is on the
 *                  sidecar's `PER_CALL_PLUGIN_TOOL_NAMES`; one module at most
 *                  places a context section in the `identity` slot.
 *   G6 cycles      `dependsOn` across manifests is acyclic (blocking), and the
 *                  largest strongly connected component of the lib/ owner
 *                  graph may only shrink.
 *   G7 size        module count, experimental modules, Dexie tables, tables
 *                  no manifest claims, data modules with a single user,
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
  declaredPorts,
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
/** A module's door onto the settings (`defineSettingsView`). */
export const SETTINGS_VIEW_FILE = "stores/settings/view.ts"
export const SETTINGS_DATA_FILE = "lib/db/settings.ts"
/** What a file imports to reach the settings directly. */
export const SETTINGS_ACCESS_ENTRIES = [
  ...SETTINGS_STORE_ENTRIES,
  SETTINGS_VIEW_FILE,
  SETTINGS_DATA_FILE,
]
/** Where `AppSettings`, the flat settings a module claims keys of, is declared. */
export const APP_SETTINGS_FILE = "packages/plugin-contract/src/types/agent-config/index.ts"
export const TABLE_CATALOG_FILE = "lib/data-governance/table-catalog.ts"
/** The Lucide catalog's names, which a settings section's `icon` must be one of. */
export const LUCIDE_NAMES_FILE =
  "packages/plugin-contract/src/lib/icons/lucide-icon-names.generated.json"
/** `MOBILE_SPOT_ICON_NAMES`, which a nav entry's `mobileShortcut.spotIcon` must be one of. */
export const SPOT_ICON_FILE = "components/mobile/mobile-spot-icon.tsx"
/** `CANONICAL_EXTENSION_POINTS`, which a UI manifest's `slots` keys must be. */
export const EXTENSION_POINTS_FILE =
  "packages/plugin-contract/src/lib/plugin/contracts/plugin-points.ts"

/** The data layer: `lib/db/` data modules a subsystem claims once it is their only user. */
export const DATA_LAYER = "db"
export const DATA_LAYER_PATH = "lib/db/"

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
  const identityModules = []
  const handles = ctx.exists(CODEOWNERS_FILE)
    ? codeownerHandles(ctx.read(CODEOWNERS_FILE))
    : new Set()
  const vocabulary = {
    iconNames: ctx.exists(LUCIDE_NAMES_FILE)
      ? new Set(JSON.parse(ctx.read(LUCIDE_NAMES_FILE)).iconNames)
      : undefined,
    spotIconNames: constStringList(ctx, SPOT_ICON_FILE, "MOBILE_SPOT_ICON_NAMES"),
    extensionPoints: constStringList(ctx, EXTENSION_POINTS_FILE, "CANONICAL_EXTENSION_POINTS"),
    ports: declaredPorts(files, (file) => ctx.read(file)),
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
    const adapterErrors =
      hostMatch && !shapeErrors.length
        ? [
            ...runtimeAdapterErrors(ctx, file, value),
            ...provisionExportErrors(ctx, file, value),
            ...promptsExportErrors(ctx, file, value),
            ...contributionsExportErrors(ctx, file, value),
            ...contextExportErrors(ctx, file, value),
            ...toolsExportErrors(ctx, file, value),
          ]
        : []
    for (const message of [...readErrors, ...shapeErrors, ...lazyErrors, ...adapterErrors])
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
      if (declaresIdentitySlot(ctx, file, value)) identityModules.push(id)
    } else ui.set(id, { file, manifest: value })
  }
  // One identity replaces the base system prompt; a second would race it.
  if (identityModules.length > 1)
    errors.push(
      `context: the identity slot is declared by more than one module (${identityModules.join(", ")})`
    )
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
    ...duplicateContributions(host, (manifest) => manifest.nav, "id", "navigation entry "),
    ...duplicateContributions(host, (manifest) => manifest.runtimes, "name", "runtime "),
    // A task type has one executor: the scheduler loads its owner by type.
    ...duplicateContributions(
      host,
      (manifest) =>
        Array.isArray(manifest.taskExecutors?.types)
          ? manifest.taskExecutors.types.map((name) => ({ name }))
          : [],
      "name",
      "task executor "
    ),
    // A tool name routes to one module: the dispatcher looks it up by name.
    ...duplicateContributions(
      host,
      (manifest) =>
        manifest.tools?.declare && typeof manifest.tools.declare === "object"
          ? Object.keys(manifest.tools.declare).map((name) => ({ name }))
          : [],
      "name",
      "tool "
    ),
    // One provider per port: `lib/modules/ports.ts` refuses two at runtime. A
    // collection port takes one member from every providing module.
    ...duplicateContributions(
      host,
      (manifest) =>
        Array.isArray(manifest.provides)
          ? manifest.provides.filter(
              (provision) => vocabulary.ports.get(provision?.port) !== "many"
            )
          : manifest.provides,
      "port",
      "port "
    )
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

/** Whether a module exports `start`: a function, a `const`, or a re-export. */
export function exportsStart(sourceFile) {
  return exportsName(sourceFile, "start")
}

/** Whether a module exports `name` as a value: a function, a `const`, or a re-export. */
export function exportsName(sourceFile, name) {
  const exported = (node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && exported(statement))
      return true
    if (ts.isVariableStatement(statement) && exported(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return true
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((element) => element.name.text === name)
    )
      return true
  }
  return false
}

/** Each runtime adapter resolves from its manifest and exports `start`. */
function runtimeAdapterErrors(ctx, file, manifest) {
  const errors = []
  ;(manifest.runtimes ?? []).forEach((runtime, index) => {
    for (const host of ["brain", "desktop", "mobile"]) {
      const adapter = runtime.adapters?.[host]
      if (adapter === undefined) continue
      const spec = host === "brain" ? adapter.module : adapter
      const at = `runtimes[${index}].adapters.${host}`
      const target = resolveModule(ctx, spec, file)
      if (!target) errors.push(`${at}: "${spec}" does not resolve`)
      else if (!exportsStart(ctx.ast(target))) errors.push(`${at}: ${target} exports no \`start\``)
    }
  })
  return errors
}

/** Each port provision's file exports the implementation as `port`. */
function provisionExportErrors(ctx, file, manifest) {
  const errors = []
  ;(manifest.provides ?? []).forEach((provision, index) => {
    const spec = provision?.load?.$lazy
    if (typeof spec !== "string") return
    const target = resolveModule(ctx, spec, file)
    // An unresolved lazy entry is already reported with the other lazy entries.
    if (target && !exportsName(ctx.ast(target), "port"))
      errors.push(`provides[${index}]: ${target} exports no \`port\``)
  })
  return errors
}

/** A module's `prompts` file exports its definitions as `prompts`. */
function promptsExportErrors(ctx, file, manifest) {
  const spec = manifest.prompts?.$lazy
  if (typeof spec !== "string") return []
  const target = resolveModule(ctx, spec, file)
  // An unresolved lazy entry is already reported with the other lazy entries.
  return target && !exportsName(ctx.ast(target), "prompts")
    ? [`prompts: ${target} exports no \`prompts\``]
    : []
}

/** A module's `capabilityContributions` file exports them as `contributions`. */
function contributionsExportErrors(ctx, file, manifest) {
  const spec = manifest.capabilityContributions?.load?.$lazy
  if (typeof spec !== "string") return []
  const target = resolveModule(ctx, spec, file)
  return target && !exportsName(ctx.ast(target), "contributions")
    ? [`capabilityContributions: ${target} exports no \`contributions\``]
    : []
}

/** A module's `context.load` file exports them as `contributions`. */
function contextExportErrors(ctx, file, manifest) {
  const spec = manifest.context?.load?.$lazy
  if (typeof spec !== "string") return []
  const target = resolveModule(ctx, spec, file)
  return target && !exportsName(ctx.ast(target), "contributions")
    ? [`context: ${target} exports no \`contributions\``]
    : []
}

/** Whether a module's `context.load` file places a section in the `identity` slot. */
function declaresIdentitySlot(ctx, file, manifest) {
  const spec = manifest.context?.load?.$lazy
  if (typeof spec !== "string") return false
  const target = resolveModule(ctx, spec, file)
  if (!target) return false
  let found = false
  const visit = (node) => {
    if (found) return
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === "slot" &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text === "identity"
    )
      found = true
    else ts.forEachChild(node, visit)
  }
  visit(ctx.ast(target))
  return found
}

/** A module's `tools.load` file exports its family as `toolFamily`. */
function toolsExportErrors(ctx, file, manifest) {
  const spec = manifest.tools?.load?.$lazy
  if (typeof spec !== "string") return []
  const target = resolveModule(ctx, spec, file)
  return target && !exportsName(ctx.ast(target), "toolFamily")
    ? [`tools: ${target} exports no \`toolFamily\``]
    : []
}

/** The sidecar's per-call list, which no manifest can extend (ADR-0250 §14 amendment). */
export const SIDECAR_PER_CALL_FILE = "sidecar/src/policy/permission/ladder.ts"
const SIDECAR_PER_CALL_LIST = "PER_CALL_PLUGIN_TOOL_NAMES"

/**
 * The string literals of `export const <name> … = new Set([ … ])` in `file`,
 * or undefined when the file or the set is absent (a fixture tree) or holds
 * anything but string literals.
 */
export function constStringSet(ctx, file, name) {
  if (!ctx.exists(file)) return undefined
  const sourceFile = ctx.ast(file)
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const init = declaration.initializer && unwrap(declaration.initializer)
      if (
        !init ||
        !ts.isNewExpression(init) ||
        !ts.isIdentifier(init.expression) ||
        init.expression.text !== "Set" ||
        init.arguments?.length !== 1
      )
        return undefined
      const list = unwrap(init.arguments[0])
      if (!ts.isArrayLiteralExpression(list)) return undefined
      const names = list.elements.map((element) =>
        ts.isStringLiteralLike(element) ? element.text : null
      )
      return names.includes(null) ? undefined : new Set(names)
    }
  }
  return undefined
}

/**
 * G5: every tool a manifest declares `consent: "per-call"` is in the sidecar's
 * `PER_CALL_PLUGIN_TOOL_NAMES`. The sidecar is a separate project and cannot
 * read the registry, and it trusts a manifest entry's `requiresApproval` only
 * for names on that list, so a per-call tool missing from it would be asked
 * once and then remembered.
 */
export function perCallToolErrors(ctx, manifests) {
  const declared = []
  for (const [, { file, manifest }] of manifests.host) {
    const declare = manifest.tools?.declare
    if (!declare || typeof declare !== "object") continue
    for (const [name, declaration] of Object.entries(declare))
      if (declaration?.consent === "per-call") declared.push({ file, name })
  }
  if (declared.length === 0 || !ctx.exists(SIDECAR_PER_CALL_FILE)) return []
  const listed = constStringSet(ctx, SIDECAR_PER_CALL_FILE, SIDECAR_PER_CALL_LIST)
  if (!listed)
    return [`${SIDECAR_PER_CALL_FILE}: ${SIDECAR_PER_CALL_LIST} is not a Set of string literals`]
  return declared
    .filter(({ name }) => !listed.has(name))
    .map(
      ({ file, name }) =>
        `${file}: per-call tool ${name} is missing from ${SIDECAR_PER_CALL_LIST} (${SIDECAR_PER_CALL_FILE})`
    )
}

/** Whether a file defines a code-owned prompt: it calls `definePrompt(…)`. */
export function definesPrompt(sourceFile) {
  let found = false
  const visit = (node) => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "definePrompt"
    )
      found = true
    else ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/**
 * Prompts (G4). A manifest module that defines a code-owned prompt
 * contributes its prompts through `prompts`, the prompt catalog's only route
 * to a module: the catalog (kernel) may not import it. Test files do not count.
 */
export function promptContributionErrors(ctx, manifests, owners) {
  const definers = new Map()
  for (const [file, { owner }] of owners) {
    if (!manifests.host.has(owner) || manifestKind(file) || /\.test\.tsx?$/.test(file)) continue
    if (!definers.has(owner) && definesPrompt(ctx.ast(file))) definers.set(owner, file)
  }
  const errors = []
  for (const [id, definer] of [...definers].sort()) {
    const { file, manifest } = manifests.host.get(id)
    if (manifest.prompts === undefined)
      errors.push(
        `G4 ${file}: ${definer} defines a prompt but "${id}" contributes none — list its prompts in a \`prompts\` file`
      )
  }
  return errors
}

/**
 * The port ids a file asks for: `loadPort("…")`, `readPort("…")`, `usePort("…")`,
 * and for a collection port `loadPortCollection("…")` or `readPortCollection("…")`.
 */
export function portsAskedFor(sourceFile) {
  const asked = new Set()
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      PORT_READERS.has(node.expression.text) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      asked.add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return asked
}

const PORT_READERS = new Set([
  "loadPort",
  "readPort",
  "usePort",
  "loadPortCollection",
  "readPortCollection",
])

/**
 * Ports (G4, G5). A manifest module's `requires` names exactly the ports its
 * files ask for (with or without `?`), and a port it requires without `?` has
 * an active provider. A module does not require a port it provides.
 */
export function portErrors(ctx, manifests, owners) {
  const errors = []
  const provided = new Map()
  for (const [id, { manifest }] of manifests.host)
    if (manifest.stage !== "experimental")
      for (const provision of manifest.provides ?? []) provided.set(provision.port, id)
  const asked = new Map()
  for (const [file, { owner }] of owners) {
    if (!manifests.host.has(owner) || manifestKind(file)) continue
    for (const port of portsAskedFor(ctx.ast(file))) {
      if (!asked.has(owner)) asked.set(owner, new Map())
      if (!asked.get(owner).has(port)) asked.get(owner).set(port, file)
    }
  }
  for (const [id, { file, manifest }] of manifests.host) {
    const own = new Set((manifest.provides ?? []).map((provision) => provision.port))
    const required = new Map()
    for (const entry of Array.isArray(manifest.requires) ? manifest.requires : []) {
      if (typeof entry !== "string") continue
      const optional = entry.endsWith("?")
      required.set(optional ? entry.slice(0, -1) : entry, optional)
    }
    const used = asked.get(id) ?? new Map()
    for (const [port, user] of [...used].sort()) {
      if (own.has(port) || required.has(port)) continue
      errors.push(
        `G4 ${file}: ${user} asks for port "${port}" but "${id}"'s requires does not name it`
      )
    }
    for (const [port, optional] of [...required].sort()) {
      if (own.has(port)) errors.push(`G4 ${file}: requires port "${port}", which it provides`)
      else if (!used.has(port))
        errors.push(`G4 ${file}: requires port "${port}", which no file of "${id}" asks for`)
      if (!optional && !own.has(port) && !provided.has(port))
        errors.push(
          `G5 ${file}: requires port "${port}" but no active module provides it (mark it "${port}?" if "${id}" copes without)`
        )
    }
  }
  return errors
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
  const entries = (map) =>
    [...map].map(([id, { file, manifest }]) => ({ id, file, value: manifest }))
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

/** The flat `AppSettings` keys a module may claim; the row id is the store's. */
function appSettingsKeys(ctx) {
  const keys = new Set()
  if (!ctx.exists(APP_SETTINGS_FILE)) return keys
  for (const statement of ctx.ast(APP_SETTINGS_FILE).statements)
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === "AppSettings")
      for (const member of statement.members) {
        const name = member.name
        if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text !== "id")
          keys.add(name.text)
      }
  return keys
}

/** Every settings key a manifest claims, with its claimant (the first, when two claim one). */
function settingsClaims(manifests) {
  const claims = new Map()
  for (const [id, { manifest }] of manifests.host)
    for (const key of manifest.settings?.keys ?? []) if (!claims.has(key)) claims.set(key, id)
  return claims
}

/**
 * The names a file uses as settings keys: property reads (`s.ttsRate`),
 * destructuring, object literal keys (`save({ ttsRate })`) and string element
 * access (`settings["ttsRate"]`). Narrower than {@link namesRead}, which also
 * counts every string literal: `settingsAccess` judges files, so a key name in
 * a message or a log line must not read as a use.
 */
export function settingsKeyUses(sourceFile) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text)
    else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      names.add(node.argumentExpression.text)
    else if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) names.add(name.text)
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
    )
      names.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

/**
 * Every `defineSettingsView(...)` call in a file, with how its argument names
 * the keys: `{ manifest: spec }` for `<x>.settings.keys` where `<x>` is the
 * default import from `spec`, `{ other: true }` for anything else.
 */
export function settingsViewCalls(sourceFile) {
  const defaults = new Map()
  for (const statement of sourceFile.statements)
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.name &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    )
      defaults.set(statement.importClause.name.text, statement.moduleSpecifier.text)
  const calls = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineSettingsView"
    ) {
      const arg = node.arguments[0] && unwrap(node.arguments[0])
      const isKeys =
        arg &&
        ts.isPropertyAccessExpression(arg) &&
        arg.name.text === "keys" &&
        ts.isPropertyAccessExpression(arg.expression) &&
        arg.expression.name.text === "settings" &&
        ts.isIdentifier(arg.expression.expression) &&
        defaults.has(arg.expression.expression.text)
      calls.push(
        isKeys ? { manifest: defaults.get(arg.expression.expression.text) } : { other: true }
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return calls
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

/** The calls that return the Dexie database. */
const DB_ACCESSORS = new Set(["getDb", "rawDb"])

/**
 * Tables a file accesses directly: `db.<table>` (also `x.db.<table>`),
 * `getDb().<table>` (also `rawDb()`) and `.table("<table>")`, the spellings the
 * Dexie layer uses. Narrower than
 * {@link namesRead}, because a table accessed from the wrong module is a
 * violation, and an unrelated `foo.sessions` must not read as one.
 */
export function tableAccesses(sourceFile) {
  const names = new Set()
  const isDb = (node) =>
    (ts.isIdentifier(node) && node.text === "db") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "db") ||
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      DB_ACCESSORS.has(node.expression.text))
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && isDb(node.expression)) names.add(node.name.text)
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "table" &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      names.add(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

/** Every core table a manifest claims, with its claimant (the first, when two claim one). */
function tableClaims(manifests) {
  const claims = new Map()
  for (const [id, { manifest }] of manifests.host)
    for (const table of manifest.tables ?? []) if (!claims.has(table)) claims.set(table, id)
  return claims
}

/**
 * G4: what each manifest declares equals what its files do. `actualDeps` maps a
 * module to the modules its files import (`types/**` aside).
 */
export function declaredErrors(
  ctx,
  manifests,
  registry,
  owners,
  actualDeps,
  data = { imports: new Map(), users: new Map() }
) {
  const errors = []
  const filesOf = new Map()
  for (const [file, { owner }] of owners) {
    if (!filesOf.has(owner)) filesOf.set(owner, [])
    filesOf.get(owner).push(file)
  }
  const tables = new Set(coreTableNames(ctx))
  const keys = appSettingsKeys(ctx)
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
    const packages = new Set()
    for (const owned of filesOf.get(id) ?? [])
      if (!manifestKind(owned)) {
        for (const name of namesRead(ctx.ast(owned))) read.add(name)
        if (declaredKeys.length)
          for (const record of importsIn(ctx, owned)) {
            const match = /^@cognia\/([^/]+)/.exec(record.spec)
            if (match) packages.add(match[1])
          }
      }
    // A key the module's engine package reads for it (`@cognia/tts` reading
    // the voice of a provider the settings page lists generically) is
    // touched too. Packages hold no tables, so tables are not looked up there.
    const keysRead = new Set(read)
    for (const name of packages)
      for (const source of ctx.files([`packages/${name}/src`]))
        for (const used of namesRead(ctx.ast(source))) keysRead.add(used)
    // A table the module reaches through a shared data module it imports is
    // touched too: the accessor stays in the data layer while others use it.
    for (const dataModule of data.imports.get(id) ?? [])
      for (const name of tableAccesses(ctx.ast(dataModule))) read.add(name)
    const check = (kind, name, known, catalog, touched = read) => {
      if (known.size && !known.has(name))
        errors.push(`G4 ${file}: ${kind} "${name}" is not in ${catalog}`)
      const first = claims[kind].get(name)
      if (first && first !== id)
        errors.push(`G4 ${file}: ${kind} "${name}" is also claimed by "${first}"`)
      else claims[kind].set(name, id)
      if (!touched.has(name))
        errors.push(`G4 ${file}: declares ${kind} "${name}", which no file of "${id}" touches`)
    }
    for (const table of declaredTables)
      check("table", table, tables, `CORE_TABLE_NAMES (${TABLE_CATALOG_FILE})`)
    for (const key of declaredKeys)
      check("settings key", key, keys, `AppSettings (${APP_SETTINGS_FILE})`, keysRead)
    if (manifest.settings) {
      const section = manifest.settings.section ?? id
      const sections = manifests.ui.get(id)?.manifest.settingsSections ?? []
      if (!sections.some((entry) => entry.id === section))
        errors.push(
          `G4 ${file}: settings keys belong to section "${section}", which components/${id}/module.ui.ts does not declare in \`settingsSections\``
        )
    }
  }
  // A settings view writes its module's own keys: only a manifest module
  // defines one, over its own manifest's `settings.keys`.
  for (const [owned, { owner }] of owners) {
    if (owned === SETTINGS_VIEW_FILE || manifestKind(owned)) continue
    const calls = settingsViewCalls(ctx.ast(owned))
    if (!calls.length) continue
    const own = manifests.host.get(owner)
    for (const call of calls) {
      const target = call.manifest && resolveModule(ctx, call.manifest, owned)
      if (!own?.manifest.settings)
        errors.push(
          `G4 ${owned}: defines a settings view, but "${owner}" declares no \`settings.keys\` in a manifest`
        )
      else if (target !== own.file)
        errors.push(
          `G4 ${owned}: defineSettingsView takes its own manifest's keys, \`defineSettingsView(<module>.settings.keys)\` with <module> imported from ${own.file}`
        )
    }
  }
  // A data module only one manifest module uses moves with its owner.
  for (const [dataModule, users] of data.users) {
    if (users.size !== 1) continue
    const [user] = users
    const manifest = manifests.host.get(user)
    if (manifest)
      errors.push(
        `G4 ${dataModule}: only "${user}" uses this data module; claim it in ${manifest.file} \`owns\` (or move it under lib/${user}/)`
      )
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
    ...portErrors(ctx, manifests, owners),
    ...promptContributionErrors(ctx, manifests, owners),
    ...perCallToolErrors(ctx, manifests),
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
  // Files that reach the settings directly: the store, a view or the data module.
  const settingsReaders = new Set()
  // Direct table access per file, and who imports each data-layer module.
  const accessByFile = new Map()
  const dataUsers = new Map()
  const dataImports = new Map()
  for (const file of files) {
    const source = owners.get(file)
    if (source) {
      const accessed = tableAccesses(ctx.ast(file))
      if (accessed.size) accessByFile.set(file, accessed)
    }
    const framework = frameworkOf(file)
    const catalog = catalogOf(file)
    if (framework && VENDOR_SEGMENT.test(file.slice(framework.path.length)))
      vendorNeutral.push(`${file} :: vendor file`)
    for (const record of importsIn(ctx, file)) {
      const target = resolveModule(ctx, record.spec, file)
      if (!target) continue
      if (SETTINGS_STORE_ENTRIES.includes(target) && !file.startsWith("stores/settings/"))
        settingsImporters.add(file)
      if (
        SETTINGS_ACCESS_ENTRIES.includes(target) &&
        !file.startsWith("stores/settings/") &&
        file !== SETTINGS_DATA_FILE
      )
        settingsReaders.add(file)
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
      if (
        destination?.owner === DATA_LAYER &&
        target.startsWith(DATA_LAYER_PATH) &&
        target !== file
      ) {
        if (!dataUsers.has(target)) dataUsers.set(target, new Set())
        dataUsers.get(target).add(source.owner)
        if (!dataImports.has(source.owner)) dataImports.set(source.owner, new Set())
        dataImports.get(source.owner).add(target)
      }
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

  errors.push(
    ...declaredErrors(ctx, manifests, registry, owners, actualDeps, {
      imports: dataImports,
      users: dataUsers,
    })
  )

  // G4: a claimed table is accessed directly only by its own module. The data
  // layer, the kernel and the shells are not judged; another module is.
  const claims = tableClaims(manifests)
  const tableAccess = []
  for (const [file, accessed] of accessByFile) {
    const source = owners.get(file)
    if (source.class !== "module") continue
    for (const table of accessed) {
      const claimant = claims.get(table)
      if (claimant && claimant !== source.owner) tableAccess.push(`${file} -> ${table}`)
    }
  }
  // G4: a claimed settings key is named only by its own module among the
  // files that reach the settings directly. Everyone else is judged, kernel
  // and shells included: the key belongs behind the owner's api.
  const keyClaims = settingsClaims(manifests)
  const settingsAccess = []
  if (keyClaims.size)
    for (const file of settingsReaders) {
      const owner = owners.get(file)?.owner
      for (const key of settingsKeyUses(ctx.ast(file))) {
        const claimant = keyClaims.get(key)
        if (claimant && claimant !== owner) settingsAccess.push(`${file} -> ${key}`)
      }
    }
  const coreTables = coreTableNames(ctx)

  const classCount = (cls) => [...registry.values()].filter((entry) => entry.class === cls).length
  return {
    errors,
    warnings: manifests.warnings,
    owners,
    registry,
    measures: {
      direction: sorted(direction),
      publicApi: sorted([...new Set(publicApi)]),
      tableAccess: sorted(tableAccess),
      settingsAccess: sorted(settingsAccess),
      cycles: { largestLibComponent: largestComponent(libGraph).largest },
      size: {
        modules: classCount("module"),
        experimental: [...manifests.host.values()].filter(
          ({ manifest }) => manifest.stage === "experimental"
        ).length,
        tables: coreTables.length,
        unclaimedTables: coreTables.filter((table) => !claims.has(table)).length,
        // A data module only other data modules use stays where it is.
        singleUserDataModules: [...dataUsers.values()].filter(
          (users) => users.size === 1 && !users.has(DATA_LAYER)
        ).length,
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
  "Measures of the module gate (scripts/gates/check-modules.mjs, ADR-0250 §14). Every one may only fall: `direction` (G2, blocking since M1), `publicApi` (G3, blocking since M1), `tableAccess` (G4, blocking since M2), `settingsAccess` (G4, blocking since M3), `cycles` (G6), `size` (G7) and `vendorNeutral` (G8). scripts/gates/check-baseline-growth.mjs compares this file against the merge base. Rewrite it with `--write-baseline` only after paying a measure down."

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
  const tableAccess = listDelta("tableAccess", measures.tableAccess, baseline.tableAccess)
  if (tableAccess.added.length)
    failures.push(
      `G4 table access: ${tableAccess.added.length} new direct access(es) to a table another module claims — go through that module's api, or claim the table where it belongs\n${tableAccess.added
        .map((item) => `  ${item}`)
        .join("\n")}`
    )
  const settingsAccess = listDelta(
    "settingsAccess",
    measures.settingsAccess ?? [],
    baseline.settingsAccess
  )
  if (settingsAccess.added.length)
    failures.push(
      `G4 settings access: ${settingsAccess.added.length} new use(s) of a settings key another module claims — read it through that module's api (its settings view), or claim the key where it belongs\n${settingsAccess.added
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
  for (const delta of [direction, publicApi, tableAccess, settingsAccess, vendor])
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
    tableAccess: measures.tableAccess,
    settingsAccess: measures.settingsAccess,
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
