/**
 * @jest-environment jsdom
 *
 * Coverage for the step inspector's streaming + usage additions (workflow ×
 * LLM deep integration). The pre-existing sections (params/output/logs) get
 * baseline assertions so regressions there surface too.
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enAggregate from "@/i18n/messages/en.json"
import enRuns from "@/i18n/messages/en/workflows/runs.json"
import type { VisualWorkflow, WorkflowRunEventRow } from "@/types/workflow/visual"
import { RunStepDetail } from "./run-step-detail"

const workflow: VisualWorkflow = {
  id: "wf1",
  schemaVersion: 2,
  name: "t",
  createdAt: 0,
  updatedAt: 0,
  nodes: [
    {
      id: "n1",
      type: "ai.prompt",
      typeVersion: 2,
      position: { x: 0, y: 0 },
      data: { label: "Ask", params: { userPrompt: "hi" } },
    },
  ],
  edges: [],
  settings: {
    errorPolicy: "stop",
    timeoutMs: 60_000,
    concurrency: 1,
    retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
  },
}

// The split source is the truth for this namespace. The jest `next-intl` mock
// reads the generated aggregate, which lags the split source until
// `pnpm i18n:build` runs; overlay this namespace so both agree (a no-op once
// the aggregate is rebuilt).
Object.assign(enAggregate.workflows.runs, enRuns)
const enMessages = enAggregate

function ev(partial: Partial<WorkflowRunEventRow> & Pick<WorkflowRunEventRow, "ts" | "type">) {
  return {
    id: `evt_${partial.ts}_${partial.type}`,
    runId: "r1",
    stepId: "n1",
    ...partial,
  } as WorkflowRunEventRow
}

function wrap(events: WorkflowRunEventRow[], stepId: string | null = "n1") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RunStepDetail workflow={workflow} events={events} stepId={stepId} />
    </NextIntlClientProvider>
  )
}

describe("RunStepDetail", () => {
  it("prompts for a selection when no step is chosen", () => {
    wrap([], null)
    expect(screen.getByText("Select a step in the timeline to inspect.")).toBeInTheDocument()
  })

  it("sizes the summary stats against its own pane, not the window", () => {
    // The detail renders both full-width on the runs page and inside the
    // editor's Context Workbench panel, which drags to 240px. A viewport
    // `sm:` breakpoint split the stats into two columns inside that panel on
    // any wide desktop.
    const { container } = wrap([
      ev({ ts: 1, type: "step_started" }),
      ev({ ts: 2, type: "step_completed", payload: { output: {} } }),
    ])
    const root = container.querySelector(".space-y-5") as HTMLElement
    expect(root.className).toContain("@container/run-step")
    const stats = container.querySelector(".grid.grid-cols-1") as HTMLElement
    expect(stats.className).toContain("@xs/run-step:grid-cols-2")
    expect(stats.className).not.toContain("sm:grid-cols-2")
  })

  it("shows the live streaming section while the step is running", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: { userPrompt: "hi" } } }),
      ev({ ts: 12, type: "step_stream", payload: { delta: "partial answer", seq: 0 } }),
    ])
    const block = screen.getByTestId("step-streaming-output")
    expect(block.textContent).toContain("partial answer")
    expect(screen.getByText("Live output")).toBeInTheDocument()
  })

  it("hides the streaming section and shows output once completed", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({ ts: 12, type: "step_stream", payload: { delta: "x", seq: 0 } }),
      ev({ ts: 20, type: "step_completed", payload: { output: { completion: "full text" } } }),
    ])
    expect(screen.queryByTestId("step-streaming-output")).toBeNull()
    expect(screen.getByText(/full text/)).toBeInTheDocument()
  })

  it("renders token / cost / served-by stats from the step_usage event", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({
        ts: 15,
        type: "step_usage",
        payload: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          costUsd: 0.0042,
          providerId: "openai",
          modelId: "gpt-x",
        },
      }),
      ev({ ts: 20, type: "step_completed", payload: { output: { completion: "done" } } }),
    ])
    expect(screen.getByText("Tokens (in / out)")).toBeInTheDocument()
    expect(screen.getByText("1.5K (1.2K / 300)")).toBeInTheDocument()
    expect(screen.getByText("$0.0042 est.")).toBeInTheDocument()
    expect(screen.getByText("openai · gpt-x")).toBeInTheDocument()
  })

  it("renders a dash for usage without pricing", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({
        ts: 15,
        type: "step_usage",
        payload: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      }),
      ev({ ts: 20, type: "step_completed", payload: { output: {} } }),
    ])
    expect(screen.getByText("Cost")).toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("lists retry attempts from step_retrying events", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({
        ts: 12,
        type: "step_retrying",
        payload: { attempt: 1, maxAttempts: 3, delayMs: 500, error: "rate limited" },
      }),
      ev({ ts: 20, type: "step_started", payload: { params: {} } }),
      ev({ ts: 30, type: "step_completed", payload: { output: {} } }),
    ])
    const attempts = screen.getByTestId("step-attempts")
    expect(attempts.textContent).toContain("#1/3")
    expect(attempts.textContent).toContain("rate limited")
  })

  it("shows error details for a failed step", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: {} } }),
      ev({ ts: 12, type: "step_failed", payload: { message: "boom", retryable: false } }),
    ])
    expect(screen.getByText("boom")).toBeInTheDocument()
    expect(
      screen.getByText("This error is marked non-retryable; retries were skipped.")
    ).toBeInTheDocument()
  })

  it("shows the resolved inputs the execution actually ran with", () => {
    wrap([
      ev({
        ts: 10,
        type: "step_started",
        payload: { inputs: { userPrompt: "resolved hi" }, stepExecutionId: "a", attempt: 1 },
      }),
      ev({ ts: 20, type: "step_completed", payload: { output: {}, stepExecutionId: "a" } }),
    ])
    expect(screen.getByText("Resolved inputs")).toBeInTheDocument()
    expect(screen.getByText(/resolved hi/)).toBeInTheDocument()
    expect(screen.queryByText("Configured params")).toBeNull()
  })

  it("labels a pinned execution as pinned data, never as resolved inputs", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { pinned: true, stepExecutionId: "p" } }),
      ev({
        ts: 11,
        type: "step_completed",
        payload: { output: { fixture: 1 }, stepExecutionId: "p" },
      }),
    ])
    expect(screen.getByTestId("step-pinned-note")).toBeInTheDocument()
    expect(screen.getByText("Pinned output")).toBeInTheDocument()
    expect(screen.queryByText("Resolved inputs")).toBeNull()
  })

  it("falls back to the configured params, labelled as such, for rows without inputs", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { params: { attempt: 1 } } }),
      ev({ ts: 20, type: "step_completed", payload: { output: {} } }),
    ])
    expect(screen.getByText("Configured params")).toBeInTheDocument()
    expect(screen.getByText(/"userPrompt": "hi"/)).toBeInTheDocument()
  })

  it("shows the recorded stack and cause of a failed execution", () => {
    wrap([
      ev({ ts: 10, type: "step_started", payload: { inputs: {}, stepExecutionId: "a" } }),
      ev({
        ts: 12,
        type: "step_failed",
        payload: {
          name: "TypeError",
          message: "bad input",
          stack: "TypeError: bad input\n    at execute (node.ts:4:11)",
          cause: { name: "Error", message: "root cause" },
          stepExecutionId: "a",
        },
      }),
    ])
    expect(screen.getByText("TypeError: bad input")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Show stack trace"))
    expect(screen.getByTestId("step-error-stack").textContent).toContain("node.ts:4:11")
    expect(screen.getByText(/root cause/)).toBeInTheDocument()
  })

  it("does not mix a failed first attempt with the successful retry", () => {
    wrap([
      ev({
        ts: 10,
        type: "step_started",
        payload: { inputs: { try: "one" }, stepExecutionId: "a", attempt: 1 },
      }),
      ev({
        ts: 12,
        type: "step_usage",
        payload: { totalTokens: 100, inputTokens: 60, outputTokens: 40, stepExecutionId: "a" },
      }),
      ev({ ts: 14, type: "step_failed", payload: { message: "first boom", stepExecutionId: "a" } }),
      ev({
        ts: 20,
        type: "step_started",
        payload: { inputs: { try: "two" }, stepExecutionId: "b", attempt: 2 },
      }),
      ev({
        ts: 22,
        type: "step_usage",
        payload: { totalTokens: 30, inputTokens: 20, outputTokens: 10, stepExecutionId: "b" },
      }),
      ev({
        ts: 30,
        type: "step_completed",
        payload: { output: { answer: "second ok" }, stepExecutionId: "b" },
      }),
    ])
    // Default: the latest execution, with only its own evidence.
    expect(screen.getByText(/second ok/)).toBeInTheDocument()
    expect(screen.getByText(/"try": "two"/)).toBeInTheDocument()
    expect(screen.queryByText("first boom")).toBeNull()
    expect(screen.getByText("30 (20 / 10)")).toBeInTheDocument()
    // The aggregate sums both executions, separately from the details.
    const summary = screen.getByTestId("step-executions-summary")
    expect(within(summary).getByText("2")).toBeInTheDocument()
    expect(within(summary).getByText("130 (80 / 50)")).toBeInTheDocument()
    expect(screen.getByTestId("step-execution-picker").textContent).toContain(
      "Run 2 · attempt 2 · completed"
    )
  })
})
