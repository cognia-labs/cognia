import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import {
  effectiveBudgetLimitUsd,
  readBudgetLog,
  summarizeRunBudget,
  tallyRunBudget,
} from "./budget-summary"

const usage = (stepId: string, payload: Record<string, unknown>) =>
  ({ type: "step_usage", stepId, payload }) as unknown as WorkflowRunEventRow

const budgetLog = (stepId: string | undefined, data: unknown, level = "warn") =>
  ({ type: "run_log", level, stepId, payload: { message: "m", data } }) as WorkflowRunEventRow

function run(
  maxCostUsd: number | undefined,
  extra: Partial<Pick<WorkflowRunRow, "lineage" | "error">> = {}
): Pick<WorkflowRunRow, "workflowSnapshot" | "lineage" | "error"> {
  return {
    workflowSnapshot: {
      settings: maxCostUsd === undefined ? {} : { maxCostUsd },
    } as WorkflowRunRow["workflowSnapshot"],
    ...extra,
  }
}

describe("effectiveBudgetLimitUsd", () => {
  it("takes the lower of the run's limit and what the parent left", () => {
    expect(effectiveBudgetLimitUsd(undefined, undefined)).toBeUndefined()
    expect(effectiveBudgetLimitUsd(2, undefined)).toBe(2)
    expect(effectiveBudgetLimitUsd(undefined, 0.5)).toBe(0.5)
    expect(effectiveBudgetLimitUsd(2, 0.5)).toBe(0.5)
    expect(effectiveBudgetLimitUsd(2, -1)).toBe(0)
  })
})

describe("readBudgetLog", () => {
  it("reads only well-formed budget records from run logs", () => {
    expect(readBudgetLog(budgetLog("a", { budget: "uncovered", reason: "unpriced" }))).toEqual({
      budget: "uncovered",
      reason: "unpriced",
    })
    expect(readBudgetLog(budgetLog("a", { budget: "uncovered", reason: "?" }))).toBeNull()
    expect(readBudgetLog(budgetLog("a", { budget: "child-spend", childRunId: "c" }))).toBeNull()
    expect(readBudgetLog(budgetLog("a", { notify: true }))).toBeNull()
    expect(readBudgetLog(usage("a", { costUsd: 1 }))).toBeNull()
  })
})

describe("tallyRunBudget", () => {
  it("adds every priced report and sub-workflow spend, and lists uncovered steps once", () => {
    const tally = tallyRunBudget([
      usage("a", { inputTokens: 1, outputTokens: 1, costUsd: 0.2 }),
      usage("a", { inputTokens: 1, outputTokens: 1, costUsd: 0.2 }),
      usage("b", { inputTokens: 1, outputTokens: 1, modelId: "mystery-model-xyz" }),
      budgetLog("b", { budget: "uncovered", reason: "unpriced" }),
      budgetLog("b", { budget: "uncovered", reason: "unpriced" }),
      budgetLog("sub", { budget: "child-spend", childRunId: "run_c", costUsd: 0.1 }, "info"),
    ])
    expect(tally.spentUsd).toBeCloseTo(0.5)
    expect([...tally.reportedStepIds]).toEqual(["a", "b"])
    expect(tally.uncoveredStepIds).toEqual(["b"])
    expect(tally.exhausted).toBe(false)
  })
})

describe("summarizeRunBudget", () => {
  it("is null for a run without a budget", () => {
    expect(summarizeRunBudget(run(undefined), [])).toBeNull()
  })

  it("summarises spend, uncovered steps and whether the budget stopped the run", () => {
    const summary = summarizeRunBudget(
      run(1, { lineage: { rootRunId: "r", budgetCeilingUsd: 0.4 } }),
      [
        usage("a", { inputTokens: 1, outputTokens: 1, costUsd: 0.45 }),
        budgetLog("x", { budget: "uncovered", reason: "unreported" }),
        budgetLog(
          "a",
          { budget: "exhausted", limitUsd: 0.4, spentUsd: 0.45, scope: "run" },
          "error"
        ),
      ]
    )
    expect(summary).toEqual({
      limitUsd: 0.4,
      maxCostUsd: 1,
      inheritedCeilingUsd: 0.4,
      spentUsd: 0.45,
      uncoveredStepIds: ["x"],
      exhausted: true,
    })
  })

  it("reads a budget stop from the run's error when the log is missing", () => {
    const summary = summarizeRunBudget(
      run(1, { error: { message: "spent", code: "budget_exhausted" } }),
      []
    )
    expect(summary).toMatchObject({ limitUsd: 1, spentUsd: 0, exhausted: true })
  })
})
