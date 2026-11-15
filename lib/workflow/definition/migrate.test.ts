import { migrateWorkflow } from "./migrate"
import { registerWorkflowKindAliases, __resetWorkflowKindAliasesForTesting } from "./kind-aliases"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

function workflow(): VisualWorkflow {
  return {
    id: "wf_x",
    schemaVersion: 2,
    name: "current",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n1",
        type: "flow.loop",
        typeVersion: 2,
        position: { x: 0, y: 0 },
        data: { label: "Loop", params: { mode: "times", times: 2 } },
      },
    ],
    edges: [],
    settings: DEFAULT_WORKFLOW_SETTINGS,
  }
}

afterEach(() => __resetWorkflowKindAliasesForTesting())

describe("migrateWorkflow", () => {
  it("returns a workflow with no aliased kinds by reference", () => {
    const wf = workflow()
    expect(migrateWorkflow(wf)).toBe(wf)
  })

  it("never rewrites schemaVersion or typeVersion", () => {
    const out = migrateWorkflow(workflow())
    expect(out.schemaVersion).toBe(2)
    expect(out.nodes[0].typeVersion).toBe(2)
  })

  it("resolves plugin-declared kind aliases", () => {
    registerWorkflowKindAliases("acme", { "acme.old": "acme.action.new" })
    const wf = workflow()
    wf.nodes[0] = { ...wf.nodes[0], type: "acme.old" as VisualWorkflow["nodes"][number]["type"] }
    const out = migrateWorkflow(wf)
    expect(out).not.toBe(wf)
    expect(out.nodes[0].type).toBe("acme.action.new")
  })

  it("preserves unknown / additive fields", () => {
    const wf = { ...workflow(), variables: { API_KEY: "x" }, staticData: { acc: 1 } }
    const out = migrateWorkflow(wf)
    expect(out.variables).toEqual({ API_KEY: "x" })
    expect(out.staticData).toEqual({ acc: 1 })
  })
})
