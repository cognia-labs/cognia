import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { exportPlanAsWorkflow, type PlanWorkflowExportDeps } from "./workflow-export"
import { PlanExportError, type PlanWorkflowDraft } from "./workflow-conversion"
import { PlanSynthesizeError } from "./synthesize-workflow"

function step(over: Partial<PlanStep>): PlanStep {
  return {
    id: "s",
    title: "step",
    kind: "agent_turn",
    status: "pending",
    order: 0,
    dependencies: [],
    ...over,
  } as PlanStep
}

function plan(steps: PlanStep[]): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship v2",
    source: "manual",
    executionMode: "auto",
    steps,
    status: "awaiting_approval",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  } as AgentPlan
}

function deps(owners: Record<string, string> = {}): jest.Mocked<PlanWorkflowExportDeps> {
  return {
    resolveToolOwner: jest.fn(async (name: string) => owners[name]),
    createWorkflow: jest.fn(async (_draft: PlanWorkflowDraft) => ({ id: "wf_new" })),
    recordExport: jest.fn(async (_planId: string, _workflowId: string) => {}),
  }
}

describe("exportPlanAsWorkflow", () => {
  it("persists the standalone draft and links it from the plan", async () => {
    const d = deps()
    const result = await exportPlanAsWorkflow(
      plan([step({ id: "a" }), step({ id: "b", order: 1, dependencies: ["a"] })]),
      d
    )
    expect(result).toEqual({ workflowId: "wf_new", stepCount: 2 })
    expect(d.createWorkflow).toHaveBeenCalledTimes(1)
    expect(d.createWorkflow.mock.calls[0][0].nodes.map((n) => n.type)).toEqual([
      "trigger.manual",
      "action.agent.turn",
      "action.agent.turn",
    ])
    expect(d.recordExport).toHaveBeenCalledWith("p1", "wf_new")
  })

  it("resolves each tool's plugin once and names it on the node", async () => {
    const d = deps({ search_docs: "docs" })
    await exportPlanAsWorkflow(
      plan([
        step({
          id: "a",
          kind: "tool_call",
          params: { kind: "tool_call", toolName: "search_docs", input: {} },
        }),
        step({
          id: "b",
          kind: "tool_call",
          order: 1,
          dependencies: ["a"],
          params: { kind: "tool_call", toolName: "search_docs", input: { page: 2 } },
        }),
      ]),
      d
    )
    expect(d.resolveToolOwner).toHaveBeenCalledTimes(1)
    const toolNodes = d.createWorkflow.mock.calls[0][0].nodes.slice(1)
    expect(toolNodes.map((n) => (n.data.params as { pluginId?: string }).pluginId)).toEqual([
      "docs",
      "docs",
    ])
  })

  it("writes nothing when a step has no standalone equivalent", async () => {
    const d = deps()
    await expect(
      exportPlanAsWorkflow(
        plan([
          step({
            id: "tm",
            title: "Ask the reviewer",
            kind: "teammate_dispatch",
            params: { kind: "teammate_dispatch" },
          }),
        ]),
        d
      )
    ).rejects.toBeInstanceOf(PlanExportError)
    expect(d.createWorkflow).not.toHaveBeenCalled()
    expect(d.recordExport).not.toHaveBeenCalled()
  })

  it("writes nothing for an invalid plan graph", async () => {
    const d = deps()
    await expect(
      exportPlanAsWorkflow(
        plan([
          step({ id: "a", dependencies: ["b"] }),
          step({ id: "b", order: 1, dependencies: ["a"] }),
        ]),
        d
      )
    ).rejects.toBeInstanceOf(PlanSynthesizeError)
    expect(d.createWorkflow).not.toHaveBeenCalled()
  })
})
