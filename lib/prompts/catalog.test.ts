import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  __resetModulePromptsForTests,
  getPromptDefinition,
  listPromptDefinitions,
  loadPromptCatalog,
  PROMPT_DEFINITIONS,
} from "./catalog"
import { validatePromptBody } from "./template"
import type { PromptDefinitionV1 } from "./types"
import { builtinAgents } from "@/lib/agent/builtin-catalog/catalog"
import { BUILT_IN_MODE_PROMPTS, shippedModePrompt } from "@/lib/agent/modes/built-ins"
import { EXECUTOR_FALLBACK_PROMPT } from "@/lib/agent/prompts/executor"
import { MEMORY_CONSOLIDATE_PROMPT } from "@/lib/memory/write/run-memory-extraction"
import { MODULE_PROMPTS } from "@/lib/modules/generated/prompts"
import type { ModulePromptsEntry } from "@/lib/modules/manifest-types"
import { prompts as petPrompts } from "@/lib/pet/prompts"
import { RADAR_SYSTEM_PROMPT } from "@/lib/radar/prompts"

const repoRoot = path.resolve(__dirname, "../..")

const isDefinition = (value: unknown): value is PromptDefinitionV1 =>
  typeof value === "object" && value !== null && "defaultBody" in value && "consumers" in value

/**
 * Names under which `value` (bound to `name`) holds `def`: `name` itself, a
 * `name.key` path through plain objects, or `name` for a Map or array whose
 * members are picked at run time.
 */
function handlesOf(value: unknown, def: PromptDefinitionV1, name: string, depth = 0): string[] {
  if (value === def) return [name]
  if (depth > 3 || value === null || typeof value !== "object" || isDefinition(value)) return []
  if (value instanceof Map || Array.isArray(value)) {
    const members = value instanceof Map ? [...value.values()] : value
    return members.some((member) => handlesOf(member, def, name, depth + 1).length > 0)
      ? [name]
      : []
  }
  return Object.entries(value).flatMap(([key, member]) =>
    handlesOf(member, def, /^[A-Za-z_$][\w$]*$/.test(key) ? `${name}.${key}` : name, depth + 1)
  )
}

/** Source text without comments, imports, declarations and the `prompts` listing. */
function withoutDeclarations(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*import\s+(?:type\s+)?[\w$*\s{},]+\s+from\s*"[^"]+";?/gm, "")
    .replace(/^export const prompts\b[\s\S]*?^\]/m, "")
    .replace(/\b(?:export\s+)?(?:const|let|var|function)\s+[A-Za-z_$][\w$]*/g, "")
}

