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
import { EXECUTOR_FALLBACK_PROMPT } from "@/lib/agent/prompts/executor"
import { MODULE_PROMPTS } from "@/lib/modules/generated/prompts"
import type { ModulePromptsEntry } from "@/lib/modules/manifest-types"
import { prompts as petPrompts } from "@/lib/pet/prompts"
import { RADAR_SYSTEM_PROMPT } from "@/lib/radar/prompts"

const repoRoot = path.resolve(__dirname, "../..")

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

  it("gives every editable entry at least one scope and inspect-only entries none", () => {
    for (const def of defs) {
      if (def.operation === "inspect-only") expect(def.scopes).toEqual([])
      else expect(def.scopes.length).toBeGreaterThan(0)
    }
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
