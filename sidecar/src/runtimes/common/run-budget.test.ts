import assert from "node:assert/strict"
import { test } from "node:test"

import { createRunBudgetGuard, RunBudgetSpentError, withRunBudgetStep } from "./run-budget.ts"

test("caps each request at what the hold has left and refuses once it is spent", () => {
  const guard = createRunBudgetGuard({ tokens: 100 })
  assert.equal(guard.nextOutputCap(500), 100)
  assert.equal(guard.nextOutputCap(40), 40)
  guard.observe({ input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 10 })
  assert.equal(guard.nextOutputCap(undefined), 40)
  guard.observe({ inputTokens: 25, outputTokens: 15 })
  assert.equal(guard.spent(), true)
  assert.throws(() => guard.nextOutputCap(10), RunBudgetSpentError)
})

test("counts a request whose usage repeats across frames once", () => {
  const guard = createRunBudgetGuard({ tokens: 100 })
  guard.observe({ input_tokens: 40, output_tokens: 5 }, "msg_1")
  guard.observe({ input_tokens: 40, output_tokens: 10 }, "msg_1")
  assert.equal(guard.nextOutputCap(undefined), 50)
  guard.observe({ input_tokens: 20, output_tokens: 10 }, "msg_2")
  assert.equal(guard.nextOutputCap(undefined), 20)
})

test("leaves the configured cap alone without a token bound", () => {
  const guard = createRunBudgetGuard({})
  assert.equal(guard.nextOutputCap(undefined), undefined)
  assert.equal(guard.nextOutputCap(64), 64)
  assert.equal(guard.spent(), false)
})

test("refuses after the deadline", () => {
  const guard = createRunBudgetGuard({ deadlineAt: Date.now() - 1 })
  assert.equal(guard.spent(), true)
  assert.throws(() => guard.nextOutputCap(10), /deadline/)
})

test("refuses the next step of a loop once spent, and keeps the loop's own preparation", async () => {
  const guard = createRunBudgetGuard({ tokens: 10 })
  const prepared: number[] = []
  const options = withRunBudgetStep(guard, {
    prepareStep: (step: { stepNumber: number }) => {
      prepared.push(step.stepNumber)
      return { activeTools: [] }
    },
  })
  assert.deepEqual(await options.prepareStep!({ stepNumber: 0 }), { activeTools: [] })
  guard.observe({ inputTokens: 10 })
  await assert.rejects(async () => options.prepareStep!({ stepNumber: 1 }), RunBudgetSpentError)
  assert.deepEqual(prepared, [0])
})

test("adds a refusing step even when the loop prepares nothing, and nothing without a hold", async () => {
  const guard = createRunBudgetGuard({ tokens: 0 })
  const options = withRunBudgetStep(guard, {}) as {
    prepareStep?: (step: unknown) => Promise<unknown>
  }
  await assert.rejects(async () => options.prepareStep!({}), RunBudgetSpentError)
  const untouched = {}
  assert.equal(withRunBudgetStep(undefined, untouched), untouched)
})
