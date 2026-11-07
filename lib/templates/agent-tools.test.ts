import { TemplateCatalog } from "./catalog"
import { createTemplateDefinition } from "./contracts"
import type { TemplateRuntime } from "./runtime"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import type { ToolSurfaceContext } from "@/lib/modules/manifest-types"

import { LIST_MAX_ITEMS, READ_CONTENT_MAX_CHARS } from "./agent-tool-kit"
import {
  TEMPLATE_TOOL_NAMES,
  __setTemplateToolDepsForTesting,
  buildTemplateToolEntries,
  runTemplateTool,
  toolFamily,
  type TemplateToolDeps,
} from "./agent-tools"

async function definition(overrides: Partial<Parameters<typeof createTemplateDefinition>[0]> = {}) {
  return createTemplateDefinition({
    id: "user.workflow.one",
    domain: "workflow",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Nightly digest", description: "Summarise the day", tags: ["ops"] },
    payload: { nodes: [] },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web"] },
    provenance: { source: "user", trust: "unsigned" },
    ...overrides,
  })
}

const chatRow: ChatTemplateRow = {
  id: "ct-1",
  name: "Standup",
  description: "Daily standup prompt",
  body: "What did {{who}} do yesterday?",
  params: [{ id: "who", label: "Who", required: true, kind: "string" }],
  revision: 3,
  usageCount: 4,
  lastUsedAt: 20,
  createdAt: 1,
  updatedAt: 10,
}

interface PreflightInput {
  definitionId: string
  platform: string
}

interface Harness {
  deps: TemplateToolDeps
  catalog: TemplateCatalog
  consent: jest.Mock
  preflight: jest.Mock
  instantiate: jest.Mock
}

function harness(overrides: Partial<TemplateToolDeps> = {}): Harness {
  const catalog = new TemplateCatalog()
  const consent = jest.fn(async () => true)
  const preflight = jest.fn(async (input: PreflightInput) => ({
    definitionId: input.definitionId,
    definitionHash: "h",
    platform: input.platform,
    status: "ready",
    bindings: [],
    issues: [{ code: "x.warn", severity: "warning", message: "heads up" }],
    operations: [],
    requiresConfirmation: false,
  }))
  const instantiate = jest.fn(async () => ({
    resources: [{ domain: "workflow", id: "wf-9" }],
    rollbackToken: null,
  }))
  const runtime: TemplateRuntime = {
    catalog,
    repository: {} as TemplateRuntime["repository"],
    service: { preflight, instantiate } as unknown as TemplateRuntime["service"],
  }
  const deps: TemplateToolDeps = {
    runtime,
    platform: "desktop",
    consent,
    chatTemplates: {
      list: async () => [chatRow],
      get: async (id) => (id === chatRow.id ? chatRow : undefined),
    },
    ...overrides,
  }
  return { deps, catalog, consent, preflight, instantiate }
}

function surfaceCtx(fields: Partial<ToolSurfaceContext> = {}): ToolSurfaceContext {
  return {
    session: { id: "s1" } as ToolSurfaceContext["session"],
    agent: null,
    settings: { selfInvokeTools: { templates: true } } as ToolSurfaceContext["settings"],
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
    ...fields,
  }
}

afterEach(() => __setTemplateToolDepsForTesting(null))

describe("surface", () => {
  it("offers every template tool, each with a closed schema, once opted in", async () => {
    const surface = await toolFamily.surface(surfaceCtx())
    expect(surface?.tools.map((tool) => tool.name).sort()).toEqual(
      Object.values(TEMPLATE_TOOL_NAMES).sort()
    )
    for (const entry of buildTemplateToolEntries()) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.jsonSchema.additionalProperties).toBe(false)
    }
  })

  it("offers nothing unless opted in, nor to an IM-bound session or the CLI", async () => {
    expect(await toolFamily.surface(surfaceCtx({ settings: null }))).toBeNull()
    expect(
      await toolFamily.surface(
        surfaceCtx({
          session: { id: "s1", platformBinding: { adapterId: "telegram" } } as never,
        })
      )
    ).toBeNull()
    expect(await toolFamily.surface(surfaceCtx({ host: "cli" }))).toBeNull()
  })

  it("runs a call through the injected deps", async () => {
    const h = harness()
    __setTemplateToolDepsForTesting(() => h.deps)
    const call = {
      sessionId: "s1",
      toolUseId: "tu-1",
      executionRunId: "run-1",
      outboundAuthorization: { kind: "tool-call", sessionId: "s1", toolUseId: "tu-1" },
    } as const
    expect(await toolFamily.run("chat_template_list", {}, call)).toMatchObject({
      ok: true,
      total: 1,
    })
  })
})

