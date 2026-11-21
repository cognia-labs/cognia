import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import { PlanExportError, planInputFromWorkflow, planWorkflowDraft } from "./workflow-conversion"
import { PlanSynthesizeError } from "./synthesize-workflow"
import { validateWorkflow } from "@/lib/workflow/definition/validate"
import { validateNodeParams } from "@/lib/workflow/nodes/validate-params"
import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: over.id ?? "s1",
    title: over.title ?? "step",
    kind: over.kind ?? "agent_turn",
    status: "pending",
    order: over.order ?? 0,
    dependencies: over.dependencies ?? [],
    ...over,
  } as PlanStep
}

function plan(steps: PlanStep[], over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship v2",
    description: "the release",
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
    ...over,
  } as AgentPlan
}

describe("planWorkflowDraft", () => {
  const linear = () => [
    step({ id: "a", order: 0 }),
    step({ id: "b", order: 1, dependencies: ["a"] }),
  ]

  it("emits a manual trigger feeding every root step", () => {
    const draft = planWorkflowDraft(plan(linear()))
    const trigger = draft.nodes[0]
    expect(trigger.type).toBe("trigger.manual")
    expect(draft.edges[0]).toMatchObject({ source: trigger.id, target: "a" })
    // Only roots are wired to the trigger; "b" keeps its own dependency edge.
    expect(draft.edges.filter((e) => e.source === trigger.id)).toHaveLength(1)
    expect(draft.edges).toContainEqual(expect.objectContaining({ source: "a", target: "b" }))
  })

  it("wires every root when the plan fans out", () => {
    const draft = planWorkflowDraft(
      plan([
        step({ id: "a", order: 0 }),
        step({ id: "b", order: 1 }),
        step({ id: "c", order: 2, dependencies: ["a", "b"] }),
      ])
    )
    const triggerId = draft.nodes[0].id
    expect(draft.edges.filter((e) => e.source === triggerId).map((e) => e.target)).toEqual([
      "a",
      "b",
    ])
  })

  // The synthesizer stacks every node at 0,0 — fine headless, unusable in the
  // canvas. An exported workflow is meant to be opened, so positions must be
  // real and distinct.
  it("lays the steps out by dependency level with no overlaps", () => {
    const draft = planWorkflowDraft(
      plan([
        step({ id: "a", order: 0 }),
        step({ id: "b", order: 1 }),
        step({ id: "c", order: 2, dependencies: ["a"] }),
      ])
    )
    const byId = new Map(draft.nodes.map((n) => [n.id, n.position]))
    expect(byId.get("a")!.x).toBe(byId.get("b")!.x)
    expect(byId.get("a")!.y).not.toBe(byId.get("b")!.y)
    expect(byId.get("c")!.x).toBeGreaterThan(byId.get("a")!.x)
    const seen = new Set(draft.nodes.map((n) => `${n.position.x}:${n.position.y}`))
    expect(seen.size).toBe(draft.nodes.length)
  })

  it("carries the plan's name and description, and never names the plan in a node", () => {
    const draft = planWorkflowDraft(plan(linear()))
    expect(draft.name).toBe("Ship v2")
    expect(draft.description).toBe("the release")
    expect(draft.tags).toEqual(["plan"])
    // WF-24: an exported workflow runs on its own. No node may reach back into
    // the plan (no dispatch node, no planId/stepId param).
    expect(draft.nodes.some((n) => n.type === "action.plan.step.dispatch")).toBe(false)
    expect(JSON.stringify(draft.nodes)).not.toMatch(/"planId"|"stepId"/)
  })

  it("exports each step as the ordinary node that does the same work", () => {
    const draft = planWorkflowDraft(
      plan(
        [
          step({
            id: "turn",
            title: "Draft notes",
            order: 0,
            params: { kind: "agent_turn", prompt: "Write the release notes" },
          }),
          step({
            id: "gate",
            title: "Ship it?",
            kind: "approval_gate",
            order: 1,
            dependencies: ["turn"],
            params: { kind: "approval_gate", prompt: "Notes look right?" },
          }),
          step({
            id: "sub",
            title: "Publish",
            kind: "sub_workflow",
            order: 2,
            dependencies: ["gate"],
            params: {
              kind: "sub_workflow",
              workflowId: "wf_publish",
              triggerPayload: { input: { channel: "#releases" } },
            },
          }),
          step({
            id: "tool",
            title: "Search",
            kind: "tool_call",
            order: 3,
            params: { kind: "tool_call", toolName: "search_docs", input: { q: "v2" } },
          }),
          step({
            id: "mcp",
            title: "File issue",
            kind: "mcp_tool_call",
            order: 4,
            params: { kind: "mcp_tool_call", serverId: "github", toolName: "create_issue" },
          }),
        ],
        { characterId: "char_1" }
      ),
      { pluginToolOwners: new Map([["search_docs", "docs"]]) }
    )
    const byId = new Map(draft.nodes.map((n) => [n.id, n]))
    expect(byId.get("turn")).toMatchObject({
      type: "action.agent.turn",
      data: {
        label: "Draft notes",
        params: { prompt: "Write the release notes", toolsEnabled: true, characterId: "char_1" },
      },
    })
    expect(byId.get("gate")).toMatchObject({
      type: "action.approval.request",
      data: { params: { title: "Ship it?", message: "Notes look right?" } },
    })
    expect(byId.get("sub")).toMatchObject({
      type: "flow.subworkflow",
      data: { params: { workflowId: "wf_publish", input: { channel: "#releases" } } },
    })
    expect(byId.get("tool")).toMatchObject({
      type: "action.plugin.invoke",
      data: {
        params: { pluginId: "docs", mode: "tool", toolName: "search_docs", args: { q: "v2" } },
      },
    })
    expect(byId.get("mcp")).toMatchObject({
      type: "action.mcp.invokeTool",
      data: { params: { serverId: "github", toolName: "create_issue", args: {} } },
    })
    // A rejection stops the dependents, as it stops the plan: they follow the
    // approval's `approved` handle only.
    expect(draft.edges).toContainEqual(
      expect.objectContaining({ source: "gate", sourceHandle: "approved", target: "sub" })
    )

    // The draft is a valid workflow whose every node passes its own params
    // schema — the editor would otherwise open it full of errors.
    const workflow = {
      ...draft,
      id: "wf_exported",
      schemaVersion: 2,
      createdAt: 0,
      updatedAt: 0,
    } as unknown as VisualWorkflow
    expect(validateWorkflow(workflow)).toMatchObject({ ok: true })
    for (const n of draft.nodes) {
      expect([
        n.type,
        validateNodeParams(n.type as WorkflowNodeKind, n.data.params).summary,
      ]).toEqual([n.type, []])
    }
  })

  it("exports an editor review as a diff that cannot skip the approval", () => {
    const draft = planWorkflowDraft(
      plan([
        step({
          id: "review",
          title: "Review the config",
          kind: "editor_review",
          params: {
            kind: "editor_review",
            path: "app.json",
            content: '{"v":2}',
            prompt: "Bump the version?",
          },
        }),
        step({ id: "after", order: 1, dependencies: ["review"] }),
      ])
    )
    const byId = new Map(draft.nodes.map((n) => [n.id, n]))
    const diff = byId.get("review__diff")!
    expect(diff.type).toBe("action.editor.showDiff")
    expect(diff.data.errorHandling).toEqual({ onError: "continue" })
    const approval = byId.get("review")!
    expect(approval.type).toBe("action.approval.request")
    // The proposal rides the question as text, so a missing Pro IDE never
    // turns the review into a rubber stamp.
    expect(approval.data.params).toMatchObject({ title: "Review the config" })
    expect(String((approval.data.params as { message?: string }).message)).toContain('{"v":2}')
    const triggerId = draft.nodes[0].id
    expect(draft.edges).toContainEqual(
      expect.objectContaining({ source: triggerId, target: "review__diff" })
    )
    expect(draft.edges).toContainEqual(
      expect.objectContaining({ source: "review__diff", target: "review" })
    )
    expect(draft.edges).toContainEqual(
      expect.objectContaining({ source: "review", sourceHandle: "approved", target: "after" })
    )
  })

  it("refuses a teammate step, naming it, because no node runs one teammate turn alone", () => {
    const teammate = step({
      id: "tm",
      title: "Ask the reviewer",
      kind: "teammate_dispatch",
      params: { kind: "teammate_dispatch", teammateId: "tm_1" },
    })
    let caught: unknown
    try {
      planWorkflowDraft(plan([teammate]))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PlanExportError)
    expect(caught).toMatchObject({
      reason: "teammate-step",
      step: { id: "tm", title: "Ask the reviewer", kind: "teammate_dispatch" },
      stepId: "tm",
      stepKind: "teammate_dispatch",
    })
  })

  it("refuses a tool call whose tool no plugin registers, carrying the tool name", () => {
    const tool = step({
      id: "t",
      title: "Search",
      kind: "tool_call",
      params: { kind: "tool_call", toolName: "search_docs", input: {} },
    })
    expect(() => planWorkflowDraft(plan([tool]))).toThrow(
      expect.objectContaining({ reason: "tool-owner-unknown", toolName: "search_docs" })
    )
  })

  it.each([
    ["sub_workflow", { kind: "sub_workflow", workflowId: "" }],
    ["mcp_tool_call", { kind: "mcp_tool_call", serverId: "", toolName: "x" }],
    ["editor_review", undefined],
  ] as const)("refuses an incomplete %s step", (kind, params) => {
    const incomplete = step({
      id: "x",
      title: "Incomplete",
      kind,
      ...(params ? { params: params as PlanStep["params"] } : {}),
    })
    expect(() => planWorkflowDraft(plan([incomplete]))).toThrow(
      expect.objectContaining({ reason: "step-incomplete", stepId: "x" })
    )
  })

  it("refuses a cyclic or empty plan exactly like the run path", () => {
    expect(() => planWorkflowDraft(plan([]))).toThrow(PlanSynthesizeError)
    expect(() =>
      planWorkflowDraft(
        plan([
          step({ id: "a", order: 0, dependencies: ["b"] }),
          step({ id: "b", order: 1, dependencies: ["a"] }),
        ])
      )
    ).toThrow(PlanSynthesizeError)
  })
})

describe("planInputFromWorkflow", () => {
  const wf = { id: "wf_1", name: "Nightly report", description: "sends the digest" }

  it("wraps the workflow in a single orchestrated sub_workflow step", () => {
    const input = planInputFromWorkflow(wf, { sessionId: "ses" })
    expect(input.executionMode).toBe("orchestrated")
    expect(input.metadata).toEqual({ workflowId: "wf_1" })
    expect(input.steps).toHaveLength(1)
    expect(input.steps[0]).toMatchObject({
      kind: "sub_workflow",
      params: { kind: "sub_workflow", workflowId: "wf_1" },
    })
  })

  it("prepends an approval gate the run step depends on", () => {
    const input = planInputFromWorkflow(wf, { sessionId: "ses", withApprovalGate: true })
    expect(input.steps.map((s) => s.kind)).toEqual(["approval_gate", "sub_workflow"])
    expect(input.steps[1].dependsOn).toEqual([0])
  })

  it("keeps the character when the session has one", () => {
    expect(planInputFromWorkflow(wf, { sessionId: "s", characterId: "c1" }).characterId).toBe("c1")
    expect(planInputFromWorkflow(wf, { sessionId: "s" }).characterId).toBeUndefined()
  })
})
