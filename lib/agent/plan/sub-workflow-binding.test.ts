import type { PlanStep } from "@/types/agent/plan"
import type { WorkflowDependencyBinding } from "@/types/workflow/deployment"
import {
  PlanApprovalBlockedError,
  bindSubWorkflowSteps,
  planApprovalBlockedMessage,
  type SubWorkflowBindingDeps,
} from "./sub-workflow-binding"

const binding = (workflowId: string, versionId: string): WorkflowDependencyBinding => ({
  workflowId,
  versionId,
  deploymentId: `dep_${workflowId}`,
  deploymentRevision: 1,
  dependencyLock: { workflows: {}, indexes: {} },
})

function subStep(
  id: string,
  workflowId: string,
  pin?: WorkflowDependencyBinding,
  title = `run ${workflowId}`
): PlanStep {
  return {
    id,
    title,
    kind: "sub_workflow",
    status: "pending",
    order: 0,
    dependencies: [],
    params: { kind: "sub_workflow", workflowId, ...(pin ? { binding: pin } : {}) },
  }
}

const turn: PlanStep = {
  id: "t",
  title: "think",
  kind: "agent_turn",
  status: "pending",
  order: 0,
  dependencies: [],
}

/** Resolves every workflow to version `<id>@<n>`, counting calls. */
function resolver(
  versions: Record<string, string | { reason: "not-published" | "dependencies-unavailable" }>
): SubWorkflowBindingDeps & { resolve: jest.Mock } {
  return {
    resolve: jest.fn(async (workflowId: string) => {
      const v = versions[workflowId]
      if (v === undefined || typeof v !== "string") {
        return {
          ok: false as const,
          reason: typeof v === "object" ? v.reason : "not-published",
          detail: `no deployment for ${workflowId}`,
        }
      }
      return { ok: true as const, binding: binding(workflowId, v) }
    }),
  }
}

describe("bindSubWorkflowSteps", () => {
  it("returns the same array when no step needs a pin", async () => {
    const steps = [turn]
    const deps = resolver({})
    await expect(bindSubWorkflowSteps(steps, "approve", deps)).resolves.toBe(steps)
    expect(deps.resolve).not.toHaveBeenCalled()
  })

  it("approval pins every sub-workflow step to what is published now, once per workflow", async () => {
    const deps = resolver({ wf_a: "v2", wf_b: "v7" })
    const bound = await bindSubWorkflowSteps(
      [
        subStep("a1", "wf_a", binding("wf_a", "v1")),
        subStep("a2", "wf_a"),
        turn,
        subStep("b", "wf_b"),
      ],
      "approve",
      deps
    )
    expect(deps.resolve.mock.calls.map(([id]) => id)).toEqual(["wf_a", "wf_b"])
    const pins = bound.map((s) => (s.params?.kind === "sub_workflow" ? s.params.binding : null))
    // A re-approval re-pins: the person approves what is published now.
    expect(pins.map((p) => p?.versionId ?? null)).toEqual(["v2", "v2", null, "v7"])
  })

  it("refuses the whole approval before changing any step", async () => {
    const deps = resolver({ wf_a: "v1" })
    const steps = [subStep("a", "wf_a"), subStep("b", "wf_missing", undefined, "Publish notes")]
    let caught: unknown
    try {
      await bindSubWorkflowSteps(steps, "approve", deps)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PlanApprovalBlockedError)
    expect(caught).toMatchObject({
      reason: "not-published",
      stepId: "b",
      stepTitle: "Publish notes",
      workflowId: "wf_missing",
      retryable: false,
    })
    // The input array is untouched (no partial pins leak into the plan).
    expect(steps[0].params).toEqual({ kind: "sub_workflow", workflowId: "wf_a" })
  })

  it("reports a published workflow whose dependencies cannot be admitted", async () => {
    const deps = resolver({ wf_a: { reason: "dependencies-unavailable" } })
    await expect(
      bindSubWorkflowSteps([subStep("a", "wf_a")], "approve", deps)
    ).rejects.toMatchObject({
      reason: "dependencies-unavailable",
      message: expect.stringContaining("cannot be admitted"),
    })
  })

  describe("edit mode", () => {
    it("keeps the versions untouched steps were approved on", async () => {
      const deps = resolver({ wf_a: "v9", wf_b: "v3" })
      const approvedA = binding("wf_a", "v1")
      const bound = await bindSubWorkflowSteps(
        [subStep("a", "wf_a", approvedA), subStep("b", "wf_b")],
        "edit",
        deps
      )
      expect(deps.resolve.mock.calls.map(([id]) => id)).toEqual(["wf_b"])
      const [a, b] = bound.map((s) => (s.params?.kind === "sub_workflow" ? s.params.binding : null))
      expect(a).toBe(approvedA)
      expect(b?.versionId).toBe("v3")
    })

    it("carries a pin an editor dropped from a step that still names the same workflow", async () => {
      const deps = resolver({ wf_a: "v9" })
      const approvedA = binding("wf_a", "v1")
      const bound = await bindSubWorkflowSteps([subStep("a", "wf_a")], "edit", deps, [
        subStep("a", "wf_a", approvedA),
      ])
      expect(deps.resolve).not.toHaveBeenCalled()
      expect(bound[0].params).toMatchObject({ binding: approvedA })
    })

    it("re-pins a step that now names another workflow", async () => {
      const deps = resolver({ wf_b: "v4" })
      const bound = await bindSubWorkflowSteps(
        [subStep("a", "wf_b", binding("wf_a", "v1"))],
        "edit",
        deps,
        [subStep("a", "wf_a", binding("wf_a", "v1"))]
      )
      expect(bound[0].params).toMatchObject({ binding: { workflowId: "wf_b", versionId: "v4" } })
    })
  })
})

describe("planApprovalBlockedMessage", () => {
  it.each([
    ["not-published", "notPublished"],
    ["dependencies-unavailable", "dependenciesUnavailable"],
  ] as const)("maps %s to plan.approvalBlocked.%s with the step and workflow", (reason, key) => {
    const error = new PlanApprovalBlockedError(reason, "s1", "Publish notes", "wf_a", "detail")
    expect(planApprovalBlockedMessage(error)).toEqual({
      key,
      values: { step: "Publish notes", workflow: "wf_a" },
    })
  })
})
