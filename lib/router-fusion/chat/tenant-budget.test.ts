jest.mock("@/lib/usage/cost-budget-runtime", () => ({
  readCostBudgetSpend: jest.fn(async () => {
    throw new Error("the default reader must not be reached in these tests")
  }),
}))

const mockUnbooked = jest.fn(async () => 0)
jest.mock("./unbooked-spend", () => ({ unbookedFusionSpendMicrousd: () => mockUnbooked() }))

import { tenantLimitFor, tightestTenantLimit } from "./tenant-budget"

beforeEach(() => mockUnbooked.mockReset().mockResolvedValue(0))

const spend = async () => ({
  dayUsd: 4,
  monthUsd: 30,
  byProviderDayUsd: { openai: 1.5 },
  byProviderMonthUsd: { openai: 9 },
})

describe("tenantLimitFor", () => {
  it("has no tenant limit when no ceiling is configured, without reading spend", async () => {
    const readSpend = jest.fn(spend)
    expect(await tenantLimitFor(undefined, "openai", { readSpend })).toEqual({
      remainingMicrousd: null,
      binding: null,
    })
    expect(await tenantLimitFor({ warnAt: 0.5 }, "openai", { readSpend })).toEqual({
      remainingMicrousd: null,
      binding: null,
    })
    expect(readSpend).not.toHaveBeenCalled()
  })

  it("binds to the tightest applicable scope", async () => {
    const limit = await tenantLimitFor(
      { dailyUsd: 10, monthlyUsd: 100, perProviderDailyUsd: { openai: 2, anthropic: 0.1 } },
      "openai",
      { readSpend: spend }
    )
    expect(limit.remainingMicrousd).toBe(500_000)
    expect(limit.binding?.scopeKey).toBe("day:openai")
  })

  it("binds a run to its project's own ceiling (F24)", async () => {
    const readSpend = jest.fn(async (projectIds: readonly string[]) => ({
      dayUsd: 1,
      monthUsd: 1,
      byProjectDayUsd: Object.fromEntries(projectIds.map((id) => [id, 1])),
      byProjectMonthUsd: Object.fromEntries(projectIds.map((id) => [id, 1])),
    }))
    const budget = { perProjectDailyUsd: { alpha: 1 } }
    const spent = await tenantLimitFor(budget, "openai", { projectId: "alpha", readSpend })
    expect(spent.remainingMicrousd).toBe(0)
    expect(spent.binding?.scopeKey).toBe("day:project:alpha")
    expect(readSpend).toHaveBeenCalledWith(["alpha"])
    // Another project, or none, has no limit of its own here.
    await expect(
      tenantLimitFor(budget, "openai", { projectId: "beta", readSpend })
    ).resolves.toEqual({ remainingMicrousd: null, binding: null })
    await expect(tightestTenantLimit(budget, ["openai::gpt-5"], { readSpend })).resolves.toBeNull()
    await expect(
      tightestTenantLimit(budget, ["openai::gpt-5"], { projectId: "alpha", readSpend })
    ).resolves.toBe(0)
  })

  it("does not admit a run on money a settled run spent but has not booked yet (F23)", async () => {
    // $1 day ceiling, nothing booked; the first run settled $1 a moment ago and
    // its usage row is still on its way to the account database.
    const nothingBooked = async () => ({ dayUsd: 0, monthUsd: 0 })
    mockUnbooked.mockResolvedValue(1_000_000)
    const limit = await tenantLimitFor({ dailyUsd: 1 }, "openai", { readSpend: nothingBooked })
    expect(limit.remainingMicrousd).toBe(0)
    // Without a ceiling it is not even read.
    mockUnbooked.mockClear()
    await tenantLimitFor(undefined, "openai", { readSpend: nothingBooked })
    expect(mockUnbooked).not.toHaveBeenCalled()
  })

  it("never reports a negative remainder", async () => {
    const limit = await tenantLimitFor({ dailyUsd: 3 }, "openai", { readSpend: spend })
    expect(limit.remainingMicrousd).toBe(0)
    expect(limit.binding?.scopeKey).toBe("day:*")
  })
})

describe("tightestTenantLimit", () => {
  it("takes the tightest limit over every provider a run's roles name, once each", async () => {
    const readSpend = jest.fn(spend)
    const budget = { perProviderDailyUsd: { openai: 2, anthropic: 0.25 } }
    await expect(
      tightestTenantLimit(
        budget,
        ["openai::gpt-5-mini", "openai::gpt-5", "anthropic::claude-sonnet-5", "malformed"],
        { readSpend }
      )
    ).resolves.toBe(250_000)
    // openai and anthropic, not one read per role.
    expect(readSpend).toHaveBeenCalledTimes(2)
  })

  it("is no limit at all when no provider has a scope", async () => {
    await expect(
      tightestTenantLimit(undefined, ["openai::gpt-5"], { readSpend: spend })
    ).resolves.toBeNull()
    await expect(
      tightestTenantLimit({ perProviderDailyUsd: { mistral: 1 } }, ["openai::gpt-5"], {
        readSpend: spend,
      })
    ).resolves.toBeNull()
  })
})
