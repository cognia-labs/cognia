import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import {
  BASELINE_FILE,
  HOST_FIELDS,
  OWNERSHIP_FILE,
  SETTINGS_SECTION_FIELDS,
  SLASH_COMMAND_FIELDS,
  UI_FIELDS,
  codeownerHandles,
  compare,
  computeModules,
  largestComponent,
  main,
  readManifest,
  settingsKeyUses,
  settingsViewCalls,
  tableAccesses,
  validateHostManifest,
  validateUiManifest,
  SIDECAR_PER_CALL_FILE,
} from "./check-modules.mjs"
import {
  BRAIN_PROFILES,
  EFFECT_FIELDS,
  GENERATED_CAPABILITIES,
  GENERATED_CONTEXT,
  GENERATED_WORKFLOW_NODES,
  GENERATED_BUILTIN_SKILLS,
  GENERATED_HOST,
  GENERATED_TASK_EXECUTORS,
  GENERATED_PROMPTS,
  GENERATED_TOOLS,
  GENERATED_UI,
  MODULE_HOSTS,
  PORT_PROVISION_FIELDS,
  RUNTIME_BOOTS,
  RUNTIME_FIELDS,
  TOOL_CONSENTS,
  TOOL_DECLARATION_FIELDS,
  TOOL_EFFECTS,
  declaredPorts,
  renderRegistries,
} from "./lib/module-manifests.mjs"
import { createContext } from "./convergence/counter.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

function fixture(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "modules-gate-")))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(file)), { recursive: true })
    writeFileSync(join(root, file), typeof content === "string" ? content : JSON.stringify(content))
  }
  return root
}

const ownership = (subsystems, paths = []) => ({
  subsystems: Object.fromEntries(
    Object.entries(subsystems).map(([key, cls]) => [key, { class: cls }])
  ),
  paths,
})

const silent = { log() {}, error() {} }

function run(files) {
  const root = fixture(files)
  try {
    return computeModules(createContext(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ manifests

function manifestFrom(source, helper = "defineHostModule") {
  const root = fixture({ "lib/x/module.ts": source })
  try {
    return readManifest(createContext(root), "lib/x/module.ts", helper)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a data-only manifest reads as data, with lazy entries marked", () => {
  const { value, errors } = manifestFrom(`
import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({
  id: "x",
  kind: "module",
  stage: "beta",
  dependsOn: ["chat"],
  flags: { a: { default: false } },
  prompts: () => import("./prompts"),
} as const)
`)
  assert.deepEqual(errors, [])
  assert.deepEqual(value, {
    id: "x",
    kind: "module",
    stage: "beta",
    dependsOn: ["chat"],
    flags: { a: { default: false } },
    prompts: { $lazy: "./prompts" },
  })
})

test("a manifest that would run code at import is refused", () => {
  const { errors } = manifestFrom(`
import { defineHostModule } from "@/lib/modules/define"
import { DEFAULTS } from "./defaults"
const extra = 1
export default defineHostModule({ id: "x", kind: "module", stage: "beta", settings: DEFAULTS, owns: [...[]] })
`)
  assert.ok(errors.some((e) => e.includes("imports only { defineHostModule }")))
  assert.ok(errors.some((e) => e.includes("top level holds only")))
  assert.ok(errors.some((e) => e.includes("manifest.settings: not data")))
  assert.ok(errors.some((e) => e.includes("manifest.owns[0]: not data")))
})

test("validateHostManifest names unknown fields and broken identity", () => {
  const errors = validateHostManifest(
    { id: "y", kind: "plugin", stage: "kernel", ownes: [], acceptance: { realSmoke: "passed" } },
    "x"
  )
  assert.ok(errors.includes('unknown field "ownes"'))
  assert.ok(errors.includes('id "y" must equal its directory "x"'))
  assert.ok(errors.some((e) => e.startsWith("kind must be one of")))
  assert.ok(errors.some((e) => e.startsWith('stage "kernel" goes with kind "kernel"')))
  assert.ok(errors.some((e) => e.startsWith("acceptance.realSmoke")))
})

test("the gate's field lists match lib/modules/manifest-types.ts", () => {
  const source = readFileSync(join(REPO_ROOT, "lib/modules/manifest-types.ts"), "utf8")
  const file = ts.createSourceFile("manifest-types.ts", source, ts.ScriptTarget.Latest, true)
  const fields = (name) => {
    const declaration = file.statements.find(
      (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === name
    )
    return declaration.members.map((member) => member.name.text).sort()
  }
  assert.deepEqual([...HOST_FIELDS].sort(), fields("HostModuleManifest"))
  assert.deepEqual([...UI_FIELDS].sort(), fields("UiModuleManifest"))
  assert.deepEqual([...SLASH_COMMAND_FIELDS].sort(), fields("ModuleSlashCommand"))
  assert.deepEqual([...SETTINGS_SECTION_FIELDS].sort(), fields("ModuleSettingsSection"))
  assert.deepEqual([...RUNTIME_FIELDS].sort(), fields("ModuleRuntime"))
  assert.deepEqual([...EFFECT_FIELDS].sort(), fields("ModuleEffect"))
  assert.deepEqual([...PORT_PROVISION_FIELDS].sort(), fields("ModulePortProvision"))
  assert.deepEqual([...TOOL_DECLARATION_FIELDS].sort(), fields("ModuleToolDeclaration"))
  // The string unions the runtime vocabulary mirrors.
  const union = (text, name) =>
    [
      ...new RegExp(`type ${name}\\s*=([^\\n]*(?:\\n\\s*\\|[^\\n]*)*)`)
        .exec(text)[1]
        .matchAll(/"([^"]+)"/g),
    ]
      .map((match) => match[1])
      .sort()
  assert.deepEqual([...MODULE_HOSTS].sort(), union(source, "ModuleHost"))
  assert.deepEqual([...TOOL_CONSENTS].sort(), union(source, "ModuleToolConsent"))
  assert.deepEqual([...TOOL_EFFECTS].sort(), union(source, "ModuleToolEffect"))
  const headless = readFileSync(join(REPO_ROOT, "lib/headless/types.ts"), "utf8")
  assert.deepEqual([...BRAIN_PROFILES].sort(), union(headless, "HeadlessHost"))
  const boot = /type ModuleRuntimeBoot = Extract<[\s\S]*?>/.exec(source)[0]
  assert.deepEqual(
    [...RUNTIME_BOOTS].sort(),
    [...boot.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort()
  )
})

test("codeownerHandles reads every assigned handle and ignores comments", () => {
  const handles = codeownerHandles(
    "# * @nobody\n* @AstroAir @MaxQian888\n/lib/x.ts @team/x # trailing\n"
  )
  assert.deepEqual([...handles].sort(), ["@AstroAir", "@MaxQian888", "@team/x"])
})

// ------------------------------------------------------------ ownership

test("G1: every file needs a known owner, and a stale row is an error", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ chat: "kernel", gone: "module" }),
    "lib/chat/a.ts": "export const a = 1\n",
    "lib/orphan/b.ts": "export const b = 1\n",
  })
  assert.ok(
    result.errors.some((e) => e.startsWith('lib/orphan/b.ts: subsystem "orphan" has no owner'))
  )
  assert.ok(result.errors.some((e) => e.includes('"gone" owns no file')))
})

test("G1: a subsystem with a manifest must leave the table", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ pet: "module", modules: "kernel" }),
    "lib/modules/define.ts": "export const defineHostModule = (m) => m\n",
    "lib/pet/module.ts": `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({ id: "pet", kind: "module", stage: "beta" })
`,
  })
  assert.ok(result.errors.some((e) => e.includes('"pet" has a manifest, so remove its row')))
})

test("G1: a manifest owner must be a CODEOWNERS handle, and a UI manifest needs a host manifest", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    ".github/CODEOWNERS": "* @MaxQian888\n",
    "lib/modules/define.ts": "export const defineHostModule = (m) => m\n",
    "lib/pet/module.ts": `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({ id: "pet", kind: "module", stage: "beta", owner: "@stranger" })
`,
    "components/ghost/module.ui.ts": `import { defineUiModule } from "@/lib/modules/define"
export default defineUiModule({ id: "ghost" })
`,
  })
  assert.ok(result.errors.some((e) => e.includes("owner @stranger is not a handle")))
  assert.ok(
    result.errors.some((e) => e.includes('no host manifest lib/ghost/module.ts declares "ghost"'))
  )
  assert.ok(result.errors.some((e) => e.includes('subsystem "ghost" has no owner')))
})

test("G1: the longest path prefix wins", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ ai: "kernel", eval: "module" }, [
      { prefix: "lib/ai/eval/", owner: "eval", why: "split" },
    ]),
    "lib/ai/core.ts": "export const a = 1\n",
    "lib/ai/eval/run.ts": "export const b = 1\n",
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.owners.get("lib/ai/eval/run.ts").owner, "eval")
  assert.equal(result.owners.get("lib/ai/core.ts").owner, "ai")
})

// ------------------------------------------------------------ direction

test("G2: the kernel importing a module is an edge; types and the reverse are not", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ chat: "kernel", pet: "module", settings: "shell" }),
    "lib/chat/a.ts": `import { p } from "@/lib/pet/p"\nimport type { T } from "@/lib/pet/t"\nexport const a = p\n`,
    "lib/pet/p.ts": `import { a } from "@/lib/chat/a"\nexport const p = 1\n`,
    "lib/pet/t.ts": "export type T = 1\n",
    "lib/pet/s.ts": `import { s } from "@/components/settings/s"\nexport const x = s\n`,
    "components/settings/s.ts": "export const s = 1\n",
    "components/chat/v.ts": `import { p } from "@/lib/pet/p"\nexport const v = p\n`,
  })
  assert.deepEqual(result.measures.direction, ["lib/chat/a.ts -> pet", "lib/pet/s.ts -> settings"])
  assert.equal(result.owners.get("components/chat/v.ts").node, "chat:ui")
})

