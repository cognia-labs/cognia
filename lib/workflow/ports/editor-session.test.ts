import {
  WORKFLOW_COPILOT_ALLOWED_TOOLS,
  WORKFLOW_COPILOT_DISALLOWED_TOOLS,
} from "../editor/copilot-prompts"
import { buildWorkflowSnapshotBlock, port } from "./editor-session"

const mockGetEditorStore = jest.fn()
jest.mock("../editor/store-registry", () => ({
  getEditorStore: (workflowId: string) => mockGetEditorStore(workflowId),
}))

function editorState(overrides: Partial<Parameters<typeof buildWorkflowSnapshotBlock>[1]> = {}) {
  return {
    baseWorkflow: { id: "wf_42", name: "Digest", description: "daily digest" },
    nodes: [
      { id: "n1", data: { kind: "trigger.manual", label: "Start" } },
      { id: "n2", data: { kind: "action.ai.chat", label: "Summarize" } },
    ],
    edges: [{}],
    selectedNodeIds: ["n2"],
    runStatusByStepId: { n1: "done", n2: "running" },
    validationByStepId: { n2: {} },
    ...overrides,
  }
}

afterEach(() => mockGetEditorStore.mockReset())

describe("buildWorkflowSnapshotBlock", () => {
  it("summarizes the open graph and details the selection", () => {
    const block = buildWorkflowSnapshotBlock("wf_42", editorState())
    expect(block).toContain("- workflowId: wf_42")
    expect(block).toContain("- name: Digest")
    expect(block).toContain("- description: daily digest")
    expect(block).toContain("- nodes: 2; edges: 1")
    expect(block).toContain("- nodes failing validation: 1")
    expect(block).toContain("- nodes currently running: 1")
    expect(block).toContain("  - n2 :: action.ai.chat :: Summarize")
    expect(block).toContain("wf_propose_batch")
  })

  it("caps per-node detail at twelve selected nodes", () => {
    const nodes = Array.from({ length: 15 }, (_, i) => ({
      id: `n${i}`,
      data: { kind: "action.ai.chat", label: `Step ${i}` },
    }))
    const block = buildWorkflowSnapshotBlock(
      "wf_42",
      editorState({ nodes, selectedNodeIds: nodes.map((n) => n.id) })
    )
    expect(block).toContain("  - n11 :: action.ai.chat :: Step 11")
    expect(block).not.toContain("  - n12 ::")
    expect(block).toContain("  - …and 3 more")
  })

  it("names an untitled workflow", () => {
    const block = buildWorkflowSnapshotBlock(
      "wf_42",
      editorState({ baseWorkflow: { id: "wf_42" }, selectedNodeIds: [] })
    )
    expect(block).toContain("- name: (untitled)")
    expect(block).not.toContain("- selection:")
  })
})

describe("workflow-editor-session port", () => {
  it("prepares the Copilot with the open graph's snapshot", async () => {
    mockGetEditorStore.mockReturnValue({ getState: () => editorState() })
    const setup = await port.prepare("workflow:wf_42")
    expect(mockGetEditorStore).toHaveBeenCalledWith("wf_42")
    expect(setup.systemPrompt).toContain("Workflow Copilot")
    expect(setup.appendSystemPrompt).toContain("- workflowId: wf_42")
    expect(setup.allowedTools).toBe(WORKFLOW_COPILOT_ALLOWED_TOOLS)
    expect(setup.disallowedTools).toBe(WORKFLOW_COPILOT_DISALLOWED_TOOLS)
    expect(setup.additionalDirectories).toEqual(["lib/workflow/copilot-templates"])
  })

  it("leaves the snapshot out when no editor is open for the workflow", async () => {
    mockGetEditorStore.mockReturnValue(null)
    const setup = await port.prepare("workflow:wf_42")
    expect(setup).not.toHaveProperty("appendSystemPrompt")
    expect(setup.systemPrompt).toContain("Workflow Copilot")
  })

  it("leaves the snapshot out for a conversation that is not an editor's", async () => {
    const setup = await port.prepare("chat-1")
    expect(mockGetEditorStore).not.toHaveBeenCalled()
    expect(setup).not.toHaveProperty("appendSystemPrompt")
  })

  it("keeps the Copilot setup when the snapshot fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    mockGetEditorStore.mockImplementation(() => {
      throw new Error("store gone")
    })
    const setup = await port.prepare("workflow:wf_42")
    expect(setup).not.toHaveProperty("appendSystemPrompt")
    expect(setup.allowedTools).toBe(WORKFLOW_COPILOT_ALLOWED_TOOLS)
    expect(warn).toHaveBeenCalledWith("workflow-editor snapshot block failed:", expect.any(Error))
    warn.mockRestore()
  })
})
