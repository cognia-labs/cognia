import {
  PLAN_REFINEMENT_PROMPTS,
  REJECTABLE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  isRejectablePlanStatus,
  isTerminalPlanStatus,
  isTerminalStepStatus,
  type CreatePlanStepInput,
  type PlanStep,
} from "@/types/agent/plan"
import {
  MAX_PLAN_STEP_TITLE_LEN,
  applyStepStatus,
  linearAgentTurnSteps,
  refinedStepInputs,
  reconcileBlockedSteps,
  materializeSteps,
  nextRunnableStep,
  skipStepInDag,
} from "./steps"

function input(over: Partial<CreatePlanStepInput> = {}): CreatePlanStepInput {
  return { title: over.title ?? "step", kind: over.kind ?? "agent_turn", ...over }
}

describe("linearAgentTurnSteps", () => {
  it("chains each step onto its predecessor", () => {
    const steps = linearAgentTurnSteps(["a", "b", "c"])
    expect(steps.map((s) => s.kind)).toEqual(["agent_turn", "agent_turn", "agent_turn"])
    expect(steps[0].dependsOn).toBeUndefined()
    expect(steps[1].dependsOn).toEqual([0])
    expect(steps[2].dependsOn).toEqual([1])
  })

  it("clamps titles so one long line cannot bloat the row", () => {
    const [step] = linearAgentTurnSteps(["x".repeat(MAX_PLAN_STEP_TITLE_LEN + 50)])
    expect(step.title).toHaveLength(MAX_PLAN_STEP_TITLE_LEN)
  })

  it("returns an empty chain for no titles", () => {
    expect(linearAgentTurnSteps([])).toEqual([])
  })

  // The chain feeds `materializeSteps` in every producer; the index → id remap
  // has to survive that hand-off or dependencies silently vanish.
  it("round-trips through materializeSteps into id-based dependencies", () => {
    const steps = materializeSteps(linearAgentTurnSteps(["a", "b"]))
    expect(steps[0].dependencies).toEqual([])
    expect(steps[1].dependencies).toEqual([steps[0].id])
  })
})

describe("refinedStepInputs", () => {
  const plain = (id: string, order: number, deps: string[] = []): PlanStep =>
    ({
      id,
      title: id,
      kind: "agent_turn",
      status: "pending",
      order,
      dependencies: deps,
    }) as PlanStep

  it("keeps a plain agent_turn chain a chain", () => {
    const previous = [plain("a", 0), plain("b", 1, ["a"])]
    expect(refinedStepInputs(previous, ["x", "y"])).toEqual(linearAgentTurnSteps(["x", "y"]))
  })

  it("keeps matched steps' kind, params and surviving edges; new titles chain on", () => {
    const previous = [
      {
        ...plain("Ask", 0),
        kind: "teammate_dispatch",
        params: { kind: "teammate_dispatch", teamId: "t1" },
        description: "who",
      },
      { ...plain("Drop", 1, ["Ask"]), kind: "tool_call" },
      { ...plain("Gate", 2, ["Ask", "Drop"]), kind: "approval_gate" },
    ] as PlanStep[]
    expect(refinedStepInputs(previous, ["Ask", "Notes", "Gate"])).toEqual([
      {
        title: "Ask",
        kind: "teammate_dispatch",
        description: "who",
        params: { kind: "teammate_dispatch", teamId: "t1" },
      },
      { title: "Notes", kind: "agent_turn", dependsOn: [0] },
      { title: "Gate", kind: "approval_gate", dependsOn: [0] },
    ])
  })

  it("matches repeated titles one step each, in order", () => {
    const previous = [
      { ...plain("Same", 0), kind: "tool_call" },
      { ...plain("Same", 1), id: "same-2", kind: "approval_gate" },
    ] as PlanStep[]
    expect(refinedStepInputs(previous, ["Same", "Same"]).map((s) => s.kind)).toEqual([
      "tool_call",
      "approval_gate",
    ])
  })
})

