import type {
  CapabilityContribution,
  CapabilityContributionContext,
  ModuleCapabilityContributionsEntry,
} from "@/lib/modules/manifest-types"
import {
  __resetCapabilityContributionsForTests,
  CapabilityContributionError,
  collectContributedGrants,
} from "./capability-contributions"

const ctx: CapabilityContributionContext = {
  session: null,
  agent: null,
  settings: null,
  activeGoal: null,
  prompts: { snapshot: null, context: {} },
}

const entry = (
  module: string,
  contributions: readonly CapabilityContribution[],
  stage: ModuleCapabilityContributionsEntry["stage"] = "stable"
): ModuleCapabilityContributionsEntry => ({
  module,
  stage,
  load: async () => ({ contributions }),
})

const adds = (id: string, text: string): CapabilityContribution => ({
  id,
  failure: "skip",
  produce: () => ({ instructions: [text] }),
})

beforeEach(() => {
  __resetCapabilityContributionsForTests()
  jest.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe("collectContributedGrants", () => {
  it("stamps each grant with the module source, in module and manifest order", async () => {
    const { grants, skipped } = await collectContributedGrants(ctx, [
      entry("alpha", [adds("one", "a1"), adds("two", "a2")]),
      entry("beta", [adds("one", "b1")]),
    ])
    expect(skipped).toEqual([])
    expect(grants).toEqual([
      { schemaVersion: 1, source: { kind: "module", id: "alpha/one" }, instructions: ["a1"] },
      { schemaVersion: 1, source: { kind: "module", id: "alpha/two" }, instructions: ["a2"] },
      { schemaVersion: 1, source: { kind: "module", id: "beta/one" }, instructions: ["b1"] },
    ])
  })

  it("passes the run's context and leaves out a contribution that does not apply", async () => {
    const produce = jest.fn(() => null)
    const { grants } = await collectContributedGrants(ctx, [
      entry("alpha", [{ id: "quiet", failure: "skip", produce }]),
    ])
    expect(produce).toHaveBeenCalledWith(ctx)
    expect(grants).toEqual([])
  })

  it("lets a refuse-turn contribution narrow", async () => {
    const { grants } = await collectContributedGrants(ctx, [
      entry("goal", [
        {
          id: "budget",
          failure: "refuse-turn",
          produce: async () => ({ maxBudgetUsd: 2, tools: { deny: ["Bash"] } }),
        },
      ]),
    ])
    expect(grants[0]).toMatchObject({ maxBudgetUsd: 2, tools: { deny: ["Bash"] } })
  })

  it("contributes nothing from an experimental module", async () => {
    const load = jest.fn(async () => ({ contributions: [adds("x", "x")] }))
    const result = await collectContributedGrants(ctx, [
      { module: "lab", stage: "experimental", load },
    ])
    expect(result).toEqual({ grants: [], skipped: [] })
    expect(load).not.toHaveBeenCalled()
  })

  it("loads each module's file once, even across concurrent resolutions", async () => {
    const load = jest.fn(async () => ({ contributions: [adds("x", "x")] }))
    const entries = [{ module: "once", stage: "stable" as const, load }]
    await Promise.all([
      collectContributedGrants(ctx, entries),
      collectContributedGrants(ctx, entries),
    ])
    await collectContributedGrants(ctx, entries)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("skips and reports a skip contribution that throws, keeping the others", async () => {
    const { grants, skipped } = await collectContributedGrants(ctx, [
      entry("alpha", [
        {
          id: "broken",
          failure: "skip",
          produce: () => {
            throw new Error("boom")
          },
        },
        adds("fine", "ok"),
      ]),
    ])
    expect(skipped).toEqual([{ id: "alpha/broken", error: new Error("boom") }])
    expect(grants.map((grant) => grant.source.id)).toEqual(["alpha/fine"])
  })

  it("refuses a skip contribution that tries to narrow", async () => {
    const { grants, skipped } = await collectContributedGrants(ctx, [
      entry("alpha", [
        { id: "sneaky", failure: "skip", produce: () => ({ permissionMode: "plan" }) },
      ]),
    ])
    expect(grants).toEqual([])
    expect(String(skipped[0].error)).toContain('a "skip" contribution may only add')
  })

  it("refuses a grant that sets the caller's own choices", async () => {
    const { skipped } = await collectContributedGrants(ctx, [
      entry("alpha", [{ id: "model", failure: "skip", produce: () => ({ model: "x" }) as never }]),
    ])
    expect(String(skipped[0].error)).toContain("may not set model")
  })

  it("fails the resolution when a refuse-turn contribution fails", async () => {
    const run = collectContributedGrants(ctx, [
      entry("connectors", [
        {
          id: "ceiling",
          failure: "refuse-turn",
          produce: () => {
            throw new Error("matrix unavailable")
          },
        },
      ]),
    ])
    await expect(run).rejects.toBeInstanceOf(CapabilityContributionError)
    await expect(run).rejects.toThrow('"connectors/ceiling" failed: matrix unavailable')
  })

  it("holds every contribution to one deadline", async () => {
    const slow: CapabilityContribution = {
      id: "slow",
      failure: "skip",
      produce: () => new Promise(() => {}),
    }
    const { skipped } = await collectContributedGrants(ctx, [entry("alpha", [slow])], 10)
    expect(String(skipped[0].error)).toContain("no answer within 10 ms")
    const refusing = { ...slow, failure: "refuse-turn" as const }
    await expect(collectContributedGrants(ctx, [entry("beta", [refusing])], 10)).rejects.toThrow(
      "no answer within 10 ms"
    )
  })

  it("fails the resolution when a module's file does not load, and retries it next time", async () => {
    const load = jest
      .fn<Promise<{ contributions: readonly CapabilityContribution[] }>, []>()
      .mockRejectedValueOnce(new Error("chunk"))
      .mockResolvedValue({ contributions: [adds("x", "x")] })
    const entries = [{ module: "flaky", stage: "stable" as const, load }]
    await expect(collectContributedGrants(ctx, entries)).rejects.toThrow('"flaky" failed: chunk')
    const { grants } = await collectContributedGrants(ctx, entries)
    expect(grants).toHaveLength(1)
  })

  it("refuses a module whose contributions are malformed", async () => {
    for (const contributions of [
      [adds("x", "1"), adds("x", "2")],
      [{ id: "", failure: "skip", produce: () => null }],
      [{ id: "y", failure: "maybe", produce: () => null }],
      [{ id: "z", failure: "skip" }],
    ]) {
      __resetCapabilityContributionsForTests()
      await expect(
        collectContributedGrants(ctx, [entry("bad", contributions as CapabilityContribution[])])
      ).rejects.toBeInstanceOf(CapabilityContributionError)
    }
  })
})
