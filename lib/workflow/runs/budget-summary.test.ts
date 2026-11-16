import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import { readBudgetLog, summarizeRunBudget } from "./budget-summary"

const usage = (stepId: string, payload: Record<string, unknown>) =>
  ({ type: "step_usage", stepId, payload }) as unknown as WorkflowRunEventRow

const budgetLog = (data: unknown) =>
  ({ type: "run_log", level: "info", payload: { message: "m", data } }) as WorkflowRunEventRow

function run(
  maxCostUsd: number | undefined,
  extra: Partial<Pick<WorkflowRunRow, "error">> = {}
): Pick<WorkflowRunRow, "workflowSnapshot" | "error"> {
  return {
    workflowSnapshot: {
      settings: maxCostUsd === undefined ? {} : { maxCostUsd },
    } as WorkflowRunRow["workflowSnapshot"],
    ...extra,
  }
}

describe("readBudgetLog", () => {
  it("reads only the well-formed settled spend from run logs", () => {
    expect(readBudgetLog(budgetLog({ budget: "spent", limitUsd: 1, spentUsd: 0.4 }))).toEqual({
      budget: "spent",
      limitUsd: 1,
      spentUsd: 0.4,
    })
    expect(readBudgetLog(budgetLog({ budget: "spent", limitUsd: 1 }))).toBeNull()
    expect(readBudgetLog(budgetLog({ budget: "uncovered", reason: "unpriced" }))).toBeNull()
    expect(readBudgetLog(budgetLog({ notify: true }))).toBeNull()
    expect(readBudgetLog(usage("a", { costUsd: 1 }))).toBeNull()
  })
})

describe("summarizeRunBudget", () => {
  it("is null for a run without a budget", () => {
    expect(summarizeRunBudget(run(undefined), [])).toBeNull()
  })

  it("sums the steps' priced reports while the run has not settled", () => {
    const summary = summarizeRunBudget(run(1), [
      usage("a", { inputTokens: 1, outputTokens: 1, costUsd: 0.2 }),
      usage("a", { inputTokens: 1, outputTokens: 1, costUsd: 0.2 }),
      usage("b", { inputTokens: 1, outputTokens: 1, modelId: "mystery-model-xyz" }),
    ])
    expect(summary).toEqual({ limitUsd: 1, spentUsd: expect.closeTo(0.4), exhausted: false })
  })

  it("counts an attempt's cumulative snapshots once, and keeps attempts apart", () => {
    const priced = (stepExecutionId: string, costUsd: number) =>
      usage("a", { stepExecutionId, inputTokens: 1, outputTokens: 1, costUsd })
    const summary = summarizeRunBudget(run(1), [
      priced("a#1", 0.1),
      priced("a#1", 0.3),
      priced("a#2", 0.2),
      usage("b", { stepExecutionId: "b#1", inputTokens: 1, outputTokens: 1, costUsd: 0.5 }),
      usage("b", { stepExecutionId: "b#1", inputTokens: 9, outputTokens: 9, costKnown: false }),
    ])
    expect(summary?.spentUsd).toBeCloseTo(0.5)
  })

  it("takes the ledger's settled spend once the run logged it, sub-workflows included", () => {
    const summary = summarizeRunBudget(
      run(1, { error: { message: "spent", code: "budget_exhausted" } }),
      [
        usage("a", { inputTokens: 1, outputTokens: 1, costUsd: 0.2 }),
        budgetLog({ budget: "spent", limitUsd: 1, spentUsd: 1.1 }),
      ]
    )
    expect(summary).toEqual({ limitUsd: 1, spentUsd: 1.1, exhausted: true })
  })
})
