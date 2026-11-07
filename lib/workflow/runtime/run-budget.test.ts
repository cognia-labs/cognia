import type { WorkflowRunEventRow } from "@/types/workflow/visual"

import type { RunLogger } from "./event-log"
import {
  createRunBudget,
  getRunBudget,
  isModelCallingKind,
  registerRunBudget,
  unregisterRunBudget,
  WorkflowBudgetExhaustedError,
  type CreateRunBudgetOptions,
} from "./run-budget"

function fakeLogger() {
  const logger = {
    stepStarted: jest.fn(async () => undefined),
    stepCompleted: jest.fn(async () => undefined),
    stepUsage: jest.fn(async () => undefined),
    stepFailed: jest.fn(async () => undefined),
    log: jest.fn(async () => undefined),
  }
  return logger as typeof logger & RunLogger
}

/** The budget records a logger received, as `[level, data, stepId]`. */
function budgetLogs(logger: ReturnType<typeof fakeLogger>) {
  return logger.log.mock.calls.map((call) => {
    const [level, , data, stepId] = call as unknown as [string, string, unknown, string?]
    return [level, data, stepId]
  })
}

const KINDS: Record<string, string> = {
  a: "ai.prompt",
  b: "action.agent.turn",
  set: "flow.set",
  sub: "flow.subworkflow",
}

function budgetWith(overrides: Partial<CreateRunBudgetOptions> = {}) {
  const logger = fakeLogger()
  const onExhausted = jest.fn()
  const budget = createRunBudget({
    runId: "run_1",
    limitUsd: 1,
    logger,
    nodeKindOf: (id) => KINDS[id],
    onExhausted,
    ...overrides,
  })
  return { budget, logger, onExhausted }
}

const usage = (costUsd?: number, modelId?: string) => ({
  inputTokens: 1000,
  outputTokens: 500,
  totalTokens: 1500,
  ...(costUsd !== undefined ? { costUsd } : {}),
  ...(modelId ? { modelId } : {}),
})

describe("createRunBudget", () => {
  it("counts reported and priced usage and still writes the usage event", () => {
    const { budget, logger } = budgetWith()
    budget.logger.stepUsage("a", usage(0.2))
    budget.logger.stepUsage("b", usage(undefined, "gpt-4o"))

    expect(logger.stepUsage).toHaveBeenCalledTimes(2)
    expect(budget.spentUsd()).toBeGreaterThan(0.2)
    expect(budget.remainingUsd()).toBeCloseTo(1 - budget.spentUsd())
    expect(budget.exhausted()).toBeUndefined()
  })

  it("counts every attempt and iteration of a step, not just the last", () => {
    const { budget } = budgetWith()
    budget.logger.stepUsage("a", usage(0.3))
    budget.logger.stepUsage("a", usage(0.3))
    expect(budget.spentUsd()).toBeCloseTo(0.6)
  })

  it("stops the run once the spend reaches the limit, and only once", () => {
    const { budget, logger, onExhausted } = budgetWith()
    budget.logger.stepUsage("a", usage(0.6))
    budget.logger.stepUsage("b", usage(0.4))
    budget.logger.stepUsage("a", usage(0.1))

    expect(onExhausted).toHaveBeenCalledTimes(1)
    const error = onExhausted.mock.calls[0][0] as WorkflowBudgetExhaustedError
    expect(error).toBeInstanceOf(WorkflowBudgetExhaustedError)
    expect(error).toMatchObject({ code: "budget_exhausted", scope: "run", stepId: "b" })
    expect(error.spentUsd).toBeCloseTo(1)
    expect(error.message).toContain("$1.00")
    expect(budget.exhausted()).toBe(error)
    expect(budgetLogs(logger)).toEqual([
      [
        "error",
        { budget: "exhausted", limitUsd: 1, spentUsd: expect.closeTo(1), scope: "run" },
        "b",
      ],
    ])
  })

  it("marks unpriced usage as not covered without counting or stopping", () => {
    const { budget, logger, onExhausted } = budgetWith()
    budget.logger.stepUsage("a", usage(undefined, "mystery-model-xyz"))
    budget.logger.stepUsage("a", usage(undefined, "mystery-model-xyz"))

    expect(budget.spentUsd()).toBe(0)
    expect(onExhausted).not.toHaveBeenCalled()
    expect(budgetLogs(logger)).toEqual([
      ["warn", { budget: "uncovered", reason: "unpriced", nodeKind: "ai.prompt" }, "a"],
    ])
  })

  it("marks a model-calling step that finished without a usage report", () => {
    const { budget, logger } = budgetWith()
    budget.logger.stepStarted("b", { attempt: 1 })
    budget.logger.stepCompleted("b", "reply")
    // A step that does not call a model, a pinned output and a step that
    // reported usage are all left alone.
    budget.logger.stepStarted("set", { attempt: 1 })
    budget.logger.stepCompleted("set", 1)
    budget.logger.stepStarted("a", { pinned: true })
    budget.logger.stepCompleted("a", "pinned")

    expect(logger.stepCompleted).toHaveBeenCalledTimes(3)
    expect(budgetLogs(logger)).toEqual([
      ["warn", { budget: "uncovered", reason: "unreported", nodeKind: "action.agent.turn" }, "b"],
    ])

    const reported = budgetWith()
    reported.budget.logger.stepStarted("a", { attempt: 1 })
    reported.budget.logger.stepUsage("a", usage(0.1))
    reported.budget.logger.stepCompleted("a", "reply")
    expect(budgetLogs(reported.logger)).toEqual([])
  })

  it("resumes from what the run's events already spent", () => {
    const events = [
      { type: "step_usage", stepId: "a", payload: usage(0.5) },
      {
        type: "run_log",
        stepId: "b",
        payload: { message: "x", data: { budget: "uncovered", reason: "unreported" } },
      },
    ] as unknown as WorkflowRunEventRow[]
    const { budget, logger, onExhausted } = budgetWith()
    budget.hydrate(events)

    expect(budget.spentUsd()).toBeCloseTo(0.5)
    // Already marked, so finishing it again does not mark it twice.
    budget.logger.stepStarted("b", { attempt: 1 })
    budget.logger.stepCompleted("b", "reply")
    expect(budgetLogs(logger)).toEqual([])
    expect(onExhausted).not.toHaveBeenCalled()

    const spent = budgetWith({ limitUsd: 0.5 })
    spent.budget.hydrate(events)
    expect(spent.onExhausted).toHaveBeenCalledTimes(1)
    expect(spent.budget.exhausted()?.stepId).toBeUndefined()
  })
})