describe("materializeSteps", () => {
  it("carries a step's issue binding onto the materialized step", () => {
    const steps = materializeSteps([input({ issueId: "iss_1" }), input()])
    expect(steps[0].issueId).toBe("iss_1")
    expect("issueId" in steps[1]).toBe(false)
  })

  it("assigns ids, 0-based order, pending status, and zero attempts", () => {
    const steps = materializeSteps([input({ title: "a" }), input({ title: "b" })])
    expect(steps).toHaveLength(2)
    expect(steps[0].order).toBe(0)
    expect(steps[1].order).toBe(1)
    expect(steps.every((s) => s.status === "pending")).toBe(true)
    expect(steps.every((s) => s.attempts === 0)).toBe(true)
    expect(new Set(steps.map((s) => s.id)).size).toBe(2)
  })

  it("resolves dependsOn indices into dependency ids", () => {
    const steps = materializeSteps([input({ title: "a" }), input({ title: "b", dependsOn: [0] })])
    expect(steps[1].dependencies).toEqual([steps[0].id])
  })

  it("drops self-refs and out-of-range / non-integer dep indices", () => {
    const steps = materializeSteps([
      input({ title: "a", dependsOn: [0, 5, -1, 1.5 as unknown as number] }),
      input({ title: "b", dependsOn: [0] }),
    ])
    expect(steps[0].dependencies).toEqual([]) // 0 is self, others invalid
    expect(steps[1].dependencies).toEqual([steps[0].id])
  })

  it("carries params and estimatedDurationMs through", () => {
    const steps = materializeSteps([
      input({
        kind: "tool_call",
        params: { kind: "tool_call", toolName: "Read", input: {} },
        estimatedDurationMs: 1000,
      }),
    ])
    expect(steps[0].params).toEqual({ kind: "tool_call", toolName: "Read", input: {} })
    expect(steps[0].estimatedDurationMs).toBe(1000)
  })
})

describe("applyStepStatus", () => {
  const base: PlanStep[] = materializeSteps([
    input({ title: "a" }),
    input({ title: "b" }),
    input({ title: "c" }),
  ])

  it("sets the status and recomputes completed count", () => {
    const r = applyStepStatus(base, base[0].id, "completed")
    expect(r.steps[0].status).toBe("completed")
    expect(r.completedSteps).toBe(1)
    expect(r.totalSteps).toBe(3)
  })

  it("applies the field patch alongside the status", () => {
    const r = applyStepStatus(base, base[0].id, "failed", { error: "boom", attempts: 2 })
    expect(r.steps[0].error).toBe("boom")
    expect(r.steps[0].attempts).toBe(2)
  })

  it("points currentStepId at the in_progress step when present", () => {
    const r = applyStepStatus(base, base[1].id, "in_progress")
    expect(r.currentStepId).toBe(base[1].id)
  })

  it("falls back to the first non-terminal step in order", () => {
    const r = applyStepStatus(base, base[0].id, "completed")
    expect(r.currentStepId).toBe(base[1].id)
  })

  it("yields undefined currentStepId when all steps are terminal", () => {
    let steps = base
    for (const s of base) steps = applyStepStatus(steps, s.id, "completed").steps
    const r = applyStepStatus(steps, base[2].id, "completed")
    expect(r.currentStepId).toBeUndefined()
  })
})

