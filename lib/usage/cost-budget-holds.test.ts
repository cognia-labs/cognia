import {
  blockingCostBudgetHold,
  COST_BUDGET_HOLD_TTL_MS,
  releaseCostBudgetHolds,
  resetCostBudgetHolds,
  takeCostBudgetHold,
  waitForCostBudgetHold,
} from "./cost-budget-holds"

afterEach(() => {
  resetCostBudgetHolds()
  jest.useRealTimers()
})

describe("cost budget holds", () => {
  it("blocks another run on a shared scope, never the holder itself", () => {
    takeCostBudgetHold({ runId: "a", scopes: ["day:*", "month:*"] }, 1_000)
    expect(blockingCostBudgetHold(["month:*"], "b", 1_000)?.runId).toBe("a")
    expect(blockingCostBudgetHold(["month:*"], "a", 1_000)).toBeUndefined()
    expect(blockingCostBudgetHold(["day:anthropic"], "b", 1_000)).toBeUndefined()
  })

  it("releases by run and by session", () => {
    takeCostBudgetHold({ runId: "a", sessionId: "s1", scopes: ["day:*"] })
    takeCostBudgetHold({ runId: "b", sessionId: "s2", scopes: ["day:*"] })
    releaseCostBudgetHolds({ sessionId: "s1" })
    expect(blockingCostBudgetHold(["day:*"], "c")?.runId).toBe("b")
    releaseCostBudgetHolds({ runId: "b" })
    expect(blockingCostBudgetHold(["day:*"], "c")).toBeUndefined()
  })

  it("stops counting a hold past its TTL", () => {
    takeCostBudgetHold({ runId: "a", scopes: ["day:*"] }, 0)
    expect(blockingCostBudgetHold(["day:*"], "b", COST_BUDGET_HOLD_TTL_MS - 1)).toBeDefined()
    expect(blockingCostBudgetHold(["day:*"], "b", COST_BUDGET_HOLD_TTL_MS)).toBeUndefined()
  })

  it("wakes a waiter on release and on expiry, and rejects on abort", async () => {
    jest.useFakeTimers()
    takeCostBudgetHold({ runId: "a", scopes: ["day:*"] }, 0)
    const hold = blockingCostBudgetHold(["day:*"], "b", 0)!
    const released = waitForCostBudgetHold(hold, undefined, 0)
    releaseCostBudgetHolds({ runId: "a" })
    await expect(released).resolves.toBeUndefined()

    takeCostBudgetHold({ runId: "a", scopes: ["day:*"] }, 0)
    const expiring = waitForCostBudgetHold(blockingCostBudgetHold(["day:*"], "b", 0)!, undefined, 0)
    jest.advanceTimersByTime(COST_BUDGET_HOLD_TTL_MS)
    await expect(expiring).resolves.toBeUndefined()

    const controller = new AbortController()
    const aborted = waitForCostBudgetHold(hold, controller.signal, 0)
    controller.abort()
    await expect(aborted).rejects.toBeDefined()
  })
})
