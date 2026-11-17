/**
 * @jest-environment node
 */
import type { WorkflowRunEventRow } from "@/types/workflow/visual"
import {
  UNATTRIBUTED_EXECUTION_KEY,
  groupStepExecutions,
  summarizeStepExecutions,
} from "./step-executions"

let ts = 0
function ev(type: WorkflowRunEventRow["type"], payload?: unknown): WorkflowRunEventRow {
  ts += 10
  return { id: `e${ts}`, runId: "r", stepId: "n1", ts, type, payload }
}

beforeEach(() => {
  ts = 0
})

describe("groupStepExecutions", () => {
  it("keeps a retry's attempts apart instead of mixing first input with last output", () => {
    const a = { stepExecutionId: "a", attempt: 1 }
    const b = { stepExecutionId: "b", attempt: 2 }
    const { executions } = groupStepExecutions([
      ev("step_started", { inputs: { q: 1 }, ...a }),
      ev("step_usage", { totalTokens: 5, costUsd: 0.01, ...a }),
      ev("step_failed", { message: "boom", ...a }),
      ev("step_retrying", { maxAttempts: 2, ...a }),
      ev("step_started", { inputs: { q: 1 }, ...b }),
      ev("step_usage", { totalTokens: 7, costUsd: 0.02, ...b }),
      ev("step_completed", { output: "ok", ...b }),
    ])
    expect(executions.map((e) => [e.key, e.attempt, e.status])).toEqual([
      ["a", 1, "failed"],
      ["b", 2, "completed"],
    ])
    expect(executions[0].completed).toBeUndefined()
    expect(executions[1].failed).toBeUndefined()
    expect(executions[0].usage?.totalTokens).toBe(5)
    expect(executions[1].usage?.totalTokens).toBe(7)
  })

  it("separates loop iterations and keeps their iteration index", () => {
    const { executions } = groupStepExecutions([
      ev("step_started", { stepExecutionId: "i0", loopId: "L", iterationIndex: 0 }),
      ev("step_started", { stepExecutionId: "i1", loopId: "L", iterationIndex: 1 }),
      ev("step_completed", { output: 1, stepExecutionId: "i1" }),
      ev("step_completed", { output: 0, stepExecutionId: "i0" }),
    ])
    expect(executions.map((e) => [e.iterationIndex, e.completed?.payload])).toEqual([
      [0, { output: 0, stepExecutionId: "i0" }],
      [1, { output: 1, stepExecutionId: "i1" }],
    ])
  })

  it("puts rows without an id into one unattributed execution", () => {
    const { executions } = groupStepExecutions([
      ev("step_started", { params: { attempt: 1 } }),
      ev("step_completed", { output: 1 }),
    ])
    expect(executions).toHaveLength(1)
    expect(executions[0].key).toBe(UNATTRIBUTED_EXECUTION_KEY)
    expect(executions[0].status).toBe("completed")
  })

  it("keeps a log written outside any execution as a step-level event, not an execution", () => {
    const { executions, stepLevelEvents } = groupStepExecutions([
      ev("step_started", { stepExecutionId: "a" }),
      ev("run_log", { message: "between attempts" }),
    ])
    expect(executions.map((e) => e.key)).toEqual(["a"])
    expect(executions[0].status).toBe("running")
    expect(stepLevelEvents.map((e) => e.type)).toEqual(["run_log"])
  })
})

describe("summarizeStepExecutions", () => {
  it("sums each execution's latest usage and reports the latest status", () => {
    const { executions } = groupStepExecutions([
      ev("step_started", { stepExecutionId: "a" }),
      ev("step_usage", { totalTokens: 2, inputTokens: 1, outputTokens: 1, stepExecutionId: "a" }),
      ev("step_usage", {
        totalTokens: 5,
        inputTokens: 3,
        outputTokens: 2,
        costUsd: 0.01,
        stepExecutionId: "a",
      }),
      ev("step_failed", { message: "x", stepExecutionId: "a" }),
      ev("step_started", { stepExecutionId: "b" }),
      ev("step_usage", {
        totalTokens: 4,
        inputTokens: 2,
        outputTokens: 2,
        costUsd: 0.02,
        stepExecutionId: "b",
      }),
      ev("step_completed", { output: 1, stepExecutionId: "b" }),
    ])
    const summary = summarizeStepExecutions(executions)
    expect(summary).toMatchObject({
      executionCount: 2,
      status: "completed",
      totalTokens: 9,
      inputTokens: 5,
      outputTokens: 4,
      durationMs: 60,
    })
    expect(summary?.costUsd).toBeCloseTo(0.03)
  })

  it("returns null for a step with no executions", () => {
    expect(summarizeStepExecutions([])).toBeNull()
  })
})
