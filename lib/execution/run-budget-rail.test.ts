/** @jest-environment node */
import "fake-indexeddb/auto"
import Dexie, { type Table } from "dexie"
import type { ExecutionRun } from "@/types/execution/run"
import type { LlmClient, LlmClientCallOptions } from "@/lib/twin/distill/llm"

jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDb }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: undefined }) },
}))
import { beginRailBudget, budgetedLlmClient, priceMeteredUsage } from "./run-budget-rail"
import { declareRunBudget, RunBudgetError } from "./run-ledger"
import { __resetChildRunOwnershipForTesting, inProcessOwnership } from "./child-run-ownership"
import { tokenAllowanceForUsd } from "@/lib/usage/pricing"

jest.setTimeout(10_000)
let mockDb: Dexie & { executionRuns: Table<ExecutionRun, string> }
/** In the static price table: $0.75 in / $4.50 out per million tokens. */
const PRICED = { modelId: "gpt-5.4-mini" }
const row = (id: string, parentRunId?: string): ExecutionRun => ({
  id,
  ...(parentRunId ? { parentRunId } : {}),
  kind: "job",
  sourceId: id,
  title: id,
  status: "running",
  currentRevision: 0,
  startedAt: 1,
  updatedAt: 1,
})
const spent = async () => (await mockDb.executionRuns.get("root"))?.runLedger?.spent

beforeEach(async () => {
  __resetChildRunOwnershipForTesting(inProcessOwnership())
  mockDb = new Dexie(`rail-${Math.random()}`) as typeof mockDb
  mockDb.version(1).stores({ executionRuns: "id" })
  await mockDb.executionRuns.bulkPut([row("root"), row("call", "root")])
})
afterEach(async () => {
  await mockDb.delete()
})

describe("priceMeteredUsage", () => {
  it("counts cache tokens, prefers a reported cost and prices the rest", () => {
    expect(
      priceMeteredUsage(
        { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, costUsd: 0.2 },
        PRICED
      )
    ).toEqual({ tokens: 18, costUsd: 0.2 })
    const priced = priceMeteredUsage({ inputTokens: 1_000_000, outputTokens: 0 }, PRICED)
    expect(priced.tokens).toBe(1_000_000)
    expect(priced.costUsd).toBeCloseTo(0.75)
  })

  it("leaves out what it cannot tell", () => {
    expect(priceMeteredUsage({ outputTokens: 5 }, PRICED)).toEqual({})
    expect(
      priceMeteredUsage({ inputTokens: 1, outputTokens: 1 }, { modelId: "free-form" })
    ).toEqual({
      tokens: 2,
    })
  })
})

describe("beginRailBudget", () => {
  it("is absent without a run or without a ledger, so the rail runs as before", async () => {
    expect(await beginRailBudget(undefined, PRICED)).toBeUndefined()
    expect(await beginRailBudget("call", PRICED)).toBeUndefined()
  })

  it("turns a USD hold into the tokens the model can still buy", async () => {
    await declareRunBudget("root", { costUsd: 1 })
    const budget = (await beginRailBudget("call", PRICED))!
    expect(budget.tokens).toBe(tokenAllowanceForUsd(1, PRICED))
    await budget.finish({ inputTokens: 1000, outputTokens: 1000 }, true)
    expect((await spent())?.costUsd).toBeCloseTo(0.00525)
  })

  it("aborts at the tree's deadline", async () => {
    await declareRunBudget("root", { deadlineMs: 30 })
    const budget = (await beginRailBudget("call", PRICED))!
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(budget.signal.aborted).toBe(true)
    expect(budget.signal.reason).toBeInstanceOf(RunBudgetError)
    await budget.finish(undefined, false)
  })

  it("aborts an execution whose running usage reaches the hold, and only then", async () => {
    await declareRunBudget("root", { tokens: 100 })
    const budget = (await beginRailBudget("call", PRICED))!
    await budget.observe({ inputTokens: 40, outputTokens: 20 })
    expect(budget.signal.aborted).toBe(false)
    await budget.observe({ inputTokens: 70, outputTokens: 30 })
    expect(budget.signal.aborted).toBe(true)
    expect(budget.signal.reason).toMatchObject({ reason: "budget_exhausted" })
    await budget.finish({ inputTokens: 70, outputTokens: 30 }, true)
    expect((await spent())?.tokens).toBe(100)
  })

  it("prices running usage against a dollar hold", async () => {
    await declareRunBudget("root", { costUsd: 0.001 })
    const budget = (await beginRailBudget("call", PRICED))!
    await budget.observe({ costUsd: 0.0004 })
    expect(budget.signal.aborted).toBe(false)
    await budget.observe({ costUsd: 0.002 })
    expect(budget.signal.aborted).toBe(true)
    await budget.finish({ costUsd: 0.002 }, true)
  })

  it("follows the caller's own abort", async () => {
    await declareRunBudget("root", { tokens: 10 })
    const controller = new AbortController()
    const budget = (await beginRailBudget("call", PRICED, { signal: controller.signal }))!
    controller.abort("stop")
    expect(budget.signal.reason).toBe("stop")
    await budget.finish(undefined, false)
  })
})

