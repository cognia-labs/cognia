/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import type { WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"

import { RunBudgetLine } from "./run-budget-line"

type BudgetRun = Pick<WorkflowRunRow, "workflowSnapshot" | "error">

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

const settled = (spentUsd: number) =>
  ({
    type: "run_log",
    level: "info",
    payload: { message: "m", data: { budget: "spent", limitUsd: 1, spentUsd } },
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
  })

  it("says when the budget stopped the run, with the ledger's settled spend", () => {
    mount(run(1, { error: { message: "spent", code: "budget_exhausted" } }), [
      usage("n_ai", 0.5),
      settled(1.1),
    ])
    expect(screen.getByTestId("run-budget")).toHaveTextContent("Budget: $1.10 of $1.00")
    expect(screen.getByTestId("run-budget-exhausted")).toHaveTextContent("Stopped: budget spent")
  })
})
