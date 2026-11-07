import type {
  ModuleToolFamily,
  ModuleToolsEntry,
  ToolCallContext,
  ToolSurfaceContext,
} from "@/lib/modules/manifest-types"
import {
  __resetContributedToolsForTests,
  collectContributedTools,
  contributedToolPluginId,
  findContributedTool,
  rulesetForTools,
  runContributedTool,
  toolSurfaceHost,
} from "./tool-contributions"
import {
  __resetContextSessionStateForTests,
  replaceContextSessionState,
} from "./context-session-state"

const ctx: ToolSurfaceContext = {
  session: null,
  agent: null,
  settings: null,
  activeGoal: null,
  prompts: { snapshot: null, context: {} },
  host: "desktop",
  activeProject: null,
}

const schema = { type: "object", properties: {} }
const tool = (name: string) => ({ name, description: `${name} does a thing`, jsonSchema: schema })

function family(overrides: Partial<ModuleToolFamily> = {}): ModuleToolFamily {
  return { surface: () => null, run: async () => ({ ok: true }), ...overrides }
}

function entry(
  module: string,
  declare: ModuleToolsEntry["declare"],
  toolFamily: ModuleToolFamily | (() => Promise<never>),
  stage: ModuleToolsEntry["stage"] = "stable"
): ModuleToolsEntry {
  return {
    module,
    stage,
    declare,
    load:
      typeof toolFamily === "function"
        ? (toolFamily as () => Promise<never>)
        : async () => ({ toolFamily }),
  }
}

const crate = (toolFamily: ModuleToolFamily | (() => Promise<never>)) =>
  entry(
    "crate",
    {
      crate_list: { consent: "allow", effect: "read" },
      crate_tidy: { consent: "ask", effect: "write" },
      crate_send: { consent: "per-call", effect: "outbound" },
    },
    toolFamily
  )