describe("type helpers", () => {
  it("isTerminalStepStatus matches the terminal set", () => {
    expect(isTerminalStepStatus("completed")).toBe(true)
    expect(isTerminalStepStatus("failed")).toBe(true)
    expect(isTerminalStepStatus("skipped")).toBe(true)
    expect(isTerminalStepStatus("pending")).toBe(false)
    expect(isTerminalStepStatus("in_progress")).toBe(false)
  })

  it("treats a rejection as terminal, alongside completed / failed / cancelled", () => {
    expect([...TERMINAL_PLAN_STATUSES].sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "rejected",
    ])
    for (const status of TERMINAL_PLAN_STATUSES) expect(isTerminalPlanStatus(status)).toBe(true)
    expect(isTerminalPlanStatus("paused")).toBe(false)
    expect(isTerminalPlanStatus("awaiting_approval")).toBe(false)
  })

  it("only lets a plan that has not started be rejected", () => {
    expect([...REJECTABLE_PLAN_STATUSES]).toEqual(["draft", "awaiting_approval", "approved"])
    expect(isRejectablePlanStatus("awaiting_approval")).toBe(true)
    // Backing out of a running plan is a cancellation, not a rejection.
    expect(isRejectablePlanStatus("executing")).toBe(false)
    expect(isRejectablePlanStatus("paused")).toBe(false)
    expect(isRejectablePlanStatus("rejected")).toBe(false)
  })

  it("PLAN_REFINEMENT_PROMPTS covers every refinement type including repair", () => {
    expect(Object.keys(PLAN_REFINEMENT_PROMPTS).sort()).toEqual([
      "expand",
      "optimize",
      "reorder",
      "repair",
      "simplify",
    ])
  })
})

describe("nextRunnableStep", () => {
  function s(id: string, over: Partial<PlanStep> = {}): PlanStep {
    return {
      id,
      title: id,
      kind: "agent_turn",
      status: "pending",
      order: 0,
      dependencies: [],
      ...over,
    }
  }

  it("returns the first non-terminal step in order", () => {
    const steps = [
      s("b", { order: 1 }),
      s("a", { order: 0, status: "completed" }),
      s("c", { order: 2 }),
    ]
    expect(nextRunnableStep(steps)?.id).toBe("b")
  })

  it("skips steps whose dependency has not completed", () => {
    const steps = [
      s("a", { order: 0, status: "in_progress" }),
      s("b", { order: 1, dependencies: ["a"] }),
    ]
    expect(nextRunnableStep(steps)?.id).toBe("a")
  })

  it("returns undefined when a dependency failed", () => {
    const steps = [
      s("a", { order: 0, status: "failed" }),
      s("b", { order: 1, dependencies: ["a"] }),
    ]
    expect(nextRunnableStep(steps)).toBeUndefined()
  })

  it("treats a skipped dependency as unmet (does not jump the broken link)", () => {
    const steps = [
      s("a", { order: 0, status: "skipped" }),
      s("b", { order: 1, dependencies: ["a"] }),
    ]
    expect(nextRunnableStep(steps)).toBeUndefined()
  })

  it("returns undefined when every step is terminal", () => {
    expect(nextRunnableStep([s("a", { status: "completed" })])).toBeUndefined()
  })

  it("returns undefined for an empty plan", () => {
    expect(nextRunnableStep([])).toBeUndefined()
  })

  it("runs a step whose dependencies have all completed", () => {
    const steps = [
      s("a", { order: 0, status: "completed" }),
      s("b", { order: 1, status: "completed" }),
      s("c", { order: 2, dependencies: ["a", "b"] }),
    ]
    expect(nextRunnableStep(steps)?.id).toBe("c")
  })
})

describe("skipStepInDag", () => {
  function s(id: string, order: number, over: Partial<PlanStep> = {}): PlanStep {
    return {
      id,
      title: id,
      kind: "agent_turn",
      status: "pending",
      order,
      dependencies: [],
      ...over,
    }
  }

  it("marks the step skipped and re-points its dependents at its prerequisites", () => {
    const steps = [
      s("a", 0, { status: "completed" }),
      s("b", 1, { status: "failed", dependencies: ["a"] }),
      s("c", 2, { dependencies: ["b"] }),
    ]
    const out = skipStepInDag(steps, "b", { error: undefined })
    const byId = new Map(out.steps.map((step) => [step.id, step]))
    expect(byId.get("b")?.status).toBe("skipped")
    expect(byId.get("c")?.dependencies).toEqual(["a"])
    // The dependent is now runnable, so a resumed linear plan carries on.
    expect(nextRunnableStep(out.steps)?.id).toBe("c")
    expect(out.currentStepId).toBe("c")
  })

  it("merges inherited prerequisites without duplicates and keeps unrelated edges", () => {
    const steps = [
      s("a", 0, { status: "completed" }),
      s("x", 1, { status: "completed" }),
      s("b", 2, { dependencies: ["a", "x"] }),
      s("c", 3, { dependencies: ["x", "b"] }),
    ]
    const out = skipStepInDag(steps, "b")
    expect(out.steps.find((step) => step.id === "c")?.dependencies).toEqual(["x", "a"])
  })

  it("a skipped root leaves its dependents with no prerequisites", () => {
    const steps = [s("a", 0, { status: "failed" }), s("b", 1, { dependencies: ["a"] })]
    const out = skipStepInDag(steps, "a")
    expect(out.steps.find((step) => step.id === "b")?.dependencies).toEqual([])
    expect(nextRunnableStep(out.steps)?.id).toBe("b")
  })

  it("is a plain status write for an unknown step id", () => {
    const steps = [s("a", 0)]
    const out = skipStepInDag(steps, "missing")
    expect(out.steps).toEqual(steps)
  })
})