function usesHandle(source: string, handle: string): boolean {
  const escaped = handle.replace(/[.$]/g, "\\$&")
  if (new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`).test(source)) return true
  // A whole collection consumed by computed key or spread binds its members.
  const [collection, ...rest] = handle.split(".")
  if (rest.length === 0) return false
  const name = collection.replace(/\$/g, "\\$")
  return new RegExp(`(?<![\\w$.])${name}\\s*\\[|\\.\\.\\.\\s*${name}(?![\\w$])`).test(source)
}

function moduleFile(specifier: string): string {
  const base = path.join(repoRoot, specifier.replace(/^@\//, ""))
  const file = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(existsSync)
  if (!file) throw new Error(`no source for ${specifier}`)
  return file
}

function importedSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8")
  return [...source.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].flatMap(([, specifier]) => {
    if (specifier.startsWith("@/")) return [specifier]
    if (specifier.startsWith(".")) {
      return [`@/${path.relative(repoRoot, path.resolve(path.dirname(file), specifier))}`]
    }
    return []
  })
}

/**
 * Every exported binding of the modules the catalog and each module's
 * `prompts` contribution import, the files where definitions are declared.
 */
async function loadPromptHolders(): Promise<Array<[string, unknown]>> {
  const registry = readFileSync(moduleFile("@/lib/modules/generated/prompts"), "utf8")
  const contributions = [...registry.matchAll(/load: \(\) => import\("(@\/[^"]+)"\)/g)].map(
    ([, specifier]) => specifier
  )
  expect(contributions).toHaveLength(MODULE_PROMPTS.length)
  const roots = ["@/lib/prompts/catalog", ...contributions]
  const specifiers = new Set(roots)
  for (const root of roots) {
    for (const specifier of importedSpecifiers(moduleFile(root))) specifiers.add(specifier)
  }
  const holders: Array<[string, unknown]> = []
  for (const specifier of specifiers) {
    const namespace = (await import(specifier)) as Record<string, unknown>
    for (const [name, value] of Object.entries(namespace)) {
      if (name !== "prompts" && name !== "default" && name !== "PROMPT_DEFINITIONS") {
        holders.push([name, value])
      }
    }
  }
  return holders
}

/**
 * Families a consumer picks through an accessor at run time instead of by
 * name. `reaches` calls the accessor, so a pin that stops returning the slot
 * fails; `use` is the call the consumer must still make.
 */
const ACCESSOR_BINDINGS: ReadonlyArray<{
  consumer: string
  use: RegExp
  reaches: (def: PromptDefinitionV1) => boolean
}> = [
  {
    consumer: "lib/claude/build-options.ts",
    use: /\bshippedModePrompt\(/,
    reaches: (def) => {
      const modeId = [...BUILT_IN_MODE_PROMPTS].find(([, candidate]) => candidate === def)?.[0]
      return modeId !== undefined && shippedModePrompt(modeId, def.defaultBody) === def
    },
  },
  {
    consumer: "lib/agent/builtin-catalog/catalog.ts",
    use: /\bresolvePrompt\(entry\.identity\)/,
    reaches: (def) => builtinAgents().some((entry) => entry.identity === def),
  },
  {
    // The judge prompt every consolidating write path shares, resolved once
    // in `run-memory-extraction.ts`.
    consumer: "lib/memory/write/run-project-mining.ts",
    use: /\bresolveConsolidateSystemPrompt\(/,
    reaches: (def) => def === MEMORY_CONSOLIDATE_PROMPT,
  },
]

describe("prompt catalog", () => {
  // Shipped definitions and every module's contribution: the contract checks
  // below hold for both.
  let defs: readonly PromptDefinitionV1[] = []
  beforeAll(async () => {
    expect(await loadPromptCatalog()).toEqual({ failures: [] })
    defs = listPromptDefinitions()
  })

  it("indexes the pure executor definition without depending on executor initialization", () => {
    expect(getPromptDefinition(EXECUTOR_FALLBACK_PROMPT.id)).toBe(EXECUTOR_FALLBACK_PROMPT)
  })

  it("registers the mounted AI Shell planning and error advisor consumers", () => {
    expect(getPromptDefinition("developer.ai-shell.plan")).toMatchObject({
      consumers: ["lib/terminal/ai-shell/plan-generator.ts"],
      activation: "next-operation",
      risk: "protocol",
    })
    expect(getPromptDefinition("developer.ai-shell.error-advisor")).toMatchObject({
      consumers: ["lib/terminal/ai-shell/error-advisor.ts"],
      activation: "next-operation",
      risk: "protocol",
    })
  })

  it("has unique namespaced ids that resolve back to their definition", () => {
    const ids = defs.map((def) => def.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const def of defs) {
      expect(def.id).toMatch(/^[a-z][a-z0-9-]*(\.[A-Za-z0-9-]+)+$/)
      expect(getPromptDefinition(def.id)).toBe(def)
    }
  })

  it("ships defaults that satisfy their own contract", () => {
    for (const def of defs) {
      const issues =
        def.operation === "inspect-only" ? [] : validatePromptBody(def, def.defaultBody)
      expect({ id: def.id, issues }).toEqual({ id: def.id, issues: [] })
    }
  })

  // Acceptance A16: an entry nothing resolves would be an editor control with
  // no effect. Every declared consumer must exist and resolve through the
  // resolver; reading `.defaultBody` would silently ignore every override.
  it("names consumers that exist and actually resolve the definition", () => {
    for (const def of defs) {
      expect(def.consumers.length).toBeGreaterThan(0)
      for (const consumer of def.consumers) {
        const file = path.join(repoRoot, consumer)
        expect({ id: def.id, consumer, exists: existsSync(file) }).toEqual({
          id: def.id,
          consumer,
          exists: true,
        })
        const source = readFileSync(file, "utf8")
        const resolves =
          def.operation === "inspect-only" || /\bresolve(Turn)?Prompt(Async)?\(/.test(source)
        expect({ id: def.id, consumer, resolves }).toEqual({ id: def.id, consumer, resolves: true })
      }
    }
  })

  // A consumer that resolves some other slot proves nothing about this one.
  // Each editable slot's every consumer must reach this definition: by its
  // id, by a name whose value holds it (read from the modules the catalog
  // and the module contributions load), or through a pinned accessor that is
  // called here, so a consumer that drops the slot fails the test.
  it("binds every editable slot to each of its consumers", async () => {
    const holders = await loadPromptHolders()
    const unbound: string[] = []
    for (const def of defs) {
      if (def.operation === "inspect-only") continue
      const handles = holders.flatMap(([name, value]) => handlesOf(value, def, name))
      for (const consumer of def.consumers) {
        const raw = readFileSync(path.join(repoRoot, consumer), "utf8")
        const source = withoutDeclarations(raw)
        const bound =
          raw.includes(`"${def.id}"`) ||
          handles.some((handle) => usesHandle(source, handle)) ||
          ACCESSOR_BINDINGS.some(
            (binding) =>
              binding.consumer === consumer && binding.use.test(source) && binding.reaches(def)
          )
        if (!bound) unbound.push(`${def.id} <- ${consumer}`)
      }
    }
    expect(unbound).toEqual([])
  })

  it("pins accessor bindings that still reach their slots", () => {
    for (const binding of ACCESSOR_BINDINGS) {
      const reached = defs.filter((def) => binding.reaches(def))
      expect({ consumer: binding.consumer, reached: reached.length > 0 }).toEqual({
        consumer: binding.consumer,
        reached: true,
      })
      for (const def of reached) expect(def.consumers).toContain(binding.consumer)
    }
  })

  it("gives every editable entry at least one scope and inspect-only entries none", () => {
    for (const def of defs) {
      if (def.operation === "inspect-only") expect(def.scopes).toEqual([])
      else expect(def.scopes.length).toBeGreaterThan(0)
    }
  })
})

describe("slot binding guard", () => {
  it("does not count a slot's import, declaration or listing as a use", () => {
    const source = withoutDeclarations(
      [
        `import { A_PROMPT, B_PROMPT } from "./prompts"`,
        `export const C_PROMPT = definePrompt({ id: "x.c" })`,
        "export const prompts = [",
        "  A_PROMPT,",
        "  C_PROMPT,",
        "]",
        "// A_PROMPT is resolved elsewhere",
        "export const text = resolvePrompt(B_PROMPT).text",
      ].join("\n")
    )
    expect(usesHandle(source, "A_PROMPT")).toBe(false)
    expect(usesHandle(source, "C_PROMPT")).toBe(false)
    expect(usesHandle(source, "B_PROMPT")).toBe(true)
  })

  it("binds a collection member by its path, a computed key or a spread", () => {
    expect(usesHandle("resolvePrompt(PROMPTS.bubble)", "PROMPTS.bubble")).toBe(true)
    expect(usesHandle("resolvePrompt(PROMPTS.other)", "PROMPTS.bubble")).toBe(false)
    expect(usesHandle("resolvePrompt(PROMPTS[key])", "PROMPTS.bubble")).toBe(true)
    expect(usesHandle("const all = { ...PROMPTS }", "PROMPTS.bubble")).toBe(true)
    expect(usesHandle("resolvePrompt(OTHER_PROMPTS.bubble)", "PROMPTS.bubble")).toBe(false)
  })

  it("finds the handles that hold a definition", () => {
    const target = { ...RADAR_SYSTEM_PROMPT, id: "x.target" } as PromptDefinitionV1
    expect(handlesOf(target, target, "TARGET")).toEqual(["TARGET"])
    expect(handlesOf({ bubble: target, other: RADAR_SYSTEM_PROMPT }, target, "PET")).toEqual([
      "PET.bubble",
    ])
    expect(handlesOf(new Map([["mode", target]]), target, "MODES")).toEqual(["MODES"])
    expect(handlesOf([{ identity: target }], target, "ENTRIES")).toEqual(["ENTRIES"])
    expect(handlesOf({ other: RADAR_SYSTEM_PROMPT }, target, "PET")).toEqual([])
  })
})

describe("module prompt contributions", () => {
  const def = (id: string) => ({ ...RADAR_SYSTEM_PROMPT, id }) as PromptDefinitionV1
  const entry = (
    module: string,
    prompts: readonly PromptDefinitionV1[],
    stage: ModulePromptsEntry["stage"] = "stable"
  ): ModulePromptsEntry => ({ module, stage, load: async () => ({ prompts }) })

  beforeEach(() => {
    __resetModulePromptsForTests()
    jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())
  afterAll(() => __resetModulePromptsForTests())

  it("lists a module's prompts only once the catalog has loaded them", async () => {
    expect(getPromptDefinition(RADAR_SYSTEM_PROMPT.id)).toBeUndefined()
    expect(listPromptDefinitions()).toBe(PROMPT_DEFINITIONS)
    await loadPromptCatalog()
    expect(getPromptDefinition(RADAR_SYSTEM_PROMPT.id)).toBe(RADAR_SYSTEM_PROMPT)
    for (const prompt of petPrompts) expect(getPromptDefinition(prompt.id)).toBe(prompt)
  })

  it("reads the pet and radar contributions from the generated registry, by module id", async () => {
    expect(MODULE_PROMPTS.map((item) => item.module)).toEqual(
      expect.arrayContaining(["pet", "radar"])
    )
    await loadPromptCatalog()
    const listed = listPromptDefinitions()
    expect(listed.slice(0, PROMPT_DEFINITIONS.length)).toEqual(PROMPT_DEFINITIONS)
    const tail = listed.slice(PROMPT_DEFINITIONS.length).map((item) => item.id)
    expect(tail.indexOf(RADAR_SYSTEM_PROMPT.id)).toBeGreaterThan(tail.indexOf(petPrompts[0].id))
  })

  it("loads each module once, even across concurrent calls", async () => {
    const load = jest.fn(async () => ({ prompts: [def("test.once")] }))
    const entries = [{ module: "once", stage: "stable" as const, load }]
    await Promise.all([loadPromptCatalog(entries), loadPromptCatalog(entries)])
    await loadPromptCatalog(entries)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("leaves an experimental module out", async () => {
    await loadPromptCatalog([entry("lab", [def("test.lab")], "experimental")])
    expect(getPromptDefinition("test.lab")).toBeUndefined()
  })

  it("reports a module that fails, keeps the others and retries it next time", async () => {
    const load = jest
      .fn<Promise<{ prompts: readonly PromptDefinitionV1[] }>, []>()
      .mockRejectedValueOnce(new Error("chunk"))
      .mockResolvedValue({ prompts: [def("test.flaky")] })
    const entries = [
      { module: "flaky", stage: "stable" as const, load },
      entry("steady", [def("test.steady")]),
    ]
    const first = await loadPromptCatalog(entries)
    expect(first.failures).toEqual([{ module: "flaky", error: new Error("chunk") }])
    expect(console.warn).toHaveBeenCalled()
    expect(getPromptDefinition("test.steady")).toBeDefined()
    expect(getPromptDefinition("test.flaky")).toBeUndefined()
    expect(await loadPromptCatalog(entries)).toEqual({ failures: [] })
    expect(getPromptDefinition("test.flaky")).toBeDefined()
  })

  it("refuses a module that repeats a shipped id, another module's id or its own", async () => {
    const { failures } = await loadPromptCatalog([
      entry("first", [def("test.mine")]),
      entry("shipped", [def(EXECUTOR_FALLBACK_PROMPT.id)]),
      entry("second", [def("test.mine")]),
      entry("twice", [def("test.twice"), def("test.twice")]),
    ])
    expect(failures.map((failure) => failure.module)).toEqual(["shipped", "second", "twice"])
    expect(getPromptDefinition(EXECUTOR_FALLBACK_PROMPT.id)).toBe(EXECUTOR_FALLBACK_PROMPT)
    expect(getPromptDefinition("test.twice")).toBeUndefined()
  })
})