beforeEach(() => {
  __resetContributedToolsForTests()
  __resetContextSessionStateForTests()
  jest.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe("collectContributedTools", () => {
  it("offers what a family surfaces, with the tier derived from those tools alone", async () => {
    const surface = jest.fn(() => ({
      tools: [tool("crate_list"), tool("crate_send")],
      instructions: "  Use the crate tools for crates.  ",
    }))
    const result = await collectContributedTools(ctx, [crate(family({ surface }))])
    expect(surface).toHaveBeenCalledWith({ ...ctx, sessionState: expect.any(Function) })
    expect(result.skipped).toEqual([])
    expect(result.tools).toEqual([
      { ...tool("crate_list"), pluginId: "cognia-crate-builtin" },
      { ...tool("crate_send"), pluginId: "cognia-crate-builtin", requiresApproval: true },
    ])
    // crate_tidy is declared but not offered, so it has no tier entry.
    expect(result.ruleset).toEqual({
      crate_list: "allow",
      "mcp__cognia-plugin-tools__crate_list": "allow",
      crate_send: "ask",
      "mcp__cognia-plugin-tools__crate_send": "ask",
    })
    expect(result.instructions).toEqual(["Use the crate tools for crates."])
  })

  it("passes the optional wire fields through", async () => {
    const surface = () => ({
      tools: [
        { ...tool("crate_tidy"), timeoutMs: 5000, pathParams: ["dir"], access: "write" as const },
      ],
    })
    const { tools } = await collectContributedTools(ctx, [crate(family({ surface }))])
    expect(tools[0]).toMatchObject({ timeoutMs: 5000, pathParams: ["dir"], access: "write" })
  })

  it("offers nothing, and no tier, for a family that answers null or an empty list", async () => {
    for (const surface of [() => null, () => ({ tools: [], instructions: "unused" })]) {
      __resetContributedToolsForTests()
      const result = await collectContributedTools(ctx, [crate(family({ surface }))])
      expect(result).toEqual({ tools: [], ruleset: {}, instructions: [], skipped: [] })
    }
  })

  it("orders families by their registry order and keeps a healthy one when another fails", async () => {
    const result = await collectContributedTools(ctx, [
      entry(
        "alpha",
        { alpha_a: { consent: "allow", effect: "read" } },
        family({
          surface: () => ({ tools: [tool("alpha_a")] }),
        })
      ),
      entry(
        "beta",
        { beta_b: { consent: "allow", effect: "read" } },
        family({
          surface: () => {
            throw new Error("boom")
          },
        })
      ),
      crate(family({ surface: () => ({ tools: [tool("crate_list")] }) })),
    ])
    expect(result.tools.map((t) => t.name)).toEqual(["alpha_a", "crate_list"])
    expect(result.skipped).toEqual([{ module: "beta", error: new Error("boom") }])
  })

  it("refuses a whole family that offers an undeclared tool, a duplicate or a malformed entry", async () => {
    const offers = [
      [tool("crate_list"), tool("crate_unknown")],
      [tool("crate_list"), tool("crate_list")],
      [{ ...tool("crate_list"), description: " " }],
      [{ ...tool("crate_list"), jsonSchema: [] as never }],
    ]
    for (const tools of offers) {
      __resetContributedToolsForTests()
      const result = await collectContributedTools(ctx, [
        crate(family({ surface: () => ({ tools }) })),
      ])
      expect(result.tools).toEqual([])
      expect(result.ruleset).toEqual({})
      expect(result.skipped).toHaveLength(1)
    }
  })

  it("refuses a family offering a tool another module already offered", async () => {
    const result = await collectContributedTools(ctx, [
      entry(
        "alpha",
        { crate_list: { consent: "allow", effect: "read" } },
        family({
          surface: () => ({ tools: [tool("crate_list")] }),
        })
      ),
      crate(family({ surface: () => ({ tools: [tool("crate_list")] }) })),
    ])
    expect(result.tools.map((t) => t.pluginId)).toEqual(["cognia-alpha-builtin"])
    expect(String(result.skipped[0].error)).toContain("already offered by another module")
  })

  it("skips a family whose file does not load or exports no usable family, and retries the load", async () => {
    const load = jest
      .fn<Promise<{ toolFamily: ModuleToolFamily }>, []>()
      .mockRejectedValueOnce(new Error("chunk"))
      .mockResolvedValue({
        toolFamily: family({ surface: () => ({ tools: [tool("crate_list")] }) }),
      })
    const flaky: ModuleToolsEntry = { ...crate(family()), load }
    const first = await collectContributedTools(ctx, [flaky])
    expect(first.tools).toEqual([])
    expect(first.skipped).toEqual([{ module: "crate", error: new Error("chunk") }])
    const second = await collectContributedTools(ctx, [flaky])
    expect(second.tools).toHaveLength(1)

    __resetContributedToolsForTests()
    const broken: ModuleToolsEntry = {
      ...crate(family()),
      load: async () => ({ toolFamily: { surface: () => null } as never }),
    }
    const result = await collectContributedTools(ctx, [broken])
    expect(String(result.skipped[0].error)).toContain("toolFamily.run is not a function")
  })

  it("holds every family to one deadline", async () => {
    const result = await collectContributedTools(
      ctx,
      [crate(family({ surface: () => new Promise(() => {}) }))],
      10
    )
    expect(String(result.skipped[0].error)).toContain("no answer within 10 ms")
  })

  it("lets a family's surface read only its own module's context session state", async () => {
    replaceContextSessionState(
      "s1",
      new Map<string, unknown>([
        ["crate.scope", { ids: ["a"] }],
        ["other.scope", { ids: ["b"] }],
      ])
    )
    let seen: unknown[] = []
    const surface = jest.fn((surfaceCtx: ToolSurfaceContext) => {
      seen = [surfaceCtx.sessionState?.("scope"), surfaceCtx.sessionState?.("missing")]
      return null
    })
    const session = { id: "s1" } as ToolSurfaceContext["session"]
    await collectContributedTools({ ...ctx, session }, [crate(family({ surface }))])
    expect(seen).toEqual([{ ids: ["a"] }, undefined])
    await collectContributedTools(ctx, [crate(family({ surface }))])
    expect(seen).toEqual([undefined, undefined])
  })

  it("asks nothing of an experimental module", async () => {
    const load = jest.fn()
    const result = await collectContributedTools(ctx, [
      { module: "lab", stage: "experimental", declare: {}, load },
    ])
    expect(result).toEqual({ tools: [], ruleset: {}, instructions: [], skipped: [] })
    expect(load).not.toHaveBeenCalled()
  })
})

describe("dispatch", () => {
  const call: ToolCallContext = {
    sessionId: "s1",
    toolUseId: "u1",
    executionRunId: "run-1",
    outboundAuthorization: { kind: "tool-call", sessionId: "s1", toolUseId: "u1" },
  }

  it("finds a declared tool by its bare name, never by the prefixed one or for an experimental module", () => {
    const entries = [
      crate(family()),
      entry("lab", { lab_x: { consent: "allow", effect: "read" } }, family(), "experimental"),
    ]
    expect(findContributedTool("crate_send", entries)).toMatchObject({
      module: "crate",
      declaration: { consent: "per-call" },
    })
    expect(findContributedTool("mcp__cognia-plugin-tools__crate_send", entries)).toBeUndefined()
    expect(findContributedTool("lab_x", entries)).toBeUndefined()
    expect(findContributedTool("other", entries)).toBeUndefined()
  })

  it("runs the call through the declaring family, loading it once", async () => {
    const run = jest.fn(async () => ({ ok: true, listed: 3 }))
    const load = jest.fn(async () => ({ toolFamily: family({ run }) }))
    const entries: ModuleToolsEntry[] = [{ ...crate(family()), load }]
    const found = findContributedTool("crate_list", entries)!
    await expect(runContributedTool(found, { limit: 3 }, call)).resolves.toEqual({
      ok: true,
      listed: 3,
    })
    await runContributedTool(found, {}, call)
    expect(run).toHaveBeenCalledWith("crate_list", { limit: 3 }, expect.objectContaining(call))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("lets a call read only its own module's context session state", async () => {
    replaceContextSessionState(
      "s1",
      new Map<string, unknown>([
        ["crate.scope", { ids: ["a"] }],
        ["other.scope", { ids: ["b"] }],
      ])
    )
    let seen: unknown[] = []
    const run = jest.fn(async (_name: string, _args: unknown, ctx: ToolCallContext) => {
      seen = [ctx.sessionState?.("scope"), ctx.sessionState?.("missing")]
      return { ok: true }
    })
    const found = findContributedTool("crate_list", [crate(family({ run }))])!
    await runContributedTool(found, {}, call)
    expect(seen).toEqual([{ ids: ["a"] }, undefined])
  })
})

describe("helpers", () => {
  it("names the plugin id and derives verdicts for both spellings", () => {
    expect(contributedToolPluginId("filespace")).toBe("cognia-filespace-builtin")
    expect(
      rulesetForTools([{ name: "x_tidy", declaration: { consent: "ask", effect: "write" } }])
    ).toEqual({ x_tidy: "ask", "mcp__cognia-plugin-tools__x_tidy": "ask" })
    // `"default"` writes no rule: the run's own approval decides.
    expect(
      rulesetForTools([{ name: "x_peek", declaration: { consent: "default", effect: "read" } }])
    ).toEqual({})
  })

  it("reads the host from the platform markers", () => {
    expect(toolSurfaceHost()).toBe("web")
    ;(globalThis as Record<string, unknown>).__COGNIA_CLI__ = true
    expect(toolSurfaceHost()).toBe("cli")
    delete (globalThis as Record<string, unknown>).__COGNIA_CLI__
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    expect(toolSurfaceHost()).toBe("brain")
    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
  })
})
