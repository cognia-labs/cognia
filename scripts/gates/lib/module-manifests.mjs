/**
 * Feature module manifests as data (ADR-0250 §14): reading, shape checks and
 * the generated registries.
 *
 * Shared by the module gate (`scripts/gates/check-modules.mjs`), which checks
 * every manifest and that the generated registries are current (G5), and by
 * the generator (`scripts/build/gen-module-registry.mjs`), which writes them.
 * One reader and one renderer, so the gate and the generator can never
 * disagree about what a manifest says or what the registry holds.
 *
 * The schema itself is `lib/modules/manifest-types.ts`; the field lists here
 * are pinned to it by `scripts/gates/check-modules.test.mjs`.
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import ts from "typescript"

export const DEFINE_MODULE = "@/lib/modules/define"

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
  "nav",
  "prompts",
  "flags",
  "messages",
]
/** Top-level fields of `UiModuleManifest`. */
export const UI_FIELDS = ["id", "slots", "settingsSections", "effects"]
/** Fields of `ModuleSlashCommand`. */
export const SLASH_COMMAND_FIELDS = [
  "name",
  "description",
  "category",
  "argumentHint",
  "argumentOptions",
  "load",
]
/** Fields of `ModuleSettingsSection`. */
export const SETTINGS_SECTION_FIELDS = [
  "id",
  "group",
  "icon",
  "label",
  "description",
  "after",
  "requires",
  "profiles",
  "layout",
  "keywords",
  "load",
]
/** Fields of `ModuleNavEntry`. */
export const NAV_ENTRY_FIELDS = [
  "id",
  "route",
  "label",
  "aliases",
  "icon",
  "spotIcon",
  "group",
  "category",
  "after",
  "goMenuAfter",
  "desktopOnly",
  "hostOperationGated",
  "fullViewport",
  "mobileShortcut",
]
/** Fields of `ModuleNavEntry.mobileShortcut`. */
export const MOBILE_SHORTCUT_FIELDS = ["after"]
/** `SidebarNavMeta.group` and `SidebarNavCategory` (`types/shell/sidebar.ts`). */
export const NAV_GROUPS = ["feature", "auxiliary"]
export const NAV_CATEGORIES = ["explore", "agents", "spaces", "insights", "system", "you"]
export const KINDS = ["kernel", "module"]
export const STAGES = ["kernel", "stable", "beta", "experimental", "deprecated"]

/** Where the generator writes. Gitignored: a committed aggregate would conflict in a shared tree. */
export const GENERATED_HOST = "lib/modules/generated/host.ts"
export const GENERATED_UI = "components/modules/generated/ui.ts"
export const GENERATED_FILES = [GENERATED_HOST, GENERATED_UI]
export const GENERATOR = "scripts/build/gen-module-registry.mjs"

const HOST_MANIFEST = /^lib\/([^/]+)\/module\.ts$/
const UI_MANIFEST = /^components\/([^/]+)\/module\.ui\.ts$/
const SLASH_NAME = /^[a-z][a-z0-9-]*$/
const SECTION_ID = /^[a-z][a-zA-Z0-9-]*$/
const NAV_ID = /^[a-z][a-z0-9-]*$/
const NAV_ROUTE = /^\/[a-z0-9][a-z0-9/-]*$/

// ------------------------------------------------------------------ read

export function unwrap(node) {
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
 * and `export default helper({ … })`, nothing else. `ctx` is the counter's
 * disk adapter (`scripts/gates/convergence/counter.mjs`).
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

/** Every lazy entry in a manifest value, with where it sits. */
export function lazyEntries(value, at = "manifest", out = []) {
  if (Array.isArray(value))
    value.forEach((item, index) => lazyEntries(item, `${at}[${index}]`, out))
  else if (value && typeof value === "object") {
    if (typeof value.$lazy === "string") out.push({ at, spec: value.$lazy })
    else for (const [key, item] of Object.entries(value)) lazyEntries(item, `${at}.${key}`, out)
  }
  return out
}

// ----------------------------------------------------------------- shape

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
const isLazy = (value) => !!value && typeof value === "object" && typeof value.$lazy === "string"
const isText = (value) => typeof value === "string" && value.trim() !== ""

function unknownFields(entry, fields, at) {
  return Object.keys(entry)
    .filter((key) => !fields.includes(key))
    .map((key) => `${at}: unknown field "${key}"`)
}

function slashCommandErrors(commands) {
  if (!Array.isArray(commands)) return ["slashCommands is a list of commands"]
  const errors = []
  const names = new Set()
  commands.forEach((command, index) => {
    const at = `slashCommands[${index}]`
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      errors.push(`${at} is not an object`)
      return
    }
    errors.push(...unknownFields(command, SLASH_COMMAND_FIELDS, at))
    if (!SLASH_NAME.test(command.name ?? ""))
      errors.push(`${at}.name is lower-case kebab without the slash`)
    else if (names.has(command.name)) errors.push(`${at}.name "${command.name}" is listed twice`)
    names.add(command.name)
    if (!isText(command.description)) errors.push(`${at}.description is required`)
    for (const field of ["category", "argumentHint"])
      if (command[field] !== undefined && !isText(command[field]))
        errors.push(`${at}.${field} is text`)
    if (command.argumentOptions !== undefined && !isStringArray(command.argumentOptions))
      errors.push(`${at}.argumentOptions is a list of strings`)
    if (!isLazy(command.load)) errors.push(`${at}.load is a lazy entry \`() => import("…")\``)
  })
  return errors
}