describe("budgetedLlmClient", () => {
  const client = (answer: (options?: LlmClientCallOptions) => Promise<string>) => {
    const calls: Array<LlmClientCallOptions | undefined> = []
    const wrapped: LlmClient = {
      reportsCallUsage: true,
      async complete(_prompt, options) {
        calls.push(options)
        return answer(options)
      },
    }
    return { calls, wrapped }
  }

  it("counts the prompt against a token cap, and refuses a call it cannot afford (F25)", async () => {
    await declareRunBudget("root", { tokens: 3 })
    const { calls, wrapped } = client(async () => "ok")
    await expect(
      budgetedLlmClient(wrapped, "call", PRICED).complete(
        "ten tokens of prompt text here, roughly",
        {}
      )
    ).rejects.toMatchObject({ reason: "budget_exhausted" })
    expect(calls).toEqual([])
    // Nothing was sent, so nothing was charged.
    expect((await spent())?.tokens).toBe(0)
  })

  it("aborts a call once what it may still spend is lent to a child (F25)", async () => {
    await declareRunBudget("root", { tokens: 100 })
    const budget = (await beginRailBudget("call", PRICED))!
    const { reserveRunBudget } = await import("./run-ledger")
    await mockDb.executionRuns.put(row("child", "call"))
    const child = (await reserveRunBudget("child", { caps: { tokens: 80 }, model: PRICED }))!
    await budget.observe({ inputTokens: 15, outputTokens: 5 })
    expect(budget.signal.aborted).toBe(true)
    await child.finish({ tokens: 80 }, true)
    await budget.finish({ inputTokens: 15, outputTokens: 5 }, true)
  })

  it("leaves the call untouched without a budget", async () => {
    const { calls, wrapped } = client(async () => "ok")
    await budgetedLlmClient(wrapped, "call", PRICED).complete("p", { maxTokens: 50 })
    expect(calls[0]).toEqual({ maxTokens: 50 })
  })

  it("asks for no more than the hold buys, without hidden retries, and settles its usage", async () => {
    await declareRunBudget("root", { tokens: 100 })
    const usage = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const { calls, wrapped } = client(async (options) => {
      options?.onUsage?.(usage)
      return "ok"
    })
    const onUsage = jest.fn()
    await budgetedLlmClient(wrapped, "call", PRICED).complete("p", { maxTokens: 500, onUsage })
    // The 100-token hold pays for the prompt too: one token for "p".
    expect(calls[0]).toMatchObject({ maxTokens: 99, maxRetries: 0 })
    expect(onUsage).toHaveBeenCalledWith(usage)
    expect((await spent())?.tokens).toBe(30)
  })

  it("charges a failed call its whole hold", async () => {
    await declareRunBudget("root", { tokens: 100 })
    const { wrapped } = client(async () => {
      throw new Error("provider down")
    })
    await expect(budgetedLlmClient(wrapped, "call", PRICED).complete("p")).rejects.toThrow(
      "provider down"
    )
    expect((await spent())?.tokens).toBe(100)
  })
})
