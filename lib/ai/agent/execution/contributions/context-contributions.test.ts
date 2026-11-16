import type {
  ContextContribution,
  ContextTurnContext,
  ModuleContextEntry,
} from "@/lib/modules/manifest-types"
import {
  CONTEXT_CONTRIBUTION_MAX_DEADLINE_MS,
  __resetContextContributionsForTests,
  collectContextContributions,
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
  kernelRetrieval: { identityTexts: [] },
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
})

describe("after", () => {
  it("runs a contribution after the one it names, with that one's handoff as prior", async () => {
    const order: string[] = []
    const seen: unknown[] = []
    const entries = [
      entry("mem", [
        {
          id: "continuity",
          cache: "turn",
          slot: "continuity",
          after: "recall",
          produce: (turnCtx) => {
            order.push("continuity")
            seen.push(turnCtx.prior)
            return { text: "claims" }
          },
        },
        {
          id: "recall",
          cache: "turn",
          slot: "memory",
          produce: async () => {
            await Promise.resolve()
            order.push("recall")
            return { text: "facts", handoff: { used: 120 } }
          },
        },
        section("other", "other"),
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(order).toEqual(["recall", "continuity"])
    expect(seen).toEqual([{ used: 120 }])
    // Placement stays by slot, whatever order they ran in.
    expect(result.tail).toEqual(["facts", "claims", "other"])
    // A handoff stays inside the resolution.
    expect(result.sources).toEqual({})
    expect([...result.sessionState]).toEqual([])
  })

  it.each([
    ["throws", () => Promise.reject(new Error("down"))],
    ["answers null", () => null],
    ["answers without text", () => ({ handoff: { used: 1 } }) as never],
    ["hands nothing over", () => ({ text: "facts" })],
  ])("gives no prior when the one waited for %s, and still runs", async (_label, produce) => {
    const prior = jest.fn()
    await collectContextContributions(ctx, { cacheOptimization: true }, [
      entry("mem", [
        { id: "recall", cache: "turn", produce: produce as ContextContribution["produce"] },
        {
          id: "continuity",
          cache: "turn",
          after: "recall",
          produce: (turnCtx) => {
            prior("prior" in turnCtx ? turnCtx.prior : "absent")
            return null
          },
        },
      ]),
    ])
    expect(prior).toHaveBeenCalledWith("absent")
  })

  it("gives no prior after the one waited for misses its deadline, and starts its own then", async () => {
    jest.useFakeTimers()
    try {
      const prior = jest.fn()
      const pending = collectContextContributions(
        ctx,
        { cacheOptimization: true },
        [
          entry("mem", [
            { id: "recall", cache: "turn", produce: () => new Promise<never>(() => {}) },
            {
              id: "continuity",
              cache: "turn",
              after: "recall",
              deadlineMs: 30,
              produce: (turnCtx) => {
                prior(turnCtx.prior)
                return new Promise<never>(() => {})
              },
            },
          ]),
        ],
        20
      )
      await jest.advanceTimersByTimeAsync(20)
      expect(prior).toHaveBeenCalledWith(undefined)
      await jest.advanceTimersByTimeAsync(30)
      const result = await pending
      expect(result.skipped.map((s) => [s.key, String(s.error)])).toEqual([
        ["mem.recall", "Error: no answer within 20 ms"],
        ["mem.continuity", "Error: no answer within 30 ms"],
      ])
    } finally {
      jest.useRealTimers()
    }
  })

  it("passes the run's kernel retrieval to every contribution", async () => {
    const produce = jest.fn(() => null)
    const withTwin = { ...ctx, kernelRetrieval: { identityTexts: ["twin chunk"] } }
    await collectContextContributions(withTwin, { cacheOptimization: true }, [
      entry("mem", [{ id: "recall", cache: "turn", produce }]),
    ])
    expect(produce).toHaveBeenCalledWith(withTwin)
  })
})

describe("identity", () => {
  const identity = (fields: Partial<ContextContribution> = {}): ContextContribution => ({
    id: "identity",
    cache: "turn",
    slot: "identity",
    deadlineMs: 15_000,
    produce: () => ({
      text: "I am Ada.\n\nRetrieved: shipped Tuesday",
      cacheSplit: { stable: "I am Ada.", dynamic: "Retrieved: shipped Tuesday" },
      handoff: ["shipped Tuesday", 42],
      sources: { chunks: 1 },
    }),
    ...fields,
  })

  it("replaces the base prompt with the stable part and leads the tail with the dynamic part", async () => {
    const entries = [
      entry("alpha", [section("status", "alpha status")]),
      entry("twin", [identity()]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.identity).toBe("I am Ada.")
    expect(result.tail).toEqual(["Retrieved: shipped Tuesday", "alpha status"])
    expect(result.slots).toEqual({})
    expect(result.sources).toEqual({ "twin.identity": { chunks: 1 } })
  })

  it("replaces the base prompt whole when cache optimization is off or there is no split", async () => {
    const off = await collectContextContributions(ctx, { cacheOptimization: false }, [
      entry("twin", [identity()]),
    ])
    expect(off.identity).toBe("I am Ada.\n\nRetrieved: shipped Tuesday")
    expect(off.tail).toEqual([])
    __resetContextContributionsForTests()
    const unsplit = await collectContextContributions(ctx, { cacheOptimization: true }, [
      entry("twin", [identity({ produce: () => ({ text: "I am Ada." }) })]),
    ])
    expect(unsplit.identity).toBe("I am Ada.")
    expect(unsplit.tail).toEqual([])
  })

  it("runs first and hands its redacted texts to every other contribution", async () => {
    const order: string[] = []
    const seen: unknown[] = []
    const entries = [
      entry("alpha", [
        {
          id: "recall",
          cache: "turn",
          produce: (turnCtx) => {
            order.push("recall")
            seen.push(turnCtx.kernelRetrieval)
            return null
          },
        },
      ]),
      entry("twin", [
        identity({
          produce: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            order.push("identity")
            return { text: "I am Ada.", handoff: ["shipped Tuesday", 42] }
          },
        }),
      ]),
    ]
    await collectContextContributions(
      { ...ctx, kernelRetrieval: { identityTexts: ["kernel text"] } },
      { cacheOptimization: true },
      entries
    )
    expect(order).toEqual(["identity", "recall"])
    expect(seen).toEqual([{ identityTexts: ["kernel text", "shipped Tuesday"] }])
  })

  it("hands over what it retrieved even when it replaces nothing", async () => {
    const seen: unknown[] = []
    const entries = [
      entry("alpha", [
        {
          id: "recall",
          cache: "turn",
          produce: (turnCtx) => {
            seen.push(turnCtx.kernelRetrieval.identityTexts)
            return null
          },
        },
      ]),
      entry("twin", [
        identity({ produce: () => ({ text: "", handoff: ["t"], sources: { degraded: true } }) }),
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.identity).toBeUndefined()
    expect(result.sources).toEqual({ "twin.identity": { degraded: true } })
    expect(seen).toEqual([["t"]])
  })

  it("leaves out a leaking identity with its sources and texts, checking each split part", async () => {
    const seen: unknown[] = []
    const entries = [
      entry("alpha", [
        {
          id: "recall",
          cache: "turn",
          produce: (turnCtx) => {
            seen.push(turnCtx.kernelRetrieval.identityTexts)
            return null
          },
        },
      ]),
      entry("twin", [
        identity({
          produce: () => ({
            text: "I am Ada.",
            cacheSplit: { stable: "I am Ada.", dynamic: "Mail jane.doe@example.com" },
            handoff: ["t"],
            sources: { chunks: 1 },
          }),
        }),
      ]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: true }, entries)
    expect(result.identity).toBeUndefined()
    expect(result.tail).toEqual([])
    expect(result.sources).toEqual({})
    expect(seen).toEqual([[]])
    expect(String(result.skipped[0].error)).toContain("leaks PII")
  })

  it("keeps the base prompt when the identity fails or misses its deadline, and the others run", async () => {
    jest.useFakeTimers()
    try {
      const pending = collectContextContributions(ctx, { cacheOptimization: true }, [
        entry("alpha", [section("status", "alpha status")]),
        entry("twin", [identity({ produce: () => new Promise<never>(() => {}) })]),
      ])
      await jest.advanceTimersByTimeAsync(15_000)
      const result = await pending
      expect(result.identity).toBeUndefined()
      expect(result.tail).toEqual(["alpha status"])
      expect(result.skipped.map((skip) => skip.key)).toEqual(["twin.identity"])
    } finally {
      jest.useRealTimers()
    }
  })

  it("lets only the first module's identity stand", async () => {
    const entries = [
      entry("persona", [identity({ produce: () => ({ text: "I am Bo." }) })]),
      entry("twin", [identity()]),
    ]
    const result = await collectContextContributions(ctx, { cacheOptimization: false }, entries)
    expect(result.identity).toBe("I am Bo.")
    expect(result.skipped.map((skip) => skip.key)).toEqual(["twin.identity"])
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
      [{ id: "a", cache: "turn", after: "a", produce: () => null }],
      [{ id: "a", cache: "turn", after: "missing", produce: () => null }],
      [
        { id: "a", cache: "turn", produce: () => null },
        { id: "b", cache: "turn", after: "a", produce: () => null },
        { id: "c", cache: "turn", after: "b", produce: () => null },
      ],
      [
        { id: "a", cache: "turn", after: "b", produce: () => null },
        { id: "b", cache: "turn", after: "a", produce: () => null },
      ],
      [
        { id: "a", cache: "turn", produce: () => null },
        { id: "b", cache: "turn", slot: "identity", after: "a", produce: () => null },
      ],
      [
        { id: "a", cache: "turn", slot: "identity", produce: () => null },
        { id: "b", cache: "turn", after: "a", produce: () => null },
      ],
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