test("G2: a shell's listed contribution kit is not an edge; an unlisted shell file still is", () => {
  const table = ownership({ pet: "module", settings: "shell" })
  table.subsystems.settings.api = ["components/settings/common/block.tsx"]
  const result = run({
    [OWNERSHIP_FILE]: table,
    "components/pet/section.tsx": `import { Block } from "@/components/settings/common/block"
import { shell } from "@/components/settings/shell"
export const S = [Block, shell]
`,
    "components/settings/common/block.tsx": "export const Block = 1\n",
    "components/settings/shell.tsx": "export const shell = 1\n",
  })
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.measures.direction, ["components/pet/section.tsx -> settings"])
})

test("api files: owned by the row, never foundation's, and a kernel member lists only its UI", () => {
  const table = ownership({ pet: "module", settings: "shell", base: "foundation", chat: "kernel" })
  table.subsystems.pet.api = ["lib/pet/p.ts"]
  table.subsystems.settings.api = ["lib/pet/p.ts"]
  table.subsystems.base.api = ["lib/base/b.ts"]
  table.subsystems.chat.api = ["lib/chat/c.ts", "components/chat/v.tsx"]
  const result = run({
    [OWNERSHIP_FILE]: table,
    "lib/pet/p.ts": "export const p = 1\n",
    "lib/base/b.ts": "export const b = 1\n",
    "lib/chat/c.ts": "export const c = 1\n",
    "components/chat/v.tsx": "export const v = 1\n",
    "components/settings/s.ts": "export const s = 1\n",
  })
  assert.deepEqual(result.errors.sort(), [
    `${OWNERSHIP_FILE}: "base": only a shell, a module or a kernel member's UI lists \`api\` files, as a list`,
    `${OWNERSHIP_FILE}: "chat" lists api file lib/chat/c.ts, which is not in its UI module`,
    `${OWNERSHIP_FILE}: "settings" lists api file lib/pet/p.ts, which it does not own`,
  ])
})

// ------------------------------------------------------------ public API and declarations

const DEFINE = "export const defineHostModule = (m) => m\nexport const defineUiModule = (m) => m\n"
// These fixtures carry no generated registries (G5), so only G3/G4 errors are read.
const declarationErrors = (result) => result.errors.filter((error) => /^G[34] /.test(error))
const hostManifest = (id, fields = "") => `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({ id: "${id}", kind: "module", stage: "beta"${fields ? `, ${fields}` : ""} })
`

test("G3: imports into or out of a manifest module reach only api files or types", () => {
  const table = ownership({ modules: "kernel", pet: "module", twin: "module", chat: "kernel" })
  table.subsystems.pet.api = ["lib/pet/public.ts"]
  const result = run({
    [OWNERSHIP_FILE]: table,
    "lib/modules/define.ts": DEFINE,
    "lib/crew/module.ts": hostManifest(
      "crew",
      'dependsOn: ["pet", "chat"], api: ["lib/crew/api.ts"]'
    ),
    "lib/crew/run.ts": `import { a } from "@/lib/pet/public"
import { b } from "@/lib/pet/private"
import type { T } from "@/types/pet/t"
import { v } from "@/components/chat/v"
export const run = [a, b, v]
`,
    "lib/crew/api.ts": "export const api = 1\n",
    "lib/crew/inner.ts": "export const inner = 1\n",
    "lib/pet/public.ts": "export const a = 1\n",
    "lib/pet/private.ts": "export const b = 1\n",
    "types/pet/t.ts": "export type T = 1\n",
    "components/chat/v.tsx": "export const v = 1\n",
    "lib/twin/use.ts": `import { api } from "@/lib/crew/api"
import { inner } from "@/lib/crew/inner"
import { b } from "@/lib/pet/private"
export const use = [api, inner, b]
`,
  })
  assert.deepEqual(declarationErrors(result), [])
  // twin -> pet is between two table subsystems, so G3 does not judge it yet.
  assert.deepEqual(result.measures.publicApi, [
    "lib/crew/run.ts -> components/chat/v.tsx",
    "lib/crew/run.ts -> lib/pet/private.ts",
    "lib/twin/use.ts -> lib/crew/inner.ts",
  ])
})

test("G3: an api file may forward one module but never be a barrel", () => {
  const table = ownership({ modules: "kernel", pet: "module" })
  table.subsystems.pet.api = ["lib/pet/shim.ts", "lib/pet/index.ts"]
  const result = run({
    [OWNERSHIP_FILE]: table,
    "lib/modules/define.ts": DEFINE,
    "lib/pet/shim.ts": `export * from "./impl"\n`,
    "lib/pet/index.ts": `export * from "./impl"\nexport { b } from "./other"\n`,
    "lib/pet/impl.ts": "export const a = 1\n",
    "lib/pet/other.ts": "export const b = 1\n",
  })
  assert.deepEqual(declarationErrors(result), [
    'G3 lib/pet/index.ts: "pet" lists a barrel as api; list the files it re-exports instead',
  ])
})

test("G4: dependsOn names exactly the modules a manifest's files import", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel", pet: "module", twin: "module", ui: "shell" }),
    "lib/modules/define.ts": DEFINE,
    "lib/crew/module.ts": hostManifest("crew", 'dependsOn: ["twin", "ui"]'),
    "lib/crew/run.ts": `import { p } from "@/lib/pet/p"\nimport type { T } from "@/types/twin/t"\nexport const run = p\n`,
    "lib/pet/p.ts": "export const p = 1\n",
    "types/twin/t.ts": "export type T = 1\n",
    "lib/twin/x.ts": "export const x = 1\n",
    "components/ui/s.tsx": "export const s = 1\n",
  })
  assert.deepEqual(declarationErrors(result), [
    'G4 lib/crew/module.ts: dependsOn names "twin", which no file of "crew" imports',
    'G4 lib/crew/module.ts: dependsOn names "ui", a shell; only modules are depended on',
    'G4 lib/crew/module.ts: "crew" imports module "pet" but its dependsOn does not name it',
  ])
})

const APP_SETTINGS = `export interface AppSettings {\n  id: "singleton"\n  crewMode?: string\n  petName?: string\n  voice?: string\n}\n`
const uiWithSection = (id, section = id) =>
  `import { defineUiModule } from "@/lib/modules/define"\nexport default defineUiModule({ id: "${id}", settingsSections: [{ id: "${section}" }] })\n`

test("G4: declared tables and settings keys exist, are touched, and have one owner", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({
      modules: "kernel",
      "data-governance": "foundation",
      "settings-store": "kernel",
    }),
    "lib/modules/define.ts": DEFINE,
    "lib/data-governance/table-catalog.ts": `export const CORE_TABLE_NAMES = ["crews", "notes", "pets"] as const\n`,
    "packages/plugin-contract/src/types/agent-config/index.ts": APP_SETTINGS,
    "lib/crew/module.ts": hostManifest(
      "crew",
      'tables: ["crews", "notes", "ghosts"], settings: { keys: ["crewMode", "petName", "nope", "id"] }'
    ),
    "components/crew/module.ui.ts": uiWithSection("crew"),
    "lib/crew/run.ts": `export const run = (db, settings) => [db.crews.toArray(), db.table("notes"), settings.crewMode, settings.id]\n`,
    "lib/pet/module.ts": hostManifest(
      "pet",
      'tables: ["crews"], settings: { keys: ["petName"], section: "den" }'
    ),
    "components/pet/module.ui.ts": uiWithSection("pet"),
    "lib/pet/run.ts": `export const run = (db, { petName }) => [db.crews, petName]\n`,
  })
  assert.deepEqual(declarationErrors(result).sort(), [
    'G4 lib/crew/module.ts: declares settings key "nope", which no file of "crew" touches',
    'G4 lib/crew/module.ts: declares settings key "petName", which no file of "crew" touches',
    'G4 lib/crew/module.ts: declares table "ghosts", which no file of "crew" touches',
    'G4 lib/crew/module.ts: settings key "id" is not in AppSettings (packages/plugin-contract/src/types/agent-config/index.ts)',
    'G4 lib/crew/module.ts: settings key "nope" is not in AppSettings (packages/plugin-contract/src/types/agent-config/index.ts)',
    'G4 lib/crew/module.ts: table "ghosts" is not in CORE_TABLE_NAMES (lib/data-governance/table-catalog.ts)',
    'G4 lib/pet/module.ts: settings key "petName" is also claimed by "crew"',
    'G4 lib/pet/module.ts: settings keys belong to section "den", which components/pet/module.ui.ts does not declare in `settingsSections`',
    'G4 lib/pet/module.ts: table "crews" is also claimed by "crew"',
  ])
})

test("G4: a key the module's engine package reads counts as touched", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "packages/plugin-contract/src/types/agent-config/index.ts": APP_SETTINGS,
    "lib/voice/module.ts": hostManifest("voice", 'settings: { keys: ["voice", "crewMode"] }'),
    "components/voice/module.ui.ts": uiWithSection("voice"),
    "lib/voice/play.ts": `import { speak } from "@cognia/speaker/engine"\nexport const play = speak\n`,
    "packages/speaker/src/engine.ts": `export const speak = (settings) => settings.voice\n`,
  })
  assert.deepEqual(declarationErrors(result), [
    'G4 lib/voice/module.ts: declares settings key "crewMode", which no file of "voice" touches',
  ])
})

test("G4: only a manifest module defines a settings view, over its own manifest's keys", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel", "settings-store": "kernel", chat: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "packages/plugin-contract/src/types/agent-config/index.ts": APP_SETTINGS,
    "stores/settings/view.ts": "export const defineSettingsView = (keys) => keys\n",
    "lib/crew/module.ts": hostManifest("crew", 'settings: { keys: ["crewMode"] }'),
    "components/crew/module.ui.ts": uiWithSection("crew"),
    "lib/crew/settings.ts": `import { defineSettingsView } from "@/stores/settings/view"
import crewModule from "./module"
export const crewSettingsView = defineSettingsView(crewModule.settings.keys)
export const mode = (s) => s.crewMode
`,
    "lib/crew/other.ts": `import { defineSettingsView } from "@/stores/settings/view"
export const view = defineSettingsView(["crewMode"])
`,
    "lib/pet/module.ts": hostManifest("pet"),
    "lib/pet/settings.ts": `import { defineSettingsView } from "@/stores/settings/view"
import crewModule from "@/lib/crew/module"
export const view = defineSettingsView(crewModule.settings.keys)
`,
    "lib/chat/settings.ts": `import { defineSettingsView } from "@/stores/settings/view"
export const view = defineSettingsView(["petName"])
`,
  })
  assert.deepEqual(
    declarationErrors(result)
      .filter((e) => e.includes("settings view") || e.includes("defineSettingsView"))
      .sort(),
    [
      'G4 lib/chat/settings.ts: defines a settings view, but "chat" declares no `settings.keys` in a manifest',
      "G4 lib/crew/other.ts: defineSettingsView takes its own manifest's keys, `defineSettingsView(<module>.settings.keys)` with <module> imported from lib/crew/module.ts",
      'G4 lib/pet/settings.ts: defines a settings view, but "pet" declares no `settings.keys` in a manifest',
    ]
  )
})

