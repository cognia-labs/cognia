/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import { RunBudgetLine } from "./run-budget-line"

type BudgetRun = Pick<WorkflowRunRow, "workflowSnapshot" | "lineage" | "error">

function run(maxCostUsd: number | undefined, extra: Partial<BudgetRun> = {}): BudgetRun {
  return {
    workflowSnapshot: {
      nodes: [{ id: "n_ai", data: { label: "Summarise", params: {} } }],
      settings: maxCostUsd === undefined ? {} : { maxCostUsd },
    } as unknown as WorkflowRunRow["workflowSnapshot"],
    ...extra,
  }
}

const usage = (stepId: string, costUsd: number) =>
  ({
    type: "step_usage",
    stepId,
    payload: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd },
  }) as unknown as WorkflowRunEventRow

const uncovered = (stepId: string) =>
  ({
    type: "run_log",
    level: "warn",
    stepId,
    payload: { message: "m", data: { budget: "uncovered", reason: "unreported" } },
  }) as unknown as WorkflowRunEventRow

function mount(budgetRun: BudgetRun, events: WorkflowRunEventRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RunBudgetLine run={budgetRun} events={events} />
    </NextIntlClientProvider>
  )
}

describe("RunBudgetLine", () => {
  it("renders nothing for a run without a budget", () => {
    const { container } = mount(run(undefined), [usage("n_ai", 1)])
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the spend against the limit", () => {
    mount(run(2), [usage("n_ai", 0.5)])
    expect(screen.getByTestId("run-budget")).toHaveTextContent("Budget: $0.500 of $2.00")
    expect(screen.queryByTestId("run-budget-exhausted")).toBeNull()
    expect(screen.queryByTestId("run-budget-uncovered")).toBeNull()
  })

  it("says when the budget stopped the run and names the uncovered steps", () => {
    mount(run(1, { error: { message: "spent", code: "budget_exhausted" } }), [
      usage("n_ai", 1),
      uncovered("n_ai"),
      uncovered("n_gone"),
    ])
    expect(screen.getByTestId("run-budget-exhausted")).toHaveTextContent("Stopped: budget spent")
    expect(screen.getByTestId("run-budget-uncovered")).toHaveTextContent(
      "Not covered by the budget: Summarise, n_gone"
    )
  })

  it("marks a limit inherited from the parent run", () => {
    mount(run(5, { lineage: { rootRunId: "r", parentRunId: "p", budgetCeilingUsd: 0.25 } }), [])
    expect(screen.getByTestId("run-budget")).toHaveTextContent(
      "Budget: $0 of $0.250 (what the parent run had left)"
    )
  })
})
