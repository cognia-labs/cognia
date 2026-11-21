import type { VisualWorkflow } from "@/types/workflow/visual"
import {
  createWorkflowVersion,
  deriveWorkflowDependencyManifest,
  workflowCallTargetOf,
  workflowVersionDigest,
} from "./version-snapshot"

function workflow(): VisualWorkflow {
  return {
    id: "wf_demo",
    schemaVersion: 2,
    name: "Demo",
    createdAt: 1,
    updatedAt: 2,
    nodes: [
      {
        id: "sub",
        type: "flow.subworkflow",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "sub", params: { workflowId: "wf_child" } },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      maxConcurrency: 4,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
    credentials: { llm: { id: "cred_1", name: "LLM", kind: "api-key" } },
    variables: { REGION: "us-east" },
    pinData: { sub: { ignored: true } },
    published: { at: 2, toolName: "wf_demo" },
  }
}

describe("workflow version snapshot", () => {
  it("derives deterministic dependencies without retaining editor pin data", () => {
    const definition = workflow()
    const version = createWorkflowVersion({
      workflow: definition,
      workflowInterface: { inputSchema: { type: "object" } },
      accountId: "acct_1",
      sequence: 3,
      createdAt: 10,
    })

    expect(version.id).toBe("wfv_wf_demo_3")
    expect(version.definition).not.toBe(definition)
    expect(version.definition.pinData).toBeUndefined()
    expect(version.definition.published).toBeUndefined()
    expect(version.dependencyManifest).toEqual({
      nodeTypes: [{ kind: "flow.subworkflow", typeVersion: 1 }],
      workflows: [{ workflowId: "wf_child", nodeId: "sub" }],
      credentials: [{ key: "llm", refId: "cred_1", kind: "api-key" }],
    })
    expect(version.configDefinition).toEqual({
      constants: { REGION: "us-east" },
      secretRefs: [{ key: "llm", refId: "cred_1", kind: "api-key" }],
    })
  })

  it("is key-order independent and changes when executable content changes", () => {
    expect(workflowVersionDigest({ b: 2, a: 1 })).toBe(workflowVersionDigest({ a: 1, b: 2 }))
    expect(workflowVersionDigest({ a: 1 })).not.toBe(workflowVersionDigest({ a: 2 }))
  })

  it("extracts nested ensemble subworkflow dependencies", () => {
    const definition = workflow()
    definition.nodes[0] = {
      ...definition.nodes[0],
      type: "ai.ensemble",
      data: {
        label: "ensemble",
        params: { target: { kind: "subworkflow", workflowId: "wf_ensemble_child" } },
      },
    }
    expect(deriveWorkflowDependencyManifest(definition).workflows).toEqual([
      { workflowId: "wf_ensemble_child", nodeId: "sub" },
    ])
  })

  it("records only workflows a node calls, never the ones it merely names", () => {
    const definition = workflow()
    const at = (id: string, type: string, params: Record<string, unknown>, disabled = false) =>
      ({
        id,
        type,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: id, params, ...(disabled ? { disabled } : {}) },
      }) as VisualWorkflow["nodes"][number]
    definition.nodes = [
      ...definition.nodes,
      // The workflow whose completions this subscribes to is an event source.
      at("on_done", "trigger.workflow.completed", { workflowId: "wf_source" }),
      // An evaluation target is what gets measured, not a locked call.
      at("eval", "eval.run", { targetKind: "workflow", workflowId: "wf_evaluated" }),
      // An ensemble of agent turns calls no workflow, whatever it names.
      at("agents", "ai.ensemble", { target: { kind: "agent.turn", workflowId: "wf_unused" } }),
      // A disabled call never runs.
      at("off", "flow.subworkflow", { workflowId: "wf_disabled" }, true),
    ]
    expect(workflowCallTargetOf(definition.nodes[1])).toBeUndefined()
    expect(deriveWorkflowDependencyManifest(definition).workflows).toEqual([
      { workflowId: "wf_child", nodeId: "sub" },
    ])
  })
})