test("G4: another file that reaches the settings and names a claimed key is a settingsAccess entry", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({
      modules: "kernel",
      "settings-store": "kernel",
      chat: "kernel",
      db: "kernel",
    }),
    "lib/modules/define.ts": DEFINE,
    "packages/plugin-contract/src/types/agent-config/index.ts": APP_SETTINGS,
    "stores/settings/index.ts": "export const useSettingsStore = 1\n",
    "stores/settings/view.ts": "export const defineSettingsView = (keys) => keys\n",
    "lib/db/settings.ts": "export const getSettings = () => ({ crewMode: 1 })\n",
    "lib/crew/module.ts": hostManifest("crew", 'settings: { keys: ["crewMode"] }'),
    "components/crew/module.ui.ts": uiWithSection("crew"),
    "lib/crew/run.ts": `import { useSettingsStore } from "@/stores/settings"\nexport const run = () => useSettingsStore.settings.crewMode\n`,
    "lib/chat/read.ts": `import { useSettingsStore } from "@/stores/settings"\nexport const read = (s) => [s.crewMode, s.petName]\n`,
    "lib/chat/write.ts": `import { getSettings } from "@/lib/db/settings"\nexport const write = (save) => save({ crewMode: getSettings()["crewMode"] })\n`,
    "lib/chat/unrelated.ts": `export const other = (s) => s.crewMode\n`,
    "lib/chat/message.ts": `import { useSettingsStore } from "@/stores/settings"\nexport const m = "crewMode"\n`,
  })
  assert.deepEqual(result.measures.settingsAccess, [
    "lib/chat/read.ts -> crewMode",
    "lib/chat/write.ts -> crewMode",
  ])
})

test("settingsKeyUses reads property, destructuring, object-literal and element keys, not strings", () => {
  const source = `
const { ttsRate, voice: v } = settings
save({ ttsEnabled: true, ttsPitch })
const x = settings.ttsVolume + settings["ttsAutoPlay"]
log("ttsProvider")
`
  assert.deepEqual(
    [...settingsKeyUses(astOf(source))].filter((n) => n.startsWith("tts") || n === "voice").sort(),
    ["ttsAutoPlay", "ttsEnabled", "ttsPitch", "ttsRate", "ttsVolume", "voice"]
  )
})

test("settingsViewCalls tells its own manifest's keys from anything else", () => {
  const source = `import speechModule from "./module"
import other from "./other"
export const a = defineSettingsView(speechModule.settings.keys)
export const b = defineSettingsView(["ttsRate"])
export const c = defineSettingsView(other.keys)
export const d = defineSettingsView(unknown.settings.keys)
`
  assert.deepEqual(settingsViewCalls(astOf(source)), [
    { manifest: "./module" },
    { other: true },
    { other: true },
    { other: true },
  ])
})

function astOf(source) {
  return ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true)
}

test("tableAccesses reads the Dexie spellings and nothing else", () => {
  const source = `
const db = getDb()
export const reads = [
  db.crews.toArray(),
  this.db.notes,
  getDb().pets.get(1),
  rawDb().logs,
  tx.table("runs"),
  other.sessions,
  db,
  getOther().tasks,
  tx.table(name),
]
`
  assert.deepEqual([...tableAccesses(astOf(source))].sort(), [
    "crews",
    "logs",
    "notes",
    "pets",
    "runs",
  ])
})

/** A tree where "crew" claims tables and the data layer serves several modules. */
function tableTree(extra = {}) {
  return {
    [OWNERSHIP_FILE]: ownership({
      modules: "kernel",
      "data-governance": "foundation",
      db: "foundation",
      chat: "kernel",
      twin: "module",
    }),
    "lib/modules/define.ts": DEFINE,
    "lib/data-governance/table-catalog.ts": `export const CORE_TABLE_NAMES = ["crews", "notes", "pets", "runs"] as const\n`,
    "lib/crew/module.ts": hostManifest("crew", 'tables: ["crews", "notes"]'),
    "lib/crew/run.ts": `import { notes } from "@/lib/db/notes"\nimport { both } from "@/lib/db/both"\nexport const run = () => [getDb().crews, notes, both]\n`,
    // Reaches "notes" for crew (and twin), so crew's claim is touched.
    "lib/db/notes.ts": `import { inner } from "./inner"\nexport const notes = () => [getDb().notes.toArray(), inner]\n`,
    // Only another data module uses it: it stays in the data layer.
    "lib/db/inner.ts": `export const inner = 1\n`,
    // Two modules use it: it is shared.
    "lib/db/both.ts": `export const both = () => getDb().runs\n`,
    "lib/pet/module.ts": hostManifest("pet"),
    "lib/pet/run.ts": `import { both } from "@/lib/db/both"\nimport { pets } from "@/lib/db/pets"\nexport const run = (db) => [db.crews, db.pets, both, pets]\n`,
    // Only pet uses it, and pet has a manifest: it must claim it.
    "lib/db/pets.ts": `export const pets = () => getDb().pets\n`,
    // A module without a manifest using a data module alone is only counted.
    "lib/twin/run.ts": `import { notes } from "@/lib/db/notes"\nimport { solo } from "@/lib/db/solo"\nexport const run = () => [notes, solo, getDb().notes]\n`,
    "lib/db/solo.ts": `export const solo = 1\n`,
    // The data layer and the kernel are not judged.
    "lib/db/backup.ts": `export const all = () => [getDb().crews, getDb().notes]\n`,
    "lib/chat/clear.ts": `export const clear = () => getDb().crews.clear()\n`,
    ...extra,
  }
}

test("G4: a module touches a claimed table through a data module it imports", () => {
  const result = run(tableTree())
  assert.ok(
    !declarationErrors(result).some((error) => error.startsWith("G4 lib/crew/module.ts")),
    declarationErrors(result).join("\n")
  )
})

test("G4: a data module only one manifest module uses must be claimed by it", () => {
  const result = run(tableTree())
  assert.deepEqual(
    declarationErrors(result).filter((error) => error.startsWith("G4 lib/db/")),
    [
      'G4 lib/db/pets.ts: only "pet" uses this data module; claim it in lib/pet/module.ts `owns` (or move it under lib/pet/)',
    ]
  )
  const claimed = run(
    tableTree({
      "lib/pet/module.ts": hostManifest("pet", 'owns: ["lib/pet/", "lib/db/pets.ts"]'),
    })
  )
  assert.deepEqual(
    declarationErrors(claimed).filter((error) => error.startsWith("G4 lib/db/")),
    []
  )
})

test("G4: another module's direct access to a claimed table is measured; the data layer and kernel are not", () => {
  const result = run(tableTree())
  assert.deepEqual(result.measures.tableAccess, [
    "lib/pet/run.ts -> crews",
    "lib/twin/run.ts -> notes",
  ])
  assert.equal(result.measures.size.tables, 4)
  assert.equal(result.measures.size.unclaimedTables, 2)
  // solo (twin alone) and pets (pet alone); inner is only the data layer's.
  assert.equal(result.measures.size.singleUserDataModules, 2)
})

// ------------------------------------------------------------ generation

const HOST_MANIFEST = `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({
  id: "crew",
  kind: "module",
  stage: "beta",
  searchProviders: () => import("./search"),
  slashCommands: [{ name: "crew", description: "Talk to the crew.", load: () => import("./slash") }],
})
`
const UI_MANIFEST = `import { defineUiModule } from "@/lib/modules/define"
export default defineUiModule({
  id: "crew",
  settingsSections: [
    {
      id: "crew",
      group: "agents",
      icon: "Users",
      label: "crew.settingsSection.label",
      description: "crew.settingsSection.description",
      load: () => import("./section"),
    },
  ],
})
`

function moduleTree(extra = {}) {
  const registries = renderRegistries({
    host: [{ id: "crew", file: "lib/crew/module.ts" }],
    ui: [{ id: "crew", file: "components/crew/module.ui.ts" }],
  })
  return {
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": `import type { X } from "./manifest-types"\nexport const defineHostModule = (m) => m\n`,
    "lib/modules/manifest-types.ts": "export type X = 1\n",
    "lib/crew/module.ts": HOST_MANIFEST,
    "lib/crew/search.ts": "export const searchProviders = []\n",
    "lib/crew/slash.ts": "export const run = () => {}\n",
    "components/crew/module.ui.ts": UI_MANIFEST,
    "components/crew/section.tsx": "export default function Section() { return null }\n",
    ...registries,
    ...extra,
  }
}

test("G5: current generated registries pass, and they are not owned source files", () => {
  const result = run(moduleTree())
  assert.deepEqual(result.errors, [])
  assert.equal(result.owners.has(GENERATED_HOST), false)
  assert.equal(result.owners.get("lib/crew/module.ts").owner, "crew")
})

test("G5: a missing or hand-edited registry is an error", () => {
  const missing = moduleTree()
  delete missing[GENERATED_UI]
  assert.ok(run(missing).errors.some((e) => e.startsWith(`${GENERATED_UI} is missing`)))
  const edited = moduleTree({ [GENERATED_HOST]: "export const HOST_MODULES = [] as const\n" })
  assert.ok(run(edited).errors.some((e) => e.startsWith(`${GENERATED_HOST} differs from what`)))
})

