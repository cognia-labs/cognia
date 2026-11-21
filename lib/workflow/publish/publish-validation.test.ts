import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import {
  assertWorkflowPublishable,
  collectWorkflowPublishProblems,
  isWorkflowPublishBlockedError,
  WorkflowPublishBlockedError,
} from "./publish-validation"

/** `ai.prompt` is only supported at @2; every other kind here is @1. */
function node(id: string, type: string, params: Record<string, unknown> = {}): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    typeVersion: type === "ai.prompt" ? 2 : 1,
    position: { x: 0, y: 0 },
    data: { label: id, params },
  }
}

function workflow(nodes: WorkflowNode[], extra: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "wf_gate",
    schemaVersion: 2,
    name: "Gate",
    createdAt: 1,
    updatedAt: 1,
    nodes,
    edges: nodes.slice(1).map((target, index) => ({
      id: `e${index}`,
      source: nodes[index].id,
      target: target.id,
    })),
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
    ...extra,
  }
}

describe("publish gate", () => {
  it("accepts a graph the editor reports no errors for", () => {
    const wf = workflow([node("t", "trigger.manual"), node("p", "ai.prompt", { userPrompt: "hi" })])
    expect(collectWorkflowPublishProblems(wf)).toEqual([])
    expect(() => assertWorkflowPublishable(wf)).not.toThrow()
  })

  it("refuses node parameter errors the editor's Problems panel shows", () => {
    const wf = workflow([node("t", "trigger.manual"), node("p", "ai.prompt")])
    let caught: unknown
    try {
      assertWorkflowPublishable(wf)
    } catch (error) {
      caught = error
    }
    expect(isWorkflowPublishBlockedError(caught)).toBe(true)
    const blocked = caught as WorkflowPublishBlockedError
    expect(blocked.code).toBe("workflow-publish-blocked")
    expect(blocked.workflowId).toBe("wf_gate")
    expect(blocked.problems).toEqual([
      expect.objectContaining({ code: "nodeParam", nodeId: "p", field: "userPrompt" }),
    ])
    expect(blocked.message).toContain("nodeParam at node p field userPrompt")
  })

  it("refuses an undeclared credential reference", () => {
    const prompt = node("p", "ai.prompt", { userPrompt: "hi" })
    prompt.data.credentialRefs = { apiKey: "cred_missing" }
    const problems = collectWorkflowPublishProblems(workflow([node("t", "trigger.manual"), prompt]))
    expect(problems).toContainEqual(
      expect.objectContaining({ code: "credentialMissing", nodeId: "p" })
    )
  })

  it("refuses the legacy data.code@1 executor", () => {
    const problems = collectWorkflowPublishProblems(
      workflow([node("t", "trigger.manual"), node("c", "data.code", { code: "return 1" })])
    )
    expect(problems).toContainEqual(
      expect.objectContaining({ code: "legacyCodeNode", nodeId: "c" })
    )
  })

  it("reports envelope errors alone when the schema rejects the definition", () => {
    const wf = workflow([node("t", "trigger.manual")])
    const problems = collectWorkflowPublishProblems({
      ...wf,
      edges: [{ id: "dangling", source: "t", target: "missing" }],
    })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.every((problem) => problem.code === "invalidWorkflow")).toBe(true)
  })

  it("never blocks on warnings such as an orphan node", () => {
    const wf = workflow([node("t", "trigger.manual")])
    const orphan = node("lonely", "ai.prompt", { userPrompt: "hi" })
    expect(collectWorkflowPublishProblems({ ...wf, nodes: [...wf.nodes, orphan] })).toEqual([])
  })
})