describe("dependency failure blocking", () => {
  const dag = () =>
    materializeSteps([
      input({ title: "root" }),
      input({ title: "left", dependsOn: [0] }),
      input({ title: "right", dependsOn: [0] }),
      input({ title: "join", dependsOn: [1, 2] }),
      input({ title: "independent" }),
    ])

  it("blocks pending transitive dependents, preserves other states and does not mutate inputs", () => {
    const steps = dag()
    steps[0].status = "failed"
    steps[2].status = "in_progress"
    const next = reconcileBlockedSteps(steps, "stop")
    expect(next.map((s) => s.status)).toEqual([
      "failed",
      "blocked",
      "in_progress",
      "blocked",
      "pending",
    ])
    expect(steps[1].status).toBe("pending")
    expect(applyStepStatus(next, steps[0].id, "failed")).toMatchObject({
      completedSteps: 0,
      totalSteps: 5,
      currentStepId: steps[2].id,
    })
    steps[2].status = "completed"
    const settled = reconcileBlockedSteps(steps, "stop")
    expect(settled[2].status).toBe("completed")
    expect(applyStepStatus(settled, steps[0].id, "failed")).toMatchObject({
      completedSteps: 1,
      currentStepId: steps[4].id,
    })
  })

  it.each(["pending", "skipped", "completed"] as const)(
    "unblocks after a failed root becomes %s",
    (status) => {
      const steps = dag()
      steps[0].status = "failed"
      const blocked = reconcileBlockedSteps(steps, "stop")
      blocked[0] = { ...blocked[0], status }
      expect(reconcileBlockedSteps(blocked, "stop").map((s) => s.status)).toEqual([
        status,
        "pending",
        "pending",
        "pending",
        "pending",
      ])
    }
  )

  it("keeps a shared descendant blocked until every failed ancestor is resolved", () => {
    const steps = dag()
    steps[0].status = "failed"
    steps[2].status = "failed"
    const blocked = reconcileBlockedSteps(steps, "stop")
    blocked[0].status = "pending"
    expect(reconcileBlockedSteps(blocked, "stop").map((s) => s.status)).toEqual([
      "pending",
      "pending",
      "failed",
      "blocked",
      "pending",
    ])
  })

  it.each(["continue"] as const)("does not block under the %s policy", (policy) => {
    const steps = dag()
    steps[0].status = "failed"
    expect(reconcileBlockedSteps(steps, policy).map((s) => s.status)).toEqual([
      "failed",
      "pending",
      "pending",
      "pending",
      "pending",
    ])
  })

  it("never selects blocked steps, even with satisfied dependencies", () => {
    const steps = materializeSteps([input(), input({ dependsOn: [0] })])
    steps[0].status = "completed"
    steps[1].status = "blocked"
    expect(nextRunnableStep(steps)).toBeUndefined()
    expect(applyStepStatus(steps, steps[0].id, "completed")).toMatchObject({
      completedSteps: 1,
      totalSteps: 2,
      currentStepId: undefined,
    })
  })
})