function settingsSectionErrors(sections, iconNames) {
  if (!Array.isArray(sections)) return ["settingsSections is a list of sections"]
  const errors = []
  const ids = new Set()
  sections.forEach((section, index) => {
    const at = `settingsSections[${index}]`
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      errors.push(`${at} is not an object`)
      return
    }
    errors.push(...unknownFields(section, SETTINGS_SECTION_FIELDS, at))
    if (!SECTION_ID.test(section.id ?? "")) errors.push(`${at}.id is a \`?section=\` value`)
    else if (ids.has(section.id)) errors.push(`${at}.id "${section.id}" is listed twice`)
    ids.add(section.id)
    for (const field of ["group", "icon", "label", "description"])
      if (!isText(section[field])) errors.push(`${at}.${field} is required`)
    if (isText(section.icon) && iconNames && !iconNames.has(section.icon))
      errors.push(`${at}.icon "${section.icon}" is not a Lucide icon name (e.g. "Users")`)
    for (const field of ["label", "description"])
      if (isText(section[field]) && !section[field].includes("."))
        errors.push(`${at}.${field} is a full i18n key ("<namespace>.<key>")`)
    if (section.after !== undefined && !isText(section.after)) errors.push(`${at}.after is text`)
    for (const field of ["requires", "profiles", "keywords"])
      if (section[field] !== undefined && !isStringArray(section[field]))
        errors.push(`${at}.${field} is a list of strings`)
    if (section.layout !== undefined && section.layout !== "fill")
      errors.push(`${at}.layout is "fill" or absent`)
    if (!isLazy(section.load)) errors.push(`${at}.load is a lazy entry \`() => import("…")\``)
  })
  return errors
}

function navErrors(entries, vocabulary) {
  if (!Array.isArray(entries)) return ["nav is a list of destinations"]
  const { iconNames, spotIconNames } = vocabulary
  const errors = []
  const ids = new Set()
  const icon = (value, at) => {
    if (!isText(value)) errors.push(`${at} is required`)
    else if (iconNames && !iconNames.has(value))
      errors.push(`${at} "${value}" is not a Lucide icon name (e.g. "Users")`)
  }
  entries.forEach((entry, index) => {
    const at = `nav[${index}]`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at} is not an object`)
      return
    }
    errors.push(...unknownFields(entry, NAV_ENTRY_FIELDS, at))
    if (!NAV_ID.test(entry.id ?? "")) errors.push(`${at}.id is lower-case kebab`)
    else if (ids.has(entry.id)) errors.push(`${at}.id "${entry.id}" is listed twice`)
    ids.add(entry.id)
    if (!NAV_ROUTE.test(entry.route ?? "")) errors.push(`${at}.route is a top-level route ("/x")`)
    for (const field of ["label", "aliases"]) {
      if (field === "label" && !isText(entry.label)) errors.push(`${at}.label is required`)
      else if (entry[field] !== undefined && !(isText(entry[field]) && entry[field].includes(".")))
        errors.push(`${at}.${field} is a full i18n key ("<namespace>.<key>")`)
    }
    icon(entry.icon, `${at}.icon`)
    if (!isText(entry.spotIcon)) errors.push(`${at}.spotIcon is required`)
    else if (spotIconNames && !spotIconNames.has(entry.spotIcon))
      errors.push(`${at}.spotIcon "${entry.spotIcon}" is not a MobileSpotIconName`)
    if (!NAV_GROUPS.includes(entry.group))
      errors.push(`${at}.group is one of ${NAV_GROUPS.join(", ")}`)
    if (!NAV_CATEGORIES.includes(entry.category))
      errors.push(`${at}.category is one of ${NAV_CATEGORIES.join(", ")}`)
    for (const field of ["after", "goMenuAfter"])
      if (entry[field] !== undefined && !isText(entry[field])) errors.push(`${at}.${field} is text`)
    for (const field of ["desktopOnly", "hostOperationGated", "fullViewport"])
      if (entry[field] !== undefined && typeof entry[field] !== "boolean")
        errors.push(`${at}.${field} is true or false`)
    const shortcut = entry.mobileShortcut
    if (shortcut !== undefined) {
      if (!shortcut || typeof shortcut !== "object" || Array.isArray(shortcut)) {
        errors.push(`${at}.mobileShortcut is an object`)
      } else {
        errors.push(...unknownFields(shortcut, MOBILE_SHORTCUT_FIELDS, `${at}.mobileShortcut`))
        if (shortcut.after !== undefined && !isText(shortcut.after))
          errors.push(`${at}.mobileShortcut.after is text`)
      }
    }
  })
  return errors
}

/** The module's own slots: each a canonical extension point holding a lazy entry. */
function slotErrors(slots, extensionPoints) {
  if (!slots || typeof slots !== "object" || Array.isArray(slots))
    return ["slots maps canonical extension points to lazy entries"]
  const errors = []
  for (const [point, entry] of Object.entries(slots)) {
    if (extensionPoints && !extensionPoints.has(point))
      errors.push(`slots["${point}"] is not a CANONICAL_EXTENSION_POINTS entry`)
    if (!isLazy(entry)) errors.push(`slots["${point}"] is a lazy entry \`() => import("…")\``)
  }
  return errors
}

