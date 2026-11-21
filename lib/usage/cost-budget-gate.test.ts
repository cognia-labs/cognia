import type { AppSettings } from "@cognia/agent-config-types"
import type { CostBudgetSpend, CostBudgetVerdict } from "./cost-budget"

const readSpendMock = jest.fn<
  Promise<CostBudgetSpend>,
  [number | undefined, readonly string[] | undefined]
>()
const notifyThresholdMock = jest.fn<Promise<void>, [CostBudgetVerdict, number | undefined]>()
const requestOverrideMock = jest.fn<
  Promise<{ approved: boolean; scopeKey: string }>,
  [CostBudgetVerdict, unknown]
>()
const requestUncheckedMock = jest.fn<Promise<{ approved: boolean; scopeKey: string }>, [unknown]>()
const mockHydratedSettings: { costBudget?: AppSettings["costBudget"] } = {}

jest.mock("./cost-budget-runtime", () => ({
  readCostBudgetSpend: (now?: number, projectIds?: readonly string[]) =>
    readSpendMock(now, projectIds),
  notifyCostBudgetThreshold: (verdict: CostBudgetVerdict, now?: number) =>
    notifyThresholdMock(verdict, now),
  requestCostBudgetOverride: (verdict: CostBudgetVerdict, options: unknown) =>
    requestOverrideMock(verdict, options),
  requestUncheckedBudgetApproval: (options: unknown) => requestUncheckedMock(options),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: mockHydratedSettings }) },
}))

import {
  enforceCostBudget,
  isCostBudgetExhausted,
  __resetCostBudgetGateForTesting,
} from "./cost-budget-gate"
import { COST_BUDGET_HOLD_TTL_MS, releaseCostBudgetHolds } from "./cost-budget-holds"

function settings(costBudget?: AppSettings["costBudget"]): () => Promise<AppSettings> {
  return async () => ({ id: "singleton", ...(costBudget ? { costBudget } : {}) }) as AppSettings
}

beforeEach(() => {
  __resetCostBudgetGateForTesting()
  readSpendMock.mockReset().mockResolvedValue({ dayUsd: 0, monthUsd: 0 })
  notifyThresholdMock.mockReset().mockResolvedValue(undefined)
  requestOverrideMock.mockReset().mockResolvedValue({ approved: false, scopeKey: "day:*" })
  requestUncheckedMock.mockReset().mockResolvedValue({ approved: false, scopeKey: "unchecked" })
  delete mockHydratedSettings.costBudget
})

