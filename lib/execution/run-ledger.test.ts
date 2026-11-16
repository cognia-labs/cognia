/** @jest-environment node */
import "fake-indexeddb/auto"
import Dexie, { type Table } from "dexie"
import type { ExecutionRun } from "@/types/execution/run"

jest.mock("@/lib/db/schema", () => ({ getDb: () => mockDb }))
jest.mock("@/lib/usage/pricing", () => ({
  resolveModelPricingUsd: (_provider: string | undefined, model: string) =>
    model === "priced" ? { input: 1, output: 1 } : null,
}))
import {
  declareRootRunBudget,
  declareRunBudget,
  readRunBudget,
  recoverRunBudgetHolds,
  reserveRunBudget,
  runBudgetRefusal,
  RunBudgetError,
} from "./run-ledger"
import { __resetChildRunOwnershipForTesting, inProcessOwnership } from "./child-run-ownership"

jest.setTimeout(10_000)
let mockDb: Dexie & { executionRuns: Table<ExecutionRun, string> }
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
const ledger = async (id = "root") => (await mockDb.executionRuns.get(id))?.runLedger

beforeEach(async () => {
  __resetChildRunOwnershipForTesting(inProcessOwnership())
  mockDb = new Dexie(`ledger-${Math.random()}`) as typeof mockDb
  mockDb.version(1).stores({ executionRuns: "id" })
  await mockDb.executionRuns.bulkPut([
    row("root"),
    row("a", "root"),
    row("b", "root"),
    row("a1", "a"),
  ])
})
afterEach(async () => {
  await mockDb.delete()
})

it("writes nothing and reserves nothing without a finite cap", async () => {
  await (
    await declareRunBudget("root", { tokens: undefined, costUsd: Infinity })
  )()
  expect(await ledger()).toBeUndefined()
  expect(await reserveRunBudget("a")).toBeUndefined()
  expect(await readRunBudget("a")).toBeUndefined()
})

it("lets a child without its own cap take everything left, so siblings wait", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const first = (await reserveRunBudget("a"))!
  expect(first.amounts).toEqual({ tokens: 10 })
  let granted = false
  const second = reserveRunBudget("b").then((hold) => ((granted = true), hold))
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(granted).toBe(false)
  await first.finish({ tokens: 4 }, true)
  const next = (await second)!
  expect(next.amounts).toEqual({ tokens: 6 })
  await next.finish({ tokens: 6 }, true)
  await expect(reserveRunBudget("a")).rejects.toMatchObject({ reason: "budget_exhausted" })
  expect((await ledger())?.spent.tokens).toBe(10)
})

it("reserves an execution's own cap so capped siblings run side by side", async () => {
  await declareRunBudget("root", { costUsd: 1 })
  const model = { modelId: "priced" }
  const a = (await reserveRunBudget("a", { caps: { costUsd: 0.5 }, model }))!
  const b = (await reserveRunBudget("b", { caps: { costUsd: 0.5 }, model }))!
  expect([a.amounts, b.amounts]).toEqual([{ costUsd: 0.5 }, { costUsd: 0.5 }])
  await Promise.all([a.finish({ costUsd: 0.1 }, true), b.finish({ costUsd: 0.2 }, true)])
  expect((await ledger())?.spent.costUsd).toBeCloseTo(0.3)
  expect((await readRunBudget("root"))?.costUsd).toBeCloseTo(0.7)
})

it("never prices unknown spend as zero", async () => {
  await declareRunBudget("root", { tokens: 10 })
  await (await reserveRunBudget("a", { caps: { tokens: 4 } }))!.finish(undefined, true)
  expect((await ledger())?.spent.tokens).toBe(4)
  await (await reserveRunBudget("b", { caps: { tokens: 5 } }))!.finish({ tokens: 1 }, false)
  expect((await ledger())?.spent.tokens).toBe(9)
})

it("refuses an unpriced model under a USD budget, and accepts it under tokens", async () => {
  await declareRunBudget("root", { costUsd: 1 })
  await expect(reserveRunBudget("a", { model: { modelId: "free-form" } })).rejects.toMatchObject({
    reason: "pricing_unknown",
  })
  await mockDb.executionRuns.update("root", { runLedger: undefined })
  await declareRunBudget("root", { tokens: 5 })
  expect(await reserveRunBudget("a", { model: { modelId: "free-form" } })).toBeDefined()
})

