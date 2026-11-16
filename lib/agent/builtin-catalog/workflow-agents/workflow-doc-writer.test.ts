import { workflowDocWriterAgent } from "./workflow-doc-writer"

const PREFIX = "mcp__cognia-plugin-tools__"

describe("workflowDocWriterAgent", () => {
  const tools = (workflowDocWriterAgent.tools ?? []).map((t) => t.slice(PREFIX.length))

  it("offers only workflow plugin tools", () => {
    expect(workflowDocWriterAgent.tools?.length).toBeGreaterThan(0)
    expect(workflowDocWriterAgent.tools?.every((t) => t.startsWith(`${PREFIX}wf_`))).toBe(true)
    expect(new Set(tools).size).toBe(tools.length)
  })

  it("reads nodes and adds annotation nodes only", () => {
    expect(tools).toEqual([
      "wf_read_graph",
      "wf_read_node",
      "wf_add_node",
      "wf_configure_node",
      "wf_focus_viewport",
    ])
    expect(tools).not.toContain("wf_remove_node")
  })

  it("carries a description for delegation and a system prompt", () => {
    expect(workflowDocWriterAgent.description.trim().length).toBeGreaterThan(20)
    expect(workflowDocWriterAgent.prompt).toMatch(/workflow/i)
  })
})