/** Let pending promise chains run without advancing time. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe("enforceCostBudget — nothing configured", () => {
  it("allows without even reading the rollup", async () => {
    await expect(enforceCostBudget({ loadSettings: settings() })).resolves.toEqual({
      allowed: true,
      verdict: null,
      blockedBy: [],
    })
    expect(readSpendMock).not.toHaveBeenCalled()
  })

  it("treats an all-zero policy as no ceiling", async () => {
    await expect(
      enforceCostBudget({
        loadSettings: settings({ dailyUsd: 0, perProviderDailyUsd: { anthropic: 0 } }),
      })
    ).resolves.toMatchObject({ allowed: true })
    expect(readSpendMock).not.toHaveBeenCalled()
  })
})

describe("enforceCostBudget — under the ceiling", () => {
  it("allows and reports the worst scope", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 5, monthUsd: 5 })
    const result = await enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    expect(result.allowed).toBe(true)
    expect(result.verdict).toMatchObject({ scopeKey: "day:*", ratio: 0.5, level: "ok" })
    expect(requestOverrideMock).not.toHaveBeenCalled()
  })

  it("announces a crossed threshold exactly once", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 8.5, monthUsd: 8.5 })
    const load = settings({ dailyUsd: 10 })
    await enforceCostBudget({ loadSettings: load })
    await enforceCostBudget({ loadSettings: load })
    // The same warning on every turn of a long session is noise.
    expect(notifyThresholdMock).toHaveBeenCalledTimes(1)
    expect(notifyThresholdMock.mock.calls[0][0]).toMatchObject({ level: "warning" })
  })

  it("re-arms a scope that fell back to ok", async () => {
    const load = settings({ dailyUsd: 10 })
    readSpendMock.mockResolvedValue({ dayUsd: 8.5, monthUsd: 8.5 })
    await enforceCostBudget({ loadSettings: load })
    // A new day resets the window.
    readSpendMock.mockResolvedValue({ dayUsd: 0, monthUsd: 0 })
    await enforceCostBudget({ loadSettings: load })
    readSpendMock.mockResolvedValue({ dayUsd: 8.5, monthUsd: 8.5 })
    await enforceCostBudget({ loadSettings: load })
    expect(notifyThresholdMock).toHaveBeenCalledTimes(2)
  })

  it("does not let a failed notification block the send", async () => {
    notifyThresholdMock.mockRejectedValue(new Error("notification centre down"))
    readSpendMock.mockResolvedValue({ dayUsd: 9.9, monthUsd: 9.9 })
    await expect(
      enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    ).resolves.toMatchObject({ allowed: true })
  })
})

describe("enforceCostBudget — at the ceiling", () => {
  it("blocks when the override is declined", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    const result = await enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    expect(result.allowed).toBe(false)
    expect(result.blockedBy.map((v) => v.scopeKey)).toEqual(["day:*"])
    expect(requestOverrideMock).toHaveBeenCalledTimes(1)
  })

  it("allows once when the override is approved", async () => {
    requestOverrideMock.mockResolvedValue({ approved: true, scopeKey: "day:*" })
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    await expect(
      enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    ).resolves.toMatchObject({ allowed: true, blockedBy: [] })
  })

  it("asks separately for every blocking scope", async () => {
    requestOverrideMock.mockResolvedValue({ approved: true, scopeKey: "x" })
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    await enforceCostBudget({ loadSettings: settings({ dailyUsd: 10, monthlyUsd: 10 }) })
    // Approving the daily overrun does not authorise the monthly one.
    expect(requestOverrideMock).toHaveBeenCalledTimes(2)
  })

  it("stops asking as soon as one scope is declined", async () => {
    requestOverrideMock.mockResolvedValue({ approved: false, scopeKey: "day:*" })
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    const result = await enforceCostBudget({
      loadSettings: settings({ dailyUsd: 10, monthlyUsd: 10 }),
    })
    expect(requestOverrideMock).toHaveBeenCalledTimes(1)
    expect(result.allowed).toBe(false)
  })

  it("only blocks on the provider actually being charged", async () => {
    readSpendMock.mockResolvedValue({
      dayUsd: 0,
      monthUsd: 0,
      byProviderDayUsd: { anthropic: 12 },
    })
    const load = settings({ perProviderDailyUsd: { anthropic: 10, openai: 10 } })
    await expect(
      enforceCostBudget({ loadSettings: load, providerId: "openai" })
    ).resolves.toMatchObject({ allowed: true })
    await expect(
      enforceCostBudget({ loadSettings: load, providerId: "anthropic" })
    ).resolves.toMatchObject({ allowed: false })
  })

  it("forwards the run id and abort signal to the gate", async () => {
    const controller = new AbortController()
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    await enforceCostBudget({
      loadSettings: settings({ dailyUsd: 10 }),
      runId: "run-9",
      signal: controller.signal,
    })
    expect(requestOverrideMock.mock.calls[0][1]).toMatchObject({
      runId: "run-9",
      signal: controller.signal,
    })
  })
})

describe("enforceCostBudget — failure modes", () => {
  const brokenSettings = async (): Promise<AppSettings> => {
    throw new Error("dexie is gone")
  }

  it("allows when settings cannot be read and no ceiling is known", async () => {
    await expect(enforceCostBudget({ loadSettings: brokenSettings })).resolves.toMatchObject({
      allowed: true,
    })
    expect(requestUncheckedMock).not.toHaveBeenCalled()
  })

  it("asks a person when a known ceiling's settings cannot be read (F08)", async () => {
    mockHydratedSettings.costBudget = { dailyUsd: 10 }
    await expect(
      enforceCostBudget({ loadSettings: brokenSettings, runId: "run-1" })
    ).resolves.toMatchObject({ allowed: false })
    expect(requestUncheckedMock).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }))
    requestUncheckedMock.mockResolvedValue({ approved: true, scopeKey: "unchecked" })
    await expect(enforceCostBudget({ loadSettings: brokenSettings })).resolves.toMatchObject({
      allowed: true,
    })
  })

  it("asks a person instead of letting an unread spend through (F08)", async () => {
    readSpendMock.mockRejectedValue(new Error("dexie is gone"))
    await expect(
      enforceCostBudget({ loadSettings: settings({ dailyUsd: 10 }) })
    ).resolves.toMatchObject({ allowed: false })
    expect(requestUncheckedMock).toHaveBeenCalledTimes(1)
    expect(requestOverrideMock).not.toHaveBeenCalled()
  })
})

describe("enforceCostBudget — requests in flight near a ceiling (F08)", () => {
  afterEach(() => jest.useRealTimers())

  it("lets one request at a time past the warning level, judged on what the last booked", async () => {
    const load = settings({ dailyUsd: 10 })
    readSpendMock.mockResolvedValue({ dayUsd: 9, monthUsd: 9 })
    await expect(
      enforceCostBudget({ loadSettings: load, runId: "run-a", sessionId: "s-a" })
    ).resolves.toMatchObject({ allowed: true })
    let second: Awaited<ReturnType<typeof enforceCostBudget>> | undefined
    void enforceCostBudget({ loadSettings: load, runId: "run-b" }).then((r) => (second = r))
    await flush()
    // The second request waits: run-a's spend is not booked yet.
    expect(second).toBeUndefined()
    // run-a books $2 and its turn settles; run-b is judged on $11.
    readSpendMock.mockResolvedValue({ dayUsd: 11, monthUsd: 11 })
    releaseCostBudgetHolds({ sessionId: "s-a" })
    await flush()
    await flush()
    expect(second).toMatchObject({ allowed: false })
    expect(requestOverrideMock).toHaveBeenCalledTimes(1)
  })

  it("never holds a scope far from its ceiling", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 1, monthUsd: 1 })
    const load = settings({ dailyUsd: 10 })
    await enforceCostBudget({ loadSettings: load, runId: "run-a" })
    await expect(enforceCostBudget({ loadSettings: load, runId: "run-b" })).resolves.toMatchObject({
      allowed: true,
    })
  })

  it("frees the scope when the holder is declined, and stops waiting on abort", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    const load = settings({ dailyUsd: 10 })
    // Declined: its hold goes with it, so the next request asks on its own.
    await enforceCostBudget({ loadSettings: load, runId: "run-a" })
    await enforceCostBudget({ loadSettings: load, runId: "run-b" })
    expect(requestOverrideMock).toHaveBeenCalledTimes(2)

    requestOverrideMock.mockResolvedValue({ approved: true, scopeKey: "day:*" })
    await enforceCostBudget({ loadSettings: load, runId: "run-c" })
    const controller = new AbortController()
    const waiting = enforceCostBudget({
      loadSettings: load,
      runId: "run-d",
      signal: controller.signal,
    })
    await flush()
    controller.abort()
    await expect(waiting).resolves.toMatchObject({ allowed: false })
  })

  it("stops serializing on a hold whose settle never arrives", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] })
    readSpendMock.mockResolvedValue({ dayUsd: 9, monthUsd: 9 })
    const load = settings({ dailyUsd: 10 })
    await enforceCostBudget({ loadSettings: load, runId: "run-lost" })
    let second: Awaited<ReturnType<typeof enforceCostBudget>> | undefined
    void enforceCostBudget({ loadSettings: load, runId: "run-next" }).then((r) => (second = r))
    await flush()
    expect(second).toBeUndefined()
    jest.advanceTimersByTime(COST_BUDGET_HOLD_TTL_MS)
    await flush()
    await flush()
    expect(second).toMatchObject({ allowed: true })
  })
})

describe("enforceCostBudget — per-project ceilings", () => {
  it("reads and judges the sending project's spend", async () => {
    readSpendMock.mockResolvedValue({
      dayUsd: 3,
      monthUsd: 3,
      byProjectDayUsd: { alpha: 3 },
      byProjectMonthUsd: { alpha: 3 },
    })
    requestOverrideMock.mockResolvedValue({ approved: false, scopeKey: "day:project:alpha" })
    const result = await enforceCostBudget({
      projectId: "alpha",
      loadSettings: settings({ perProjectDailyUsd: { alpha: 3 } }),
    })
    expect(readSpendMock).toHaveBeenCalledWith(undefined, ["alpha"])
    expect(result.allowed).toBe(false)
    expect(result.blockedBy.map((v) => v.scopeKey)).toEqual(["day:project:alpha"])
  })

  it("does not read project spend for a project without its own ceiling", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 1, monthUsd: 1 })
    const result = await enforceCostBudget({
      projectId: "other",
      loadSettings: settings({ perProjectDailyUsd: { alpha: 3 } }),
    })
    expect(readSpendMock).toHaveBeenCalledWith(undefined, [])
    expect(result).toEqual({ allowed: true, verdict: null, blockedBy: [] })
  })
})

describe("isCostBudgetExhausted", () => {
  it("answers without asking anyone or announcing a threshold", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 12, monthUsd: 12 })
    await expect(isCostBudgetExhausted({ loadSettings: settings({ dailyUsd: 10 }) })).resolves.toBe(
      true
    )
    expect(requestOverrideMock).not.toHaveBeenCalled()
    expect(notifyThresholdMock).not.toHaveBeenCalled()
  })

  it("is false under the ceiling and with nothing configured", async () => {
    readSpendMock.mockResolvedValue({ dayUsd: 2, monthUsd: 2 })
    await expect(isCostBudgetExhausted({ loadSettings: settings({ dailyUsd: 10 }) })).resolves.toBe(
      false
    )
    await expect(isCostBudgetExhausted({ loadSettings: settings() })).resolves.toBe(false)
  })

  it("counts a configured ceiling it cannot read as exhausted (F08)", async () => {
    readSpendMock.mockRejectedValue(new Error("dexie"))
    await expect(isCostBudgetExhausted({ loadSettings: settings({ dailyUsd: 10 }) })).resolves.toBe(
      true
    )
    const broken = async (): Promise<AppSettings> => {
      throw new Error("dexie")
    }
    await expect(isCostBudgetExhausted({ loadSettings: broken })).resolves.toBe(false)
    mockHydratedSettings.costBudget = { dailyUsd: 10 }
    await expect(isCostBudgetExhausted({ loadSettings: broken })).resolves.toBe(true)
  })
})