it("lends a child out of its parent's hold and charges the child once", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const parent = (await reserveRunBudget("a"))!
  await parent.report({ tokens: 3 })
  const child = (await reserveRunBudget("a1"))!
  expect(child.amounts).toEqual({ tokens: 7 })
  await child.finish({ tokens: 5 }, true)
  const after = (await reserveRunBudget("a1"))!
  expect(after.amounts).toEqual({ tokens: 2 })
  await after.finish({ tokens: 0 }, true)
  await parent.finish({ tokens: 3 }, true)
  expect((await ledger())?.spent.tokens).toBe(8)
  expect(Object.keys((await ledger())!.holds)).toEqual([])
})

it("keeps a child that outlives its parent, lent by the surviving ancestor", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const parent = (await reserveRunBudget("a"))!
  const child = (await reserveRunBudget("a1", { caps: { tokens: 4 } }))!
  await parent.finish({ tokens: 2 }, true)
  expect((await readRunBudget("b"))?.tokens).toBe(4)
  await child.finish(undefined, false)
  expect((await ledger())?.spent.tokens).toBe(6)
})

it("charges a lost parent's whole remainder but not its live child's hold", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const parent = (await reserveRunBudget("a"))!
  const child = (await reserveRunBudget("a1", { caps: { tokens: 4 } }))!
  await parent.finish(undefined, false)
  expect((await ledger())?.spent.tokens).toBe(6)
  await child.finish({ tokens: 1 }, true)
  expect((await ledger())?.spent.tokens).toBe(7)
})

it("settles once however often finish is called", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const hold = (await reserveRunBudget("a"))!
  await Promise.all([hold.finish({ tokens: 2 }, true), hold.finish({ tokens: 9 }, true)])
  await hold.finish(undefined, false)
  expect((await ledger())?.spent.tokens).toBe(2)
})

it("keeps one absolute deadline and refuses after it", async () => {
  const before = Date.now()
  await declareRunBudget("root", { deadlineMs: 50 })
  const deadlineAt = (await ledger())!.deadlineAt!
  await declareRunBudget("root", { deadlineMs: 60_000 })
  expect((await ledger())?.deadlineAt).toBe(deadlineAt)
  expect(deadlineAt - before).toBeLessThanOrEqual(60)
  const hold = (await reserveRunBudget("a"))!
  expect(hold.deadlineAt).toBe(deadlineAt)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await expect(reserveRunBudget("b")).rejects.toBeInstanceOf(RunBudgetError)
})

it("nests a declaration inside an existing tree as a hold that bounds its subtree", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const release = await declareRunBudget("a", { tokens: 3 })
  expect(await ledger("a")).toBeUndefined()
  const child = (await reserveRunBudget("a1"))!
  expect(child.amounts).toEqual({ tokens: 3 })
  expect((await readRunBudget("b"))?.tokens).toBe(7)
  await child.finish({ tokens: 2 }, true)
  await release()
  expect((await ledger())?.spent.tokens).toBe(2)
  expect((await readRunBudget("b"))?.tokens).toBe(8)
})

it("tightens a run's own hold when it declares a budget after reserving", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const own = (await reserveRunBudget("a"))!
  await declareRunBudget("a", { tokens: 3 })
  expect((await reserveRunBudget("a1"))?.amounts).toEqual({ tokens: 3 })
  await own.finish({ tokens: 0 }, true)
})

it("waits abortably and stops waiting on cancel", async () => {
  await declareRunBudget("root", { tokens: 10 })
  await reserveRunBudget("a")
  const controller = new AbortController()
  const waiting = reserveRunBudget("b", { signal: controller.signal })
  controller.abort()
  await expect(waiting).rejects.toMatchObject({ reason: "cancelled" })
})