test("G5: contributions are checked for shape, icon and clashes between modules", () => {
  const badUi = UI_MANIFEST.replace('icon: "Users"', 'icon: "users-round-x"').replace(
    'label: "crew.settingsSection.label"',
    'label: "crewLabel"'
  )
  const result = run(
    moduleTree({
      "packages/plugin-contract/src/lib/icons/lucide-icon-names.generated.json": {
        iconNames: ["Users"],
        exportNames: {},
      },
      "components/crew/module.ui.ts": badUi,
      "lib/other/module.ts": HOST_MANIFEST.replace('id: "crew"', 'id: "other"'),
      "lib/other/search.ts": "export const searchProviders = []\n",
      "lib/other/slash.ts": "export const run = () => {}\n",
    })
  )
  assert.ok(result.errors.some((e) => e.includes('icon "users-round-x" is not a Lucide icon name')))
  assert.ok(result.errors.some((e) => e.includes("label is a full i18n key")))
  assert.ok(
    result.errors.some((e) => e.includes('slash command /crew is also contributed by "crew"'))
  )
})

const NAV_ENTRY = {
  id: "crew",
  route: "/crew",
  label: "crew.nav.label",
  icon: "Users",
  spotIcon: "agent-teams",
  group: "feature",
  category: "agents",
}
const VOCABULARY = {
  iconNames: new Set(["Users"]),
  spotIconNames: new Set(["agent-teams"]),
  extensionPoints: new Set(["chat.header"]),
}