describe("template_list / template_get", () => {
  it("lists the catalog with domain and text filters", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [
      await definition(),
      await definition({ id: "user.skill.two", domain: "skill", metadata: { name: "Lint" } }),
    ])
    const all = (await runTemplateTool("template_list", {}, h.deps)) as {
      templates: Array<{ id: string }>
      total: number
    }
    expect(all.total).toBe(2)
    const skills = (await runTemplateTool("template_list", { domain: "skill" }, h.deps)) as {
      templates: Array<{
        id: string
        domain: string
      }>
    }
    expect(skills.templates).toEqual([expect.objectContaining({ id: "user.skill.two" })])
    const byText = (await runTemplateTool("template_list", { query: "digest" }, h.deps)) as {
      templates: Array<{ id: string }>
    }
    expect(byText.templates.map((t) => t.id)).toEqual(["user.workflow.one"])
  })

  it("refuses an unknown domain and caps the listing", async () => {
    const h = harness()
    expect(await runTemplateTool("template_list", { domain: "bogus" }, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "invalid_arguments" })
    )
    const many = await Promise.all(
      Array.from({ length: LIST_MAX_ITEMS + 5 }, (_, i) =>
        definition({ id: `user.workflow.${i}`, metadata: { name: `W${i}` } })
      )
    )
    h.catalog.replaceSource("user", many)
    const result = (await runTemplateTool("template_list", {}, h.deps)) as {
      templates: unknown[]
      total: number
      truncated: boolean
    }
    expect(result.templates).toHaveLength(LIST_MAX_ITEMS)
    expect(result.total).toBe(LIST_MAX_ITEMS + 5)
    expect(result.truncated).toBe(true)
  })

  it("reads one definition with its payload truncated", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [
      await definition({ payload: { blob: "x".repeat(READ_CONTENT_MAX_CHARS + 10) } }),
    ])
    const result = (await runTemplateTool("template_get", { id: "user.workflow.one" }, h.deps)) as {
      ok: boolean
      truncated: boolean
      payloadLength: number
      tags: string[]
      version: string
    }
    expect(result.ok).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.payloadLength).toBeGreaterThan(READ_CONTENT_MAX_CHARS)
    expect(result.tags).toEqual(["ops"])
    expect(result.version).toBe("1.0.0")
    expect(await runTemplateTool("template_get", { id: "missing" }, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "not_found" })
    )
    expect(await runTemplateTool("template_get", {}, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "invalid_arguments" })
    )
  })
})

describe("template_instantiate", () => {
  it("preflights, asks the user, then instantiates with the user's answer", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [await definition()])
    const result = (await runTemplateTool(
      "template_instantiate",
      { id: "user.workflow.one", bindings: { slot: "res-1" } },
      h.deps
    )) as {
      ok: boolean
      resources: unknown[]
      warnings: unknown[]
    }
    expect(h.preflight).toHaveBeenCalledWith({
      definitionId: "user.workflow.one",
      version: "1.0.0",
      platform: "desktop",
      bindings: { slot: "res-1" },
    })
    expect(h.consent).toHaveBeenCalledWith("templates:instantiate", "instantiate:user.workflow.one")
    expect(h.instantiate).toHaveBeenCalledWith({
      plan: expect.objectContaining({ status: "ready" }),
      confirmed: true,
    })
    expect(result.ok).toBe(true)
    expect(result.resources).toEqual([{ domain: "workflow", id: "wf-9" }])
    expect(result.warnings).toHaveLength(1)
  })

  it("does not ask when the preflight is blocked, and does not write when declined", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [await definition()])
    h.preflight.mockResolvedValueOnce({
      status: "blocked",
      issues: [{ code: "platform.unsupported", severity: "blocker", message: "not here" }],
    })
    const blocked = await runTemplateTool(
      "template_instantiate",
      { id: "user.workflow.one" },
      h.deps
    )
    expect(blocked).toEqual(
      expect.objectContaining({
        ok: false,
        code: "preflight_blocked",
        issues: [{ code: "platform.unsupported", message: "not here" }],
      })
    )
    expect(h.consent).not.toHaveBeenCalled()

    h.consent.mockResolvedValueOnce(false)
    const declined = await runTemplateTool(
      "template_instantiate",
      { id: "user.workflow.one" },
      h.deps
    )
    expect(declined).toEqual(expect.objectContaining({ ok: false, code: "consent_denied" }))
    expect(h.instantiate).not.toHaveBeenCalled()
  })

  it("refuses a catalog-only domain and malformed bindings", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [
      await definition({ id: "chat.one", domain: "chatTemplate", metadata: { name: "C" } }),
      await definition(),
    ])
    expect(await runTemplateTool("template_instantiate", { id: "chat.one" }, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "catalog_only" })
    )
    expect(
      await runTemplateTool(
        "template_instantiate",
        { id: "user.workflow.one", bindings: ["nope"] },
        h.deps
      )
    ).toEqual(expect.objectContaining({ ok: false, code: "invalid_arguments" }))
    expect(h.preflight).not.toHaveBeenCalled()
  })
})

describe("chat_template_list / chat_template_get", () => {
  it("lists with a text filter and reads the body", async () => {
    const h = harness()
    const list = (await runTemplateTool("chat_template_list", {}, h.deps)) as {
      templates: Array<{
        id: string
        parameters: unknown[]
      }>
    }
    expect(list.templates).toEqual([
      expect.objectContaining({ id: "ct-1", parameters: [expect.objectContaining({ id: "who" })] }),
    ])
    const none = (await runTemplateTool("chat_template_list", { query: "zzz" }, h.deps)) as {
      templates: unknown[]
    }
    expect(none.templates).toEqual([])

    const one = (await runTemplateTool("chat_template_get", { id: "ct-1" }, h.deps)) as {
      ok: boolean
      body: string
      revision: number
    }
    expect(one.ok).toBe(true)
    expect(one.body).toBe(chatRow.body)
    expect(one.revision).toBe(3)
    expect(await runTemplateTool("chat_template_get", { id: "x" }, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "not_found" })
    )
  })
})

describe("failure contract", () => {
  it("never throws: a rejecting dependency becomes a structured failure", async () => {
    const h = harness({
      chatTemplates: {
        list: async () => {
          throw new Error("dexie closed")
        },
        get: async () => undefined,
      },
    })
    expect(await runTemplateTool("chat_template_list", {}, h.deps)).toEqual({
      ok: false,
      code: "tool_failed",
      error: "dexie closed",
    })
    expect(await runTemplateTool("what_is_this", {}, h.deps)).toEqual(
      expect.objectContaining({ ok: false, code: "invalid_arguments" })
    )
  })
})