/**
 * `vocabulary` holds the name sets the caller can read from the tree:
 * `iconNames` (the Lucide catalog), `spotIconNames` (`MobileSpotIconName`) and
 * `extensionPoints` (`CANONICAL_EXTENSION_POINTS`). An absent set is not checked.
 */
export function validateHostManifest(manifest, id, vocabulary = {}) {
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
  if (manifest.searchProviders !== undefined && !isLazy(manifest.searchProviders))
    errors.push('searchProviders is a lazy entry `() => import("…")`')
  if (manifest.slashCommands !== undefined)
    errors.push(...slashCommandErrors(manifest.slashCommands))
  if (manifest.nav !== undefined) errors.push(...navErrors(manifest.nav, vocabulary))
  if (manifest.messages !== undefined && !isText(manifest.messages))
    errors.push("messages is an i18n namespace")
  return errors
}

/** `vocabulary`: as for {@link validateHostManifest}. */
export function validateUiManifest(manifest, id, vocabulary = {}) {
  const errors = []
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return ["manifest is not an object"]
  for (const key of Object.keys(manifest))
    if (!UI_FIELDS.includes(key)) errors.push(`unknown field "${key}"`)
  if (manifest.id !== id) errors.push(`id "${manifest.id}" must equal its directory "${id}"`)
  if (manifest.settingsSections !== undefined)
    errors.push(...settingsSectionErrors(manifest.settingsSections, vocabulary.iconNames))
  if (manifest.slots !== undefined)
    errors.push(...slotErrors(manifest.slots, vocabulary.extensionPoints))
  return errors
}

// -------------------------------------------------------------- discover

/** Which manifest a path is, if any. */
export function manifestKind(file) {
  const host = HOST_MANIFEST.exec(file)
  if (host) return { layer: "host", id: host[1], helper: "defineHostModule" }
  const ui = UI_MANIFEST.exec(file)
  if (ui) return { layer: "ui", id: ui[1], helper: "defineUiModule" }
  return null
}

/** Manifest files on disk, without walking the whole tree. */
export function findManifestFiles(root) {
  const found = []
  for (const [dir, name] of [
    ["lib", "module.ts"],
    ["components", "module.ui.ts"],
  ]) {
    if (!existsSync(join(root, dir))) continue
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }))
      if (entry.isDirectory() && existsSync(join(root, dir, entry.name, name)))
        found.push(`${dir}/${entry.name}/${name}`)
  }
  return found.sort()
}

// ---------------------------------------------------------------- render

const HEADER = (source) =>
  [
    `// Generated by ${GENERATOR} from every ${source} (ADR-0250 §14).`,
    "// Not committed and never edited by hand: change a manifest, then rerun the",
    "// generator (predev, prebuild, postinstall, Jest and typecheck run it too).",
  ].join("\n")

function identifier(id, suffix) {
  const camel = id.replace(/[-.]+([a-zA-Z0-9])/g, (_, next) => next.toUpperCase())
  return `${camel}${suffix}`
}

function renderList(constName, entries, suffix) {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id))
  const imports = sorted.map(
    ({ id, file }) => `import ${identifier(id, suffix)} from "@/${file.replace(/\.ts$/, "")}"`
  )
  const names = sorted.map(({ id }) => identifier(id, suffix))
  return [
    ...(imports.length ? [...imports, ""] : []),
    `export const ${constName} = [${names.join(", ")}] as const`,
  ].join("\n")
}

/**
 * The generated registries for a set of manifests, keyed by path. Both hold
 * the manifests themselves — data plus lazy entries — so importing a registry
 * loads no feature code.
 *
 * `host.ts` is host-neutral: every field it carries in M1 (search providers,
 * slash commands) applies on every host. M2 splits it into
 * `{brain,desktop,mobile}.ts` with `runtimes.adapters`, the first per-host field.
 */
export function renderRegistries({ host, ui }) {
  return {
    [GENERATED_HOST]: `${HEADER("lib/<id>/module.ts")}\n//\n// Host-neutral until phase M2 splits it per host.\n\n${renderList("HOST_MODULES", host, "Module")}\n`,
    [GENERATED_UI]: `${HEADER("components/<id>/module.ui.ts")}\n\n${renderList("UI_MODULES", ui, "Ui")}\n`,
  }
}