it("recovers holds no live process claims as unconfirmed stops", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const live = (await reserveRunBudget("a", { caps: { tokens: 4 } }))!
  await reserveRunBudget("b", { caps: { tokens: 3 } })
  // A new process: the earlier claims are gone.
  __resetChildRunOwnershipForTesting(inProcessOwnership())
  const survivor = (await reserveRunBudget("a1", { caps: { tokens: 1 } }))!
  expect(await recoverRunBudgetHolds()).toBe(2)
  // a's 4 less what its live child holds, plus b's 3.
  expect((await ledger())?.spent.tokens).toBe(6)
  expect(Object.values((await ledger())!.holds).map((hold) => hold.runId)).toEqual(["a1"])
  await survivor.finish({ tokens: 1 }, true)
  await live.finish({ tokens: 1 }, true)
  expect((await ledger())?.spent.tokens).toBe(7)
})

it("treats zero as no ceiling, as every setting does", async () => {
  await declareRunBudget("root", { tokens: 0, costUsd: 0, deadlineMs: 0 })
  expect(await ledger()).toBeUndefined()
  await declareRunBudget("root", { tokens: 10 })
  expect((await reserveRunBudget("a", { caps: { tokens: 0 } }))?.amounts).toEqual({ tokens: 10 })
})

it("lends a second execution of a run out of that run's own hold instead of waiting", async () => {
  await declareRunBudget("root", { tokens: 10 })
  const turn = (await reserveRunBudget("a"))!
  const second = (await reserveRunBudget("a", { caps: { tokens: 4 } }))!
  expect(second.amounts).toEqual({ tokens: 4 })
  await second.finish({ tokens: 3 }, true)
  const third = (await reserveRunBudget("a"))!
  expect(third.amounts).toEqual({ tokens: 7 })
  await third.finish({ tokens: 0 }, true)
  expect(await turn.spent()).toEqual({ tokens: 3, costUsd: 0 })
  await turn.finish({ tokens: 3 }, true)
  expect((await ledger())?.spent.tokens).toBe(6)
})

it("says why a reservation would be refused without taking one", async () => {
  expect(await runBudgetRefusal("a")).toBeUndefined()
  await declareRunBudget("root", { costUsd: 1 })
  expect(await runBudgetRefusal("a", { model: { modelId: "free-form" } })).toBe("pricing_unknown")
  expect(await runBudgetRefusal("a", { model: { modelId: "priced" } })).toBeUndefined()
  await (await reserveRunBudget("a", { model: { modelId: "priced" } }))!.finish(
    { costUsd: 1 },
    true
  )
  expect(await runBudgetRefusal("b")).toBe("budget_exhausted")
  expect(Object.keys((await ledger())!.holds)).toEqual([])
})

it("gives a fresh declaration a ledger of its own inside another tree", async () => {
  await declareRunBudget("root", { tokens: 10 })
  await (await reserveRunBudget("a"))!.finish({ tokens: 9 }, true)
  expect(await declareRootRunBudget("b", { tokens: 5 }, { fresh: true })).toBe(true)
  expect((await ledger("b"))?.limits).toEqual({ tokens: 5 })
  expect((await reserveRunBudget("b"))?.amounts).toEqual({ tokens: 5 })
})

it("keeps an uncapped fresh declaration off the tree it sits in, and writes nothing outside one", async () => {
  expect(await declareRootRunBudget("a", {}, { fresh: true })).toBe(true)
  expect(await ledger("a")).toBeUndefined()
  await declareRunBudget("root", { tokens: 1 })
  await declareRootRunBudget("a", {}, { fresh: true })
  expect((await ledger("a"))?.limits).toEqual({})
  await (await reserveRunBudget("a1"))!.finish({ tokens: 50 }, true)
  expect((await ledger())?.spent.tokens).toBe(0)
})

it("reports what a declaration spent when it is released", async () => {
  const releaseRoot = await declareRunBudget("root", { tokens: 10 })
  const releaseNested = await declareRunBudget("a", { tokens: 6 })
  const child = (await reserveRunBudget("a1"))!
  await child.finish({ tokens: 4 }, true)
  expect(await releaseNested()).toEqual({ tokens: 4, costUsd: 0 })
  const sibling = (await reserveRunBudget("b"))!
  await sibling.finish({ tokens: 2 }, true)
  expect(await releaseRoot()).toEqual({ tokens: 6, costUsd: 0 })
})
