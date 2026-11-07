import type {
  ContextContribution,
  ContextTurnContext,
  ModuleContextEntry,
} from "@/lib/modules/manifest-types"
import {
  CONTEXT_CONTRIBUTION_MAX_DEADLINE_MS,
  __resetContextContributionsForTests,
  collectContextContributions,
  contextSourcesOf,
} from "./context-contributions"

const ctx: ContextTurnContext = {
  session: null,
  agent: null,
  settings: null,
  activeGoal: null,
  prompts: { snapshot: null, context: {} },
  host: "desktop",
  activeProject: null,
  query: { text: "what changed?", embedding: null },
  hostDeps: {},
  grant: null,
}

function entry(
  module: string,
  contributions: readonly ContextContribution[] | (() => Promise<never>),
  stage: ModuleContextEntry["stage"] = "stable"
): ModuleContextEntry {
  return {
    module,
    stage,
    load:
      typeof contributions === "function"
        ? (contributions as () => Promise<never>)
        : async () => ({ contributions }),
  }
}

const section = (
  id: string,
  text: string,
  fields: Partial<ContextContribution> = {}
): ContextContribution => ({
  id,
  cache: "turn",
  produce: () => ({ text }),
  ...fields,
})

beforeEach(() => {
  __resetContextContributionsForTests()
  jest.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe("placement", () => {
  it("puts turn sections in the tail by slot order, slot-less last, and module id within one", async () => {
    const entries = [
      entry("alpha", [section("status", "alpha status")]),
      entry("beta", [section("kb", "beta agent kb", { slot: "agent-knowledge" })]),
      entry("gamma", [
        section("pk", "gamma project kb", { slot: "project-knowledge" }),
        section("draft", "gamma draft"),
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.tail).toEqual([
      "gamma project kb",
      "beta agent kb",
      "alpha status",
      "gamma draft",
    ])
    expect(result.slots).toEqual({})
    expect(result.skipped).toEqual([])
  })

  it("moves slotted turn sections into their slots when cache optimization is off", async () => {
    const entries = [
      entry("alpha", [section("kb", "alpha kb", { slot: "agent-knowledge" })]),
      entry("beta", [
        section("kb", "beta kb", { slot: "agent-knowledge" }),
        section("status", "beta status"),
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: false }, entries)
    expect(result.slots).toEqual({ "agent-knowledge": ["alpha kb", "beta kb"] })
    expect(result.tail).toEqual(["beta status"])
  })

  it("always puts session sections in their slot", async () => {
    const entries = [
      entry("pc", [section("goal", "## Project goal", { cache: "session", slot: "project-goal" })]),
    ]
    for (const cacheOptimization of [true, false]) {
      const result = await collectContextContributions(ctx, { cacheOptimization }, entries)
      expect(result.slots).toEqual({ "project-goal": ["## Project goal"] })
      expect(result.tail).toEqual([])
    }
  })

  it("trims text and adds nothing for null or blank sections", async () => {
    const entries = [
      entry("alpha", [
        section("a", "  padded  "),
        { id: "b", cache: "turn", produce: () => null },
        section("c", "   "),
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.tail).toEqual(["padded"])
  })

  it("passes the run context to produce", async () => {
    const produce = jest.fn(() => null)
    await collectContextContributions(ctx, { cacheOptimization: true }, [
      entry("alpha", [{ id: "a", cache: "turn", produce }]),
    ])
    expect(produce).toHaveBeenCalledWith(ctx)
  })
})

describe("side outputs", () => {
  it("collects sources and session state by <module>.<id>, even beside blank text", async () => {
    const entries = [
      entry("kb", [
        {
          id: "agent",
          cache: "turn",
          slot: "agent-knowledge",
          produce: () => ({ text: "", sources: { chunks: 2 }, sessionState: { ids: ["x"] } }),
        },
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.sources).toEqual({ "kb.agent": { chunks: 2 } })
    expect([...result.sessionState]).toEqual([["kb.agent", { ids: ["x"] }]])
    expect(result.tail).toEqual([])
  })

  it("reads one contribution's sources from SendOptions.contextSources", () => {
    const read = contextSourcesOf as unknown as (
      sources: Record<string, unknown> | undefined,
      key: string
    ) => unknown
    expect(read({ "kb.agent": { chunks: 1 } }, "kb.agent")).toEqual({ chunks: 1 })
    expect(read(undefined, "kb.agent")).toBeUndefined()
  })
})

describe("PII gate", () => {
  const leaking = "Contact jane.doe@example.com for access."

  it("drops a leaking section and its sources but keeps its session state", async () => {
    const entries = [
      entry("kb", [
        {
          id: "agent",
          cache: "turn",
          produce: () => ({ text: leaking, sources: { s: 1 }, sessionState: { ids: [] } }),
        },
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.tail).toEqual([])
    expect(result.sources).toEqual({})
    expect(result.sessionState.get("kb.agent")).toEqual({ ids: [] })
    expect(String(result.skipped[0].error)).toContain("leaks PII")
  })

  it("lets a section redacted at its source through", async () => {
    const entries = [entry("twinish", [section("recall", leaking, { pii: "redacted-at-source" })])]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.tail).toEqual([leaking])
  })
})

describe("failure", () => {
  it("skips a module whose file does not load, keeps the others, and retries the load", async () => {
    const load = jest
      .fn<Promise<{ contributions: readonly ContextContribution[] }>, []>()
      .mockRejectedValueOnce(new Error("chunk"))
      .mockResolvedValue({ contributions: [section("a", "flaky")] })
    const entries: ModuleContextEntry[] = [
      { module: "flaky", stage: "stable", load },
      entry("steady", [section("a", "steady")]),
    ]
    const first = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(first.tail).toEqual(["steady"])
    expect(first.skipped).toEqual([{ key: "flaky", error: new Error("chunk") }])
    const second = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(second.tail).toEqual(["flaky", "steady"])
  })

  it("skips a contribution that throws or answers without text", async () => {
    const entries = [
      entry("alpha", [
        {
          id: "boom",
          cache: "turn",
          produce: () => {
            throw new Error("boom")
          },
        },
        { id: "shape", cache: "turn", produce: () => ({ text: 3 }) as never },
        section("fine", "fine"),
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.tail).toEqual(["fine"])
    expect(result.skipped.map((s) => s.key)).toEqual(["alpha.boom", "alpha.shape"])
  })

  it("holds each contribution to its deadline, the default or its own, capped", async () => {
    jest.useFakeTimers()
    try {
      const never = () => new Promise<never>(() => {})
      const entries = [
        entry("slow", [
          { id: "default", cache: "turn", produce: never },
          { id: "own", cache: "turn", deadlineMs: 50, produce: never },
          {
            id: "capped",
            cache: "turn",
            deadlineMs: CONTEXT_CONTRIBUTION_MAX_DEADLINE_MS * 10,
            produce: never,
          },
        ]),
      ]
      const pending = collectContextContributions(ctx, { cacheOptimization: true }, entries, 20)
      await jest.advanceTimersByTimeAsync(CONTEXT_CONTRIBUTION_MAX_DEADLINE_MS)
      const result = await pending
      expect(result.skipped.map((s) => [s.key, String(s.error)])).toEqual([
        ["slow.default", "Error: no answer within 20 ms"],
        ["slow.own", "Error: no answer within 50 ms"],
        ["slow.capped", `Error: no answer within ${CONTEXT_CONTRIBUTION_MAX_DEADLINE_MS} ms`],
      ])
    } finally {
      jest.useRealTimers()
    }
  })

  it("refuses a malformed contribution list as a whole module", async () => {
    const lists: unknown[] = [
      "nope",
      [{ cache: "turn", produce: () => null }],
      [section("a", "x"), section("a", "y")],
      [{ id: "a", cache: "always", produce: () => null }],
      [{ id: "a", cache: "turn", slot: "persona", produce: () => null }],
      [{ id: "a", cache: "session", produce: () => null }],
      [{ id: "a", cache: "turn", pii: "maybe", produce: () => null }],
      [{ id: "a", cache: "turn", deadlineMs: 0, produce: () => null }],
      [{ id: "a", cache: "turn" }],
    ]
    for (const contributions of lists) {
      __resetContextContributionsForTests()
      const result = await collectContextContributions(ctx, { cacheOptimization: true }, [
        { module: "bad", stage: "stable", load: async () => ({ contributions }) as never },
      ])
      expect(result.tail).toEqual([])
      expect(result.skipped).toHaveLength(1)
      expect(result.skipped[0].key).toBe("bad")
    }
  })

  it("asks nothing of an experimental module", async () => {
    const load = jest.fn()
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, [
      { module: "lab", stage: "experimental", load },
    ])
    expect(result).toEqual({
      slots: {},
      tail: [],
      sources: {},
      sessionState: new Map(),
      skipped: [],
    })
    expect(load).not.toHaveBeenCalled()
  })
})