test("validateHostManifest checks nav entries against the catalog's vocabulary", () => {
  const nav = (entry) =>
    validateHostManifest(
      { id: "crew", kind: "module", stage: "beta", nav: [entry] },
      "crew",
      VOCABULARY
    )
  assert.deepEqual(nav(NAV_ENTRY), [])
  assert.deepEqual(
    nav({
      ...NAV_ENTRY,
      after: "agents",
      goMenuAfter: "plugins",
      aliases: "crew.nav.aliases",
      fullViewport: true,
      mobileShortcut: { after: "twin" },
    }),
    []
  )
  const errors = nav({
    ...NAV_ENTRY,
    id: "Crew",
    route: "crew",
    label: "crewLabel",
    aliases: "crewAliases",
    icon: "users-x",
    spotIcon: "crew-art",
    group: "main",
    category: "work",
    fullViewport: "yes",
    badge: 1,
    mobileShortcut: { after: 3, size: "s" },
  })
  for (const expected of [
    'unknown field "badge"',
    "nav[0].id is lower-case kebab",
    'nav[0].route is a top-level route ("/x")',
    "nav[0].label is a full i18n key",
    "nav[0].aliases is a full i18n key",
    'nav[0].icon "users-x" is not a Lucide icon name',
    "nav[0].group is one of feature, auxiliary",
    "nav[0].category is one of explore, agents, spaces, insights, system, you",
    "nav[0].fullViewport is true or false",
    'nav[0].mobileShortcut: unknown field "size"',
    'nav[0].spotIcon "crew-art" is not a MobileSpotIconName',
    "nav[0].mobileShortcut.after is text",
  ])
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected} in ${errors.join("; ")}`
    )
  assert.ok(
    validateHostManifest(
      { id: "crew", kind: "module", stage: "beta", nav: [NAV_ENTRY, NAV_ENTRY] },
      "crew"
    ).includes('nav[1].id "crew" is listed twice')
  )
})

test("validateHostManifest checks runtimes: identity, adapters per host, and why a host has none", () => {
  const runtimes = (list) =>
    validateHostManifest({ id: "crew", kind: "module", stage: "beta", runtimes: list }, "crew")
  assert.deepEqual(
    runtimes([
      {
        name: "crew-sync",
        criticality: "required",
        boot: "knowledge-agents",
        adapters: {
          brain: { module: "./runtime/sync", hosts: ["brain", "person-brain"] },
          desktop: "./runtime/sync",
          mobile: "@/lib/crew/runtime/sync",
        },
      },
      {
        name: "crew-watch",
        criticality: "optional",
        adapters: { desktop: "./runtime/watch" },
        absent: { brain: "Watches the desktop's window focus.", mobile: "No windows." },
      },
    ]),
    []
  )
  const errors = runtimes([
    {
      name: "Crew Sync",
      criticality: "sometimes",
      boot: "later",
      order: 1,
      adapters: {
        brain: { module: "crew-runtime", hosts: ["desktop"] },
        desktop: () => {},
        tv: "./x",
      },
      absent: { desktop: "has one anyway" },
    },
    { name: "crew-watch", criticality: "optional", adapters: {} },
    {
      name: "crew-watch",
      criticality: "optional",
      adapters: { brain: { module: "./b", hosts: [] } },
    },
    {
      name: "crew-boot",
      criticality: "optional",
      boot: "integrations",
      adapters: { brain: { module: "./b", hosts: ["brain"] } },
      absent: { desktop: "x", mobile: "y" },
    },
  ])
  for (const expected of [
    'runtimes[0]: unknown field "order"',
    "runtimes[0].name is lower-case kebab",
    "runtimes[0].criticality is one of required, optional",
    "runtimes[0].boot is one of core-chat, workflow-automation, integrations, knowledge-agents",
    'runtimes[0].adapters: unknown field "tv"',
    'runtimes[0].adapters.brain.module is a "./…" or "@/…" module specifier',
    "runtimes[0].adapters.brain.hosts lists the brain profiles it starts on (brain, person-brain)",
    'runtimes[0].adapters.desktop is a "./…" or "@/…" module specifier',
    "runtimes[0].absent.desktop explains a host that has an adapter",
    "runtimes[0] has no mobile adapter; say why in absent.mobile",
    "runtimes[1].adapters names at least one host",
    "runtimes[1] has no brain adapter; say why in absent.brain",
    'runtimes[2].name "crew-watch" is listed twice',
    "runtimes[2].adapters.brain.hosts lists the brain profiles it starts on (brain, person-brain)",
    "runtimes[3].boot orders renderer runtimes; it has no desktop or mobile adapter",
  ])
    assert.ok(errors.includes(expected), `missing: ${expected}\n${errors.join("\n")}`)
})

test("validateUiManifest checks effects: named once each, loaded lazily", () => {
  const effects = (list) => validateUiManifest({ id: "crew", effects: list }, "crew")
  assert.deepEqual(effects([{ name: "crew-title", load: { $lazy: "./title" } }]), [])
  const errors = effects([
    { name: "crew-title", load: "./title" },
    { name: "crew-title", load: { $lazy: "./title" }, when: "always" },
    { name: "Title", load: { $lazy: "./x" } },
  ])
  for (const expected of [
    'effects[1]: unknown field "when"',
    'effects[1].name "crew-title" is listed twice',
    "effects[2].name is lower-case kebab",
  ])
    assert.ok(errors.includes(expected), `missing: ${expected}\n${errors.join("\n")}`)
  assert.ok(errors.some((error) => error.startsWith("effects[0].load is a lazy entry")))
})

test("declaredPorts reads one port per contract file under types/modules/ports/", () => {
  assert.deepEqual(
    [
      ...declaredPorts([
        "types/modules/ports/speech.ts",
        "types/modules/ports/ocr.ts",
        "types/modules/ports/speech.test.ts",
        "types/modules/ports/nested/x.ts",
        "types/modules/other.ts",
      ]).keys(),
    ].sort(),
    ["ocr", "speech"]
  )
})

test("declaredPorts tells a collection port (PortCollectionMap) from a one-provider port", () => {
  const sources = {
    "types/modules/ports/speech.ts":
      'declare module "@/lib/modules/ports" {\n  interface PortMap { speech: S }\n}\n',
    "types/modules/ports/docs-provider.ts":
      'declare module "@/lib/modules/ports" {\n  interface PortCollectionMap { "docs-provider": D }\n}\n',
  }
  const ports = declaredPorts(Object.keys(sources), (file) => sources[file])
  assert.equal(ports.get("speech"), "one")
  assert.equal(ports.get("docs-provider"), "many")
  // Without a reader every port counts as one-provider.
  assert.equal(declaredPorts(Object.keys(sources)).get("docs-provider"), "one")
})

test("validateHostManifest checks provides and requires against the declared ports", () => {
  const ports = { ports: new Set(["speech", "ocr"]) }
  const check = (fields) =>
    validateHostManifest({ id: "crew", kind: "module", stage: "beta", ...fields }, "crew", ports)
  assert.deepEqual(
    check({
      provides: [{ port: "speech", load: { $lazy: "./port" } }],
      requires: ["ocr?"],
    }),
    []
  )
  const errors = check({
    provides: [
      { port: "speech", load: "./port" },
      { port: "speech", load: { $lazy: "./port" } },
      { port: "vision", load: { $lazy: "./vision" }, hosts: ["desktop"] },
      { port: "Bad Id", load: { $lazy: "./x" } },
    ],
    requires: ["ocr", "ocr?", "vision", "Not A Port"],
  })
  for (const expected of [
    'provides[1].port "speech" is listed twice',
    'provides[2].port "vision" has no contract types/modules/ports/vision.ts',
    'provides[2]: unknown field "hosts"',
    "provides[3].port is a lower-case kebab port id",
    'requires names port "ocr" twice',
    'requires "vision": no contract types/modules/ports/vision.ts declares that port',
    'requires "Not A Port" is a port id, optionally ending in "?"',
  ])
    assert.ok(errors.includes(expected), `missing: ${expected}\n${errors.join("\n")}`)
  assert.ok(errors.some((error) => error.startsWith("provides[0].load is a lazy entry")))
  assert.deepEqual(check({ provides: "speech" }), ["provides is a list of port provisions"])
})

test("ports: a provider exports `port`, one module provides each, and requires equals what files ask for", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/modules/ports.ts": "export async function loadPort(id) { return id }\n",
    "types/modules/ports/speech.ts": "export interface SpeechPort { x: 1 }\n",
    "types/modules/ports/ocr.ts": "export interface OcrPort { x: 1 }\n",
    "types/modules/ports/vision.ts": "export interface VisionPort { x: 1 }\n",
    // Provides speech, but its file exports no `port`.
    "lib/speech/module.ts": hostManifest(
      "speech",
      'provides: [{ port: "speech", load: () => import("./port") }]'
    ),
    "lib/speech/port.ts": "export const notPort = {}\n",
    // A second provider of speech; experimental, so it does not satisfy a requirement.
    "lib/voice/module.ts": `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({ id: "voice", kind: "module", stage: "experimental", provides: [{ port: "speech", load: () => import("./port") }, { port: "vision", load: () => import("./vision") }] })
`,
    "lib/voice/port.ts": "export const port = {}\n",
    "lib/voice/vision.ts": "const port = {}\nexport { port }\n",
    // Asks for speech without requiring it; requires ocr it never asks for, and
    // vision without "?" although only an experimental module provides it.
    "lib/pet/module.ts": hostManifest("pet", 'requires: ["ocr?", "vision"]'),
    "lib/pet/speak.ts": `import { loadPort } from "@/lib/modules/ports"
// loadPort("ocr") in a comment is not a call.
export const speak = () => loadPort("speech")
export const see = () => loadPort("vision")
`,
    // Requires the port it provides.
    "lib/crew/module.ts": hostManifest(
      "crew",
      'provides: [{ port: "ocr", load: () => import("./ocr") }], requires: ["ocr"]'
    ),
    "lib/crew/ocr.ts": "export function port() {}\n",
  })
  const errors = result.errors.filter((error) => /port/.test(error))
  for (const expected of [
    "lib/speech/module.ts: provides[0]: lib/speech/port.ts exports no `port`",
    'lib/voice/module.ts: port speech is also contributed by "speech"',
    'G4 lib/pet/module.ts: lib/pet/speak.ts asks for port "speech" but "pet"\'s requires does not name it',
    'G4 lib/pet/module.ts: requires port "ocr", which no file of "pet" asks for',
    'G5 lib/pet/module.ts: requires port "vision" but no active module provides it (mark it "vision?" if "pet" copes without)',
    'G4 lib/crew/module.ts: requires port "ocr", which it provides',
  ])
    assert.ok(errors.includes(expected), `missing: ${expected}\n${errors.join("\n")}`)
  assert.equal(errors.length, 6, errors.join("\n"))
})

test("prompts: a module that defines a prompt contributes it, from a file exporting `prompts`", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel", prompts: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/prompts/types.ts": "export const definePrompt = (d) => d\n",
    // Contributes prompts, but its file exports them under another name.
    "lib/pet/module.ts": hostManifest("pet", 'prompts: () => import("./prompts")'),
    "lib/pet/prompts.ts": `import { definePrompt } from "@/lib/prompts/types"
export const notPrompts = [definePrompt({ id: "pet.x" })]
`,
    // Defines a prompt and contributes none.
    "lib/radar/module.ts": hostManifest("radar"),
    "lib/radar/report.ts": `import { definePrompt } from "@/lib/prompts/types"
export const REPORT = definePrompt({ id: "knowledge.radar" })
`,
    // Only its test defines one: nothing to contribute.
    "lib/crew/module.ts": hostManifest("crew"),
    "lib/crew/x.test.ts": `import { definePrompt } from "@/lib/prompts/types"
definePrompt({ id: "crew.x" })
`,
    // Defines and contributes.
    "lib/eval/module.ts": hostManifest("eval", 'prompts: () => import("./prompts")'),
    "lib/eval/prompts.ts": `import { definePrompt } from "@/lib/prompts/types"
const JUDGE = definePrompt({ id: "eval.judge" })
export const prompts = [JUDGE]
`,
  })
  // The fixture has no generated registries; those errors are another test's.
  const errors = result.errors.filter(
    (error) => /prompt/.test(error) && !error.startsWith("lib/modules/generated/")
  )
  assert.deepEqual(errors.sort(), [
    'G4 lib/radar/module.ts: lib/radar/report.ts defines a prompt but "radar" contributes none — list its prompts in a `prompts` file',
    "lib/pet/module.ts: prompts: lib/pet/prompts.ts exports no `prompts`",
  ])
})

test("validateHostManifest wants prompts as a lazy entry", () => {
  assert.ok(
    validateHostManifest(
      { id: "pet", kind: "module", stage: "beta", prompts: "./prompts" },
      "pet"
    ).includes('prompts is a lazy entry `() => import("…")`')
  )
})

test("the prompt registry lazily imports each contributing module's prompts file, by module id", () => {
  const files = renderRegistries({
    host: [
      {
        id: "radar",
        file: "lib/radar/module.ts",
        value: { stage: "stable", prompts: { $lazy: "./prompts" } },
      },
      { id: "crew", file: "lib/crew/module.ts", value: { stage: "beta" } },
      {
        id: "pet",
        file: "lib/pet/module.ts",
        value: { stage: "experimental", prompts: { $lazy: "@/lib/pet/prompts" } },
      },
    ],
    ui: [],
  })
  const registry = files[GENERATED_PROMPTS]
  assert.match(
    registry,
    /import type \{ ModulePromptsEntry \} from "@\/lib\/modules\/manifest-types"/
  )
  assert.ok(registry.indexOf('module: "pet"') < registry.indexOf('module: "radar"'))
  assert.ok(
    registry.includes('    stage: "experimental",\n    load: () => import("@/lib/pet/prompts"),')
  )
  assert.ok(registry.includes('load: () => import("@/lib/radar/prompts")'))
  assert.ok(!registry.includes("crew"))
  assert.ok(!files[GENERATED_HOST].includes("generated/prompts"))
})

test("capability contributions: a lazy load whose file exports `contributions`", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/goal/module.ts": hostManifest(
      "goal",
      'capabilityContributions: { load: () => import("./grants") }'
    ),
    "lib/goal/grants.ts": "export const contributions = []\n",
    "lib/pet/module.ts": hostManifest(
      "pet",
      'capabilityContributions: { load: () => import("./grants") }'
    ),
    "lib/pet/grants.ts": "export const grants = []\n",
  })
  const errors = result.errors.filter(
    (error) => /contribution/.test(error) && !error.startsWith("lib/modules/generated/")
  )
  assert.deepEqual(errors, [
    "lib/pet/module.ts: capabilityContributions: lib/pet/grants.ts exports no `contributions`",
  ])
})

test("validateHostManifest wants capabilityContributions as { load } with a lazy entry", () => {
  const base = { id: "goal", kind: "module", stage: "beta" }
  assert.ok(
    validateHostManifest({ ...base, capabilityContributions: "./grants" }, "goal").includes(
      'capabilityContributions.load is a lazy entry `() => import("…")`'
    )
  )
  assert.ok(
    validateHostManifest(
      { ...base, capabilityContributions: { load: { $lazy: "./grants" }, order: 1 } },
      "goal"
    ).includes('capabilityContributions: unknown field "order"')
  )
  assert.deepEqual(
    validateHostManifest(
      { ...base, capabilityContributions: { load: { $lazy: "./grants" } } },
      "goal"
    ),
    []
  )
})

test("the capability registry lazily imports each contributing module's file, by module id", () => {
  const files = renderRegistries({
    host: [
      {
        id: "goal",
        file: "lib/goal/module.ts",
        value: {
          stage: "stable",
          capabilityContributions: { load: { $lazy: "./context-injector" } },
        },
      },
      { id: "crew", file: "lib/crew/module.ts", value: { stage: "beta" } },
      {
        id: "browser-companion",
        file: "lib/browser-companion/module.ts",
        value: { stage: "stable", capabilityContributions: { load: { $lazy: "./agent-grant" } } },
      },
    ],
    ui: [],
  })
  const registry = files[GENERATED_CAPABILITIES]
  assert.match(
    registry,
    /export const MODULE_CAPABILITY_CONTRIBUTIONS: readonly ModuleCapabilityContributionsEntry\[\]/
  )
  assert.ok(registry.indexOf('module: "browser-companion"') < registry.indexOf('module: "goal"'))
  assert.ok(registry.includes('load: () => import("@/lib/goal/context-injector")'))
  assert.ok(registry.includes('load: () => import("@/lib/browser-companion/agent-grant")'))
  assert.ok(!registry.includes("crew"))
})

test("context contributions: a lazy load whose file exports `contributions`", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/radar/module.ts": hostManifest("radar", 'context: { load: () => import("./context") }'),
    "lib/radar/context.ts": "export const contributions = []\n",
    "lib/pet/module.ts": hostManifest("pet", 'context: { load: () => import("./context") }'),
    "lib/pet/context.ts": "export const sections = []\n",
  })
  const errors = result.errors.filter((error) =>
    /^lib\/(pet|radar)\/module\.ts: context/.test(error)
  )
  assert.deepEqual(errors, [
    "lib/pet/module.ts: context: lib/pet/context.ts exports no `contributions`",
  ])
})

test("context contributions: one module at most places an identity section", () => {
  const identity = 'export const contributions = [{ id: "who", cache: "turn", slot: "identity" }]\n'
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/radar/module.ts": hostManifest("radar", 'context: { load: () => import("./context") }'),
    "lib/radar/context.ts": identity,
    "lib/pet/module.ts": hostManifest("pet", 'context: { load: () => import("./context") }'),
    "lib/pet/context.ts": identity,
    "lib/goal/module.ts": hostManifest("goal", 'context: { load: () => import("./context") }'),
    "lib/goal/context.ts": 'export const contributions = [{ id: "g", slot: "memory" }]\n',
  })
  const errors = result.errors.filter((error) => error.includes("identity slot"))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /declared by more than one module \((pet, radar|radar, pet)\)/)

  const single = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/radar/module.ts": hostManifest("radar", 'context: { load: () => import("./context") }'),
    "lib/radar/context.ts": identity,
  })
  assert.deepEqual(
    single.errors.filter((error) => error.includes("identity slot")),
    []
  )
})

test("validateHostManifest wants context as { load } with a lazy entry", () => {
  const base = { id: "radar", kind: "module", stage: "beta" }
  assert.ok(
    validateHostManifest({ ...base, context: "./context" }, "radar").includes(
      'context.load is a lazy entry `() => import("…")`'
    )
  )
  assert.ok(
    validateHostManifest(
      { ...base, context: { load: { $lazy: "./context" }, slot: "memory" } },
      "radar"
    ).includes('context: unknown field "slot"')
  )
  assert.deepEqual(
    validateHostManifest({ ...base, context: { load: { $lazy: "./context" } } }, "radar"),
    []
  )
})

test("the context registry lazily imports each contributing module's file, by module id", () => {
  const files = renderRegistries({
    host: [
      {
        id: "radar",
        file: "lib/radar/module.ts",
        value: { stage: "stable", context: { load: { $lazy: "./context" } } },
      },
      { id: "crew", file: "lib/crew/module.ts", value: { stage: "beta" } },
      {
        id: "goal",
        file: "lib/goal/module.ts",
        value: { stage: "experimental", context: { load: { $lazy: "./turn-section" } } },
      },
    ],
    ui: [],
  })
  const registry = files[GENERATED_CONTEXT]
  assert.match(
    registry,
    /export const MODULE_CONTEXT_CONTRIBUTIONS: readonly ModuleContextEntry\[\]/
  )
  assert.ok(registry.indexOf('module: "goal"') < registry.indexOf('module: "radar"'))
  assert.ok(
    registry.includes(
      '    stage: "experimental",\n    load: () => import("@/lib/goal/turn-section"),'
    )
  )
  assert.ok(registry.includes('load: () => import("@/lib/radar/context")'))
  assert.ok(!registry.includes("crew"))
})

test("validateHostManifest wants workflowNodes as { load } with a lazy entry", () => {
  const base = { id: "sites", kind: "module", stage: "beta" }
  assert.ok(
    validateHostManifest({ ...base, workflowNodes: "./workflow-nodes" }, "sites").includes(
      'workflowNodes.load is a lazy entry `() => import("…")`'
    )
  )
  assert.ok(
    validateHostManifest(
      { ...base, workflowNodes: { load: { $lazy: "./workflow-nodes" }, kinds: [] } },
      "sites"
    ).includes('workflowNodes: unknown field "kinds"')
  )
  assert.deepEqual(
    validateHostManifest(
      { ...base, workflowNodes: { load: { $lazy: "./workflow-nodes" } } },
      "sites"
    ),
    []
  )
})

test("the workflow-node registry lazily imports each contributing module's file, by module id", () => {
  const files = renderRegistries({
    host: [
      {
        id: "sites",
        file: "lib/sites/module.ts",
        value: { stage: "stable", workflowNodes: { load: { $lazy: "./workflow-nodes" } } },
      },
      { id: "crew", file: "lib/crew/module.ts", value: { stage: "beta" } },
      {
        id: "goal",
        file: "lib/goal/module.ts",
        value: { stage: "experimental", workflowNodes: { load: { $lazy: "./workflow-nodes" } } },
      },
    ],
    ui: [],
  })
  const registry = files[GENERATED_WORKFLOW_NODES]
  assert.match(
    registry,
    /export const MODULE_WORKFLOW_NODES: readonly ModuleWorkflowNodesEntry\[\]/
  )
  assert.ok(registry.indexOf('module: "goal"') < registry.indexOf('module: "sites"'))
  assert.ok(registry.includes('load: () => import("@/lib/sites/workflow-nodes")'))
  assert.ok(!registry.includes("crew"))
})

test("validateHostManifest wants builtinSkills as { load } with a lazy entry", () => {
  const base = { id: "connectors", kind: "module", stage: "stable" }
  assert.ok(
    validateHostManifest({ ...base, builtinSkills: "./builtin-skills" }, "connectors").includes(
      'builtinSkills.load is a lazy entry `() => import("…")`'
    )
  )
  assert.ok(
    validateHostManifest(
      { ...base, builtinSkills: { load: { $lazy: "./builtin-skills" }, families: [] } },
      "connectors"
    ).includes('builtinSkills: unknown field "families"')
  )
  assert.deepEqual(
    validateHostManifest(
      { ...base, builtinSkills: { load: { $lazy: "./builtin-skills" } } },
      "connectors"
    ),
    []
  )
})

test("the built-in skill registry lazily imports each contributing module's file, by module id", () => {
  const files = renderRegistries({
    host: [
      {
        id: "connectors",
        file: "lib/connectors/module.ts",
        value: { stage: "stable", builtinSkills: { load: { $lazy: "./builtin-skills" } } },
      },
      { id: "crew", file: "lib/crew/module.ts", value: { stage: "beta" } },
      {
        id: "bot",
        file: "lib/bot/module.ts",
        value: { stage: "experimental", builtinSkills: { load: { $lazy: "./skills" } } },
      },
    ],
    ui: [],
  })
  const registry = files[GENERATED_BUILTIN_SKILLS]
  assert.match(
    registry,
    /export const MODULE_BUILTIN_SKILLS: readonly ModuleBuiltinSkillsEntry\[\]/
  )
  assert.ok(registry.indexOf('module: "bot"') < registry.indexOf('module: "connectors"'))
  assert.ok(registry.includes('load: () => import("@/lib/connectors/builtin-skills")'))
  assert.ok(!registry.includes("crew"))
})

test("validateHostManifest wants taskExecutors as { types, load } with distinct task types", () => {
  const base = { id: "connectors", kind: "module", stage: "stable" }
  const errors = (taskExecutors) => validateHostManifest({ ...base, taskExecutors }, "connectors")
  assert.ok(
    errors("./scheduler/task-executors").includes(
      'taskExecutors.load is a lazy entry `() => import("…")`'
    )
  )
  assert.ok(
    errors({
      load: { $lazy: "./scheduler/task-executors" },
      types: ["im-push"],
      cron: "",
    }).includes('taskExecutors: unknown field "cron"')
  )
  for (const types of [undefined, [], ["Im Push"], [3]])
    assert.ok(
      errors({ load: { $lazy: "./scheduler/task-executors" }, types }).includes(
        "taskExecutors.types lists the scheduled task types the file exports"
      )
    )
  assert.ok(
    errors({
      load: { $lazy: "./scheduler/task-executors" },
      types: ["im-push", "im-push"],
    }).includes("taskExecutors.types names a task type twice")
  )
  assert.deepEqual(
    errors({ load: { $lazy: "./scheduler/task-executors" }, types: ["im-push", "connection:x"] }),
    []
  )
})

test("the task executor registry lists each owning module's types and lazy file, by module id", () => {
  const files = renderRegistries({
    host: [
      {
        id: "connectors",
        file: "lib/connectors/module.ts",
        value: {
          stage: "stable",
          taskExecutors: { types: ["im-push"], load: { $lazy: "./scheduler/task-executors" } },
        },
      },
      { id: "crew", file: "lib/crew/module.ts", value: { stage: "beta" } },
      {
        id: "bot",
        file: "lib/bot/module.ts",
        value: {
          stage: "experimental",
          taskExecutors: { types: ["bot-digest"], load: { $lazy: "./executors" } },
        },
      },
    ],
    ui: [],
  })
  const registry = files[GENERATED_TASK_EXECUTORS]
  assert.match(
    registry,
    /export const MODULE_TASK_EXECUTORS: readonly ModuleTaskExecutorsEntry\[\]/
  )
  assert.ok(registry.indexOf('module: "bot"') < registry.indexOf('module: "connectors"'))
  assert.ok(registry.includes('types: ["im-push"],'))
  assert.ok(registry.includes('stage: "experimental"'))
  assert.ok(registry.includes('load: () => import("@/lib/connectors/scheduler/task-executors")'))
  assert.ok(!registry.includes("crew"))
})

test("a task type has one owning module", () => {
  const executors = (type) =>
    `taskExecutors: { types: ["${type}"], load: () => import("./task-executors") }`
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/crew/module.ts": hostManifest("crew", executors("im-push")),
    "lib/crew/task-executors.ts": "export const taskExecutors = {}\n",
    "lib/pet/module.ts": hostManifest("pet", executors("im-push")),
    "lib/pet/task-executors.ts": "export const taskExecutors = {}\n",
  })
  assert.deepEqual(
    result.errors.filter((error) => error.includes("task executor")),
    ['lib/pet/module.ts: task executor im-push is also contributed by "crew"']
  )
})

test("validateHostManifest wants tools as { declare, load } with complete declarations", () => {
  const base = { id: "crate", kind: "module", stage: "beta" }
  const errors = (tools) => validateHostManifest({ ...base, tools }, "crate")
  assert.deepEqual(
    errors({
      declare: {
        crate_list: { consent: "allow", effect: "read" },
        crate_peek: { consent: "default", effect: "read" },
        crate_send: { consent: "per-call", effect: "outbound", cancellable: false },
        crate_stand_in: { consent: "ask", effect: "write", secrets: true, precedence: "fallback" },
      },
      load: { $lazy: "./agent-tools" },
    }),
    []
  )
  assert.ok(errors("./agent-tools").includes("tools is { declare, load }"))
  const broken = errors({
    declare: {
      mcp__x__y: { consent: "allow", effect: "read" },
      "9lives": { consent: "allow", effect: "read" },
      crate_a: { consent: "maybe", effect: "send", order: 1 },
      crate_b: { consent: "allow", effect: "read", secrets: false, cancellable: true },
      crate_c: { consent: "allow", effect: "read", precedence: "first" },
      crate_d: "allow",
    },
    load: "./agent-tools",
    rules: {},
  })
  for (const expected of [
    'tools: unknown field "rules"',
    'tools.load is a lazy entry `() => import("…")`',
    "tools.declare.mcp__x__y: a tool name is a letter then letters, digits or single underscores",
    "tools.declare.9lives: a tool name is a letter then letters, digits or single underscores",
    'tools.declare.crate_a: unknown field "order"',
    "tools.declare.crate_a.consent is one of allow, ask, per-call, default",
    "tools.declare.crate_a.effect is one of read, write, outbound",
    "tools.declare.crate_b.secrets is true or absent",
    "tools.declare.crate_b.cancellable is false or absent",
    'tools.declare.crate_c.precedence is "fallback" or absent',
    "tools.declare.crate_d is { consent, effect }",
  ])
    assert.ok(broken.includes(expected), expected)
  assert.ok(
    errors({ declare: {}, load: { $lazy: "./t" } }).includes(
      "tools.declare names at least one tool"
    )
  )
})

test("tools: the family file exports `toolFamily`, a name has one module, and per-call names are on the sidecar's list", () => {
  const tools = (declare) =>
    `tools: { declare: ${JSON.stringify(declare)}, load: () => import("./agent-tools") }`
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/crate/module.ts": hostManifest(
      "crate",
      tools({
        crate_list: { consent: "allow", effect: "read" },
        crate_send: { consent: "per-call", effect: "outbound" },
        crate_hand: { consent: "per-call", effect: "outbound" },
      })
    ),
    "lib/crate/agent-tools.ts": "export const toolFamily = {}\n",
    "lib/box/module.ts": hostManifest(
      "box",
      tools({ crate_list: { consent: "ask", effect: "read" } })
    ),
    "lib/box/agent-tools.ts": "export const family = {}\n",
    [SIDECAR_PER_CALL_FILE]:
      'export const PER_CALL_PLUGIN_TOOL_NAMES: ReadonlySet<string> = new Set([\n  "browser_fill_credential",\n  "crate_send",\n])\n',
  })
  const errors = result.errors.filter((error) => !error.startsWith("lib/modules/generated/"))
  assert.ok(
    errors.includes("lib/box/module.ts: tools: lib/box/agent-tools.ts exports no `toolFamily`")
  )
  assert.ok(
    errors.some((error) => /tool crate_list is also contributed by "(box|crate)"/.test(error))
  )
  assert.ok(
    errors.includes(
      `lib/crate/module.ts: per-call tool crate_hand is missing from PER_CALL_PLUGIN_TOOL_NAMES (${SIDECAR_PER_CALL_FILE})`
    )
  )
  assert.ok(!errors.some((error) => error.includes("crate_send is missing")))
})

test("tools: an unreadable sidecar list is an error, an absent one (a fixture) is not", () => {
  const files = (sidecar) => ({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/crate/module.ts": hostManifest(
      "crate",
      'tools: { declare: { crate_send: { consent: "per-call", effect: "outbound" } }, load: () => import("./agent-tools") }'
    ),
    "lib/crate/agent-tools.ts": "export const toolFamily = {}\n",
    ...(sidecar ? { [SIDECAR_PER_CALL_FILE]: sidecar } : {}),
  })
  const own = (result) => result.errors.filter((error) => !/\/modules\/generated\//.test(error))
  assert.deepEqual(own(run(files())), [])
  assert.deepEqual(own(run(files("export const PER_CALL_PLUGIN_TOOL_NAMES = new Set(NAMES)\n"))), [
    `${SIDECAR_PER_CALL_FILE}: PER_CALL_PLUGIN_TOOL_NAMES is not a Set of string literals`,
  ])
})

test("the tool registry carries each module's declarations and lazily imports its family", () => {
  const files = renderRegistries({
    host: [
      {
        id: "filespace",
        file: "lib/filespace/module.ts",
        value: {
          stage: "stable",
          tools: {
            declare: { filespace_list: { consent: "allow", effect: "read" } },
            load: { $lazy: "./agent-tools" },
          },
        },
      },
      { id: "crew", file: "lib/crew/module.ts", value: { stage: "beta" } },
      {
        id: "coordinator",
        file: "lib/coordinator/module.ts",
        value: {
          stage: "beta",
          tools: {
            declare: { spawn_thread: { consent: "allow", effect: "write" } },
            load: { $lazy: "@/lib/coordinator/agent-tools" },
          },
        },
      },
    ],
    ui: [],
  })
  const registry = files[GENERATED_TOOLS]
  assert.match(registry, /export const MODULE_TOOLS: readonly ModuleToolsEntry\[\]/)
  assert.ok(registry.indexOf('module: "coordinator"') < registry.indexOf('module: "filespace"'))
  assert.ok(registry.includes('declare: {"filespace_list":{"consent":"allow","effect":"read"}},'))
  assert.ok(registry.includes('load: () => import("@/lib/filespace/agent-tools")'))
  assert.ok(registry.includes('load: () => import("@/lib/coordinator/agent-tools")'))
  assert.ok(!registry.includes("crew"))
  assert.ok(!files[GENERATED_HOST].includes("generated/tools"))
})

test("ports: a collection port takes a member from every module, and its framework asks without requires", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel", docs: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/modules/ports.ts": "export async function loadPortCollection(id) { return id }\n",
    "types/modules/ports/docs-provider.ts":
      'declare module "@/lib/modules/ports" {\n  interface PortCollectionMap { "docs-provider": D }\n}\n',
    "lib/gdocs/module.ts": hostManifest(
      "gdocs",
      'provides: [{ port: "docs-provider", load: () => import("./port") }]'
    ),
    "lib/gdocs/port.ts": "export const port = {}\n",
    "lib/ldocs/module.ts": hostManifest(
      "ldocs",
      'provides: [{ port: "docs-provider", load: () => import("./port") }]'
    ),
    "lib/ldocs/port.ts": "export const port = {}\n",
    // The kernel framework collects the members; it has no manifest to name them in.
    "lib/docs/registry.ts": `import { loadPortCollection } from "@/lib/modules/ports"
export const load = () => loadPortCollection("docs-provider")
`,
    // A module asking for the collection names it in requires like any port.
    "lib/pet/module.ts": hostManifest("pet"),
    "lib/pet/read.ts": `import { readPortCollection } from "@/lib/modules/ports"
export const read = () => readPortCollection("docs-provider")
`,
  })
  const errors = result.errors.filter((error) => /port/.test(error))
  assert.deepEqual(errors, [
    'G4 lib/pet/module.ts: lib/pet/read.ts asks for port "docs-provider" but "pet"\'s requires does not name it',
  ])
})

test("runtime adapters resolve from their manifest and export start; names are unique across modules", () => {
  const runtime = (name, adapters, absent) =>
    `runtimes: [{ name: "${name}", criticality: "optional", adapters: ${adapters}${absent ? `, absent: ${absent}` : ""} }]`
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": DEFINE,
    "lib/crew/module.ts": hostManifest(
      "crew",
      runtime(
        "crew-sync",
        '{ brain: { module: "./runtime/brain", hosts: ["brain"] }, desktop: "@/lib/crew/runtime/desktop", mobile: "./runtime/missing" }'
      )
    ),
    "lib/crew/runtime/brain.ts": "export async function start() {}\n",
    "lib/crew/runtime/desktop.ts": "export const begin = () => undefined\n",
    "lib/pet/module.ts": hostManifest(
      "pet",
      runtime(
        "crew-sync",
        '{ desktop: "./runtime/renderer" }',
        '{ brain: "No pet on a Host.", mobile: "No pet window on a phone." }'
      )
    ),
    "lib/pet/runtime/renderer.ts": "const start = () => undefined\nexport { start }\n",
  })
  const errors = result.errors.filter((error) => error.includes("runtime"))
  assert.deepEqual(errors.sort(), [
    "lib/crew/module.ts: runtimes[0].adapters.desktop: lib/crew/runtime/desktop.ts exports no `start`",
    'lib/crew/module.ts: runtimes[0].adapters.mobile: "./runtime/missing" does not resolve',
    'lib/pet/module.ts: runtime crew-sync is also contributed by "crew"',
  ])
})

test("validateUiManifest checks slots against the canonical points; nav is a host field", () => {
  assert.deepEqual(
    validateUiManifest(
      { id: "crew", slots: { "chat.header": { $lazy: "./x" } } },
      "crew",
      VOCABULARY
    ),
    []
  )
  const errors = validateUiManifest(
    { id: "crew", slots: { "chat.nowhere": { $lazy: "./x" }, "chat.header": "x" }, nav: [] },
    "crew",
    VOCABULARY
  )
  assert.ok(errors.includes('slots["chat.nowhere"] is not a CANONICAL_EXTENSION_POINTS entry'))
  assert.ok(errors.some((e) => e.startsWith('slots["chat.header"] is a lazy entry')))
  assert.ok(errors.includes('unknown field "nav"'))
})

test("the gate reads the spot icons and extension points from the tree, and nav ids clash", () => {
  const navManifest = (id) =>
    HOST_MANIFEST.replace('id: "crew",', `id: "${id}",`).replace(
      "  searchProviders:",
      `  nav: [{ id: "crew", route: "/${id}", label: "${id}.nav.label", icon: "Users", spotIcon: "nope", group: "feature", category: "agents", mobileShortcut: {} }],\n  searchProviders:`
    )
  const result = run(
    moduleTree({
      "components/mobile/mobile-spot-icon.tsx":
        'export const MOBILE_SPOT_ICON_NAMES = ["agent-teams", "fleet"] as const\n',
      "packages/plugin-contract/src/lib/plugin/contracts/plugin-points.ts": [
        "export const CANONICAL_EXTENSION_POINTS = [",
        "  // A comment between entries is skipped.",
        '  "chat.header",',
        "] as const",
        "",
      ].join("\n"),
      "components/crew/module.ui.ts": UI_MANIFEST.replace(
        "  settingsSections:",
        '  slots: { "chat.footer": () => import("./section") },\n  settingsSections:'
      ),
      "lib/crew/module.ts": navManifest("crew"),
      "lib/other/module.ts": navManifest("other"),
      "lib/other/search.ts": "export const searchProviders = []\n",
      "lib/other/slash.ts": "export const run = () => {}\n",
    })
  )
  assert.ok(
    result.errors.some((e) => e.includes('nav[0].spotIcon "nope" is not a MobileSpotIconName'))
  )
  assert.ok(
    result.errors.some((e) =>
      e.includes('slots["chat.footer"] is not a CANONICAL_EXTENSION_POINTS entry')
    )
  )
  assert.ok(
    result.errors.some((e) => e.includes('navigation entry crew is also contributed by "crew"'))
  )
})

test("G7: the registries load what the manifests import eagerly, nothing lazy", () => {
  const result = run(moduleTree())
  // lib/modules/define.ts only: not the manifests themselves, not the lazy
  // targets and not the type-only manifest-types.ts.
  assert.equal(result.measures.size.registryEagerFiles, 1)
})

test("G7: another data-only module does not count as eager growth", () => {
  const tree = moduleTree()
  tree["lib/second/module.ts"] = [
    'import { defineHostModule } from "@/lib/modules/define"',
    'export default defineHostModule({ id: "second", kind: "module", stage: "stable" })',
    "",
  ].join("\n")
  tree["lib/second/index.ts"] = "export const second = 1\n"
  const result = run(tree)
  assert.equal(result.measures.size.registryEagerFiles, 1)
})

// ------------------------------------------------------------ cycles

test("G6: largestComponent finds the biggest strongly connected component", () => {
  const graph = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["c"])],
    ["c", new Set(["a"])],
    ["d", new Set(["a"])],
  ])
  assert.equal(largestComponent(graph).largest, 3)
})

test("G6: a dependsOn cycle is an error", () => {
  const manifest = (id, dep) => `import { defineHostModule } from "@/lib/modules/define"
export default defineHostModule({ id: "${id}", kind: "module", stage: "beta", dependsOn: ["${dep}"] })
`
  const result = run({
    [OWNERSHIP_FILE]: ownership({ modules: "kernel" }),
    "lib/modules/define.ts": "export const defineHostModule = (m) => m\n",
    "lib/one/module.ts": manifest("one", "two"),
    "lib/two/module.ts": manifest("two", "one"),
  })
  assert.ok(result.errors.some((e) => e.startsWith("dependsOn cycle: one → two")))
})

// ------------------------------------------------------------ size and vendors

test("G7: tables, SettingsState members and settings-store importers are counted", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({
      "data-governance": "foundation",
      "settings-store": "kernel",
      chat: "kernel",
    }),
    "lib/data-governance/table-catalog.ts": `export const CORE_TABLE_NAMES = ["a", "b", "c"] as const\n`,
    "stores/settings/settings-store.ts": `interface Base { x: 1 }\ninterface SettingsState extends Base { a: 1; b: 2 }\nexport const useSettingsStore = 1\n`,
    "stores/settings/index.ts": `export * from "./settings-store"\n`,
    "lib/chat/a.ts": `import { useSettingsStore } from "@/stores/settings"\nexport const a = useSettingsStore\n`,
  })
  assert.deepEqual(result.measures.size, {
    modules: 0,
    experimental: 0,
    tables: 3,
    unclaimedTables: 3,
    singleUserDataModules: 0,
    settingsStateMembers: 3,
    settingsStoreImporters: 1,
    registryEagerFiles: 0,
  })
})

test("G8: a framework comparing or importing a vendor is a violation; shared adapter plumbing is not", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ connectors: "module", github: "module" }),
    "lib/connectors/bus.ts": `import { lark } from "@/lib/connectors/adapters/lark/index"
import { mapper } from "@/lib/connectors/adapters/_shared/mapper"
import { gh } from "@/lib/github/client"
export const route = (p: string) => (p === "lark" ? lark : p === "permission-matrix-row" ? mapper : gh)
`,
    "lib/connectors/adapters/lark/index.ts": `export const lark = 1\nexport const isMe = (p: string) => p === "lark"\n`,
    "lib/connectors/adapters/_shared/mapper.ts": "export const mapper = 1\n",
    "lib/connectors/lark-helper.ts": "export const h = 1\n",
    "lib/github/client.ts": "export const gh = 1\n",
  })
  assert.deepEqual(result.measures.vendorNeutral, [
    'lib/connectors/bus.ts :: compares "lark"',
    "lib/connectors/bus.ts :: imports lib/connectors/adapters/lark/index.ts",
    "lib/connectors/bus.ts :: imports lib/github/client.ts",
    "lib/connectors/lark-helper.ts :: vendor file",
  ])
})

test("G8: a vendor catalog may import framework files and implementation entries only", () => {
  const result = run({
    [OWNERSHIP_FILE]: ownership({ connectors: "module" }),
    "lib/connectors/vendor-contribution.ts": `import { CONNECTOR_VENDORS } from "./adapters/_vendors"
export const all = () => CONNECTOR_VENDORS
`,
    "lib/connectors/adapters/_vendors.ts": `import type { Contribution } from "../types"
import { lark } from "./lark/contribution"
import { slack } from "./slack/index"
import { helper } from "./_shared/helper"
export const CONNECTOR_VENDORS: Contribution[] = [lark, slack, helper]
`,
    "lib/connectors/types.ts": "export type Contribution = number\n",
    "lib/connectors/adapters/lark/contribution.ts": "export const lark = 1\n",
    "lib/connectors/adapters/slack/index.ts": "export const slack = 2\n",
    "lib/connectors/adapters/_shared/helper.ts": "export const helper = 3\n",
  })
  assert.deepEqual(result.measures.vendorNeutral, [
    "lib/connectors/adapters/_vendors.ts :: catalog imports lib/connectors/adapters/_shared/helper.ts",
    "lib/connectors/adapters/_vendors.ts :: catalog imports lib/connectors/adapters/slack/index.ts",
  ])
})

// ------------------------------------------------------------ compare and main

const MEASURES = {
  direction: ["a -> b", "c -> d"],
  cycles: { largestLibComponent: 5 },
  size: {
    modules: 2,
    experimental: 0,
    tables: 3,
    unclaimedTables: 2,
    singleUserDataModules: 1,
    settingsStateMembers: 4,
    settingsStoreImporters: 5,
    registryEagerFiles: 3,
  },
  publicApi: ["lib/a/x.ts -> lib/b/y.ts"],
  tableAccess: ["lib/a/x.ts -> notes"],
  vendorNeutral: ["x :: vendor file"],
}

test("G2 fails on an edge the baseline does not have, since M1", () => {
  const { failures } = compare(MEASURES, { ...MEASURES, direction: ["a -> b"] })
  assert.equal(failures.length, 1)
  assert.ok(failures[0].startsWith("G2 direction: 1 new edge(s)"))
  assert.ok(failures[0].endsWith("\n  c -> d"))
  const paid = compare({ ...MEASURES, direction: ["a -> b"] }, MEASURES)
  assert.deepEqual(paid.failures, [])
  assert.ok(paid.hints.includes("direction: 1 baselined item(s) repaid"))
})

test("G3 fails on an import the baseline does not have and hints when one is repaid", () => {
  const grown = compare(
    { ...MEASURES, publicApi: [...MEASURES.publicApi, "lib/a/x.ts -> lib/c/z.ts"] },
    MEASURES
  )
  assert.equal(grown.failures.length, 1)
  assert.ok(grown.failures[0].startsWith("G3 public API: 1 new import(s)"))
  assert.ok(grown.failures[0].endsWith("\n  lib/a/x.ts -> lib/c/z.ts"))
  const paid = compare({ ...MEASURES, publicApi: [] }, MEASURES)
  assert.deepEqual(paid.failures, [])
  assert.ok(paid.hints.includes("publicApi: 1 baselined item(s) repaid"))
})

test("G4 fails on a settings access the baseline does not have and hints when one is repaid", () => {
  const known = { ...MEASURES, settingsAccess: ["lib/a/x.ts -> ttsRate"] }
  const grown = compare(
    { ...known, settingsAccess: [...known.settingsAccess, "lib/c/z.ts -> petSettings"] },
    known
  )
  assert.equal(grown.failures.length, 1)
  assert.ok(grown.failures[0].startsWith("G4 settings access: 1 new use(s)"))
  assert.ok(grown.failures[0].endsWith("\n  lib/c/z.ts -> petSettings"))
  const paid = compare({ ...known, settingsAccess: [] }, known)
  assert.deepEqual(paid.failures, [])
  assert.ok(paid.hints.includes("settingsAccess: 1 baselined item(s) repaid"))
})

test("G4 fails on a table access the baseline does not have and hints when one is repaid", () => {
  const grown = compare(
    { ...MEASURES, tableAccess: [...MEASURES.tableAccess, "lib/c/z.ts -> crews"] },
    MEASURES
  )
  assert.equal(grown.failures.length, 1)
  assert.ok(grown.failures[0].startsWith("G4 table access: 1 new direct access(es)"))
  assert.ok(grown.failures[0].endsWith("\n  lib/c/z.ts -> crews"))
  const paid = compare({ ...MEASURES, tableAccess: [] }, MEASURES)
  assert.deepEqual(paid.failures, [])
  assert.ok(paid.hints.includes("tableAccess: 1 baselined item(s) repaid"))
  const unclaimed = compare(
    { ...MEASURES, size: { ...MEASURES.size, unclaimedTables: 3, singleUserDataModules: 2 } },
    MEASURES
  )
  assert.deepEqual(unclaimed.failures, [
    "G7 size.unclaimedTables: 3 > baseline 2",
    "G7 size.singleUserDataModules: 2 > baseline 1",
  ])
})

test("G6, G7 and G8 fail on growth and hint when paid down", () => {
  const grown = compare(
    {
      ...MEASURES,
      cycles: { largestLibComponent: 6 },
      vendorNeutral: ["x :: vendor file", "y :: vendor file"],
    },
    MEASURES
  )
  assert.ok(
    grown.failures.some((f) => f.startsWith("G6 cycles.largestLibComponent: 6 > baseline 5"))
  )
  assert.ok(
    grown.failures.some((f) => f.startsWith("G8 vendor-neutral frameworks: 1 new violation"))
  )
  const paid = compare({ ...MEASURES, size: { ...MEASURES.size, tables: 2 } }, MEASURES)
  assert.deepEqual(paid.failures, [])
  assert.ok(paid.hints.includes("size.tables: 2 < baseline 3"))
})

test("main writes a baseline, then passes against it", () => {
  const root = fixture({
    [OWNERSHIP_FILE]: ownership({ chat: "kernel", pet: "module" }),
    "lib/chat/a.ts": `import { p } from "@/lib/pet/p"\nexport const a = p\n`,
    "lib/pet/p.ts": "export const p = 1\n",
  })
  try {
    assert.equal(main(["--root", root], silent), 1, "no baseline yet")
    assert.equal(main(["--root", root, "--write-baseline"], silent), 0)
    const baseline = JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"))
    assert.deepEqual(baseline.direction, ["lib/chat/a.ts -> pet"])
    assert.deepEqual(baseline.publicApi, [])
    assert.equal(main(["--root", root], silent), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("main refuses to write a baseline over ownership errors", () => {
  const root = fixture({
    [OWNERSHIP_FILE]: ownership({}),
    "lib/orphan/a.ts": "export const a = 1\n",
  })
  try {
    assert.equal(main(["--root", root, "--write-baseline"], silent), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
