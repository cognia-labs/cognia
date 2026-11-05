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
  validateHostManifest,
} from "./check-modules.mjs"
import { GENERATED_HOST, GENERATED_UI, renderRegistries } from "./lib/module-manifests.mjs"
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

test("G2: only a shell lists api files, and only files it owns", () => {
  const table = ownership({ pet: "module", settings: "shell" })
  table.subsystems.pet.api = ["lib/pet/p.ts"]
  table.subsystems.settings.api = ["lib/pet/p.ts"]
  const result = run({
    [OWNERSHIP_FILE]: table,
    "lib/pet/p.ts": "export const p = 1\n",
    "components/settings/s.ts": "export const s = 1\n",
  })
  assert.ok(result.errors.some((e) => e.includes('"pet": only a shell lists `api` files')))
  assert.ok(result.errors.some((e) => e.includes('"settings" lists api file lib/pet/p.ts')))
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

// ------------------------------------------------------------ compare and main

const MEASURES = {
  direction: ["a -> b", "c -> d"],
  cycles: { largestLibComponent: 5 },
  size: {
    modules: 2,
    experimental: 0,
    tables: 3,
    settingsStateMembers: 4,
    settingsStoreImporters: 5,
    registryEagerFiles: 3,
  },
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