describe("a sub-workflow's budget", () => {
  function family(parentLimit: number, childLimit: number) {
    const parent = budgetWith({ runId: "run_parent", limitUsd: parentLimit })
    const child = budgetWith({
      runId: "run_child",
      limitUsd: childLimit,
      parent: parent.budget,
      parentStepId: "sub",
    })
    return { parent, child }
  }

  it("charges its spend to the parent on the calling step", () => {
    const { parent, child } = family(1, 1)
    child.budget.logger.stepUsage("a", usage(0.25))

    expect(child.budget.spentUsd()).toBeCloseTo(0.25)
    expect(parent.budget.spentUsd()).toBeCloseTo(0.25)
    expect(budgetLogs(parent.logger)).toEqual([
      ["info", { budget: "child-spend", childRunId: "run_child", costUsd: 0.25 }, "sub"],
    ])
  })

  it("stops itself first when its spend would exhaust the parent", () => {
    const { parent, child } = family(1, 5)
    parent.budget.logger.stepUsage("a", usage(0.7))
    child.budget.logger.stepUsage("a", usage(0.3))

    expect(child.onExhausted).toHaveBeenCalledTimes(1)
    expect(child.budget.exhausted()?.scope).toBe("parent")
    expect(parent.onExhausted).toHaveBeenCalledTimes(1)
    expect(parent.budget.exhausted()?.scope).toBe("run")
    expect(parent.budget.exhausted()?.stepId).toBe("sub")
    // The child stopped before the parent did, so its stop is the one it reports.
    expect(child.onExhausted.mock.invocationCallOrder[0]).toBeLessThan(
      parent.onExhausted.mock.invocationCallOrder[0]
    )
  })

  it("marks the parent's calling step when its own spend escapes the budget", () => {
    const { parent, child } = family(1, 1)
    child.budget.logger.stepUsage("a", usage(undefined, "mystery-model-xyz"))
    expect(budgetLogs(parent.logger)).toEqual([
      ["warn", { budget: "uncovered", reason: "child", childRunId: "run_child" }, "sub"],
    ])
  })
})

describe("the live budget registry", () => {
  it("finds a registered run's budget until it is unregistered", () => {
    const { budget } = budgetWith({ runId: "run_registry" })
    registerRunBudget(budget)
    expect(getRunBudget("run_registry")).toBe(budget)
    unregisterRunBudget("run_registry")
    expect(getRunBudget("run_registry")).toBeUndefined()
  })
})

describe("isModelCallingKind", () => {
  it("covers ai.* and the agent-running actions, not plain steps", () => {
    expect(isModelCallingKind("ai.prompt")).toBe(true)
    expect(isModelCallingKind("action.skill.invoke")).toBe(true)
    expect(isModelCallingKind("action.team.run")).toBe(true)
    expect(isModelCallingKind("flow.set")).toBe(false)
    expect(isModelCallingKind("action.fs.read")).toBe(false)
  })
})
