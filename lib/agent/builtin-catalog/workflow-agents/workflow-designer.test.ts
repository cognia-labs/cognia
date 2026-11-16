import { workflowDesignerAgent } from "./workflow-designer"

const PREFIX = "mcp__cognia-plugin-tools__"

describe("workflowDesignerAgent", () => {
  const tools = (workflowDesignerAgent.tools ?? []).map((t) => t.slice(PREFIX.length))

  it("offers only workflow plugin tools", () => {
    expect(workflowDesignerAgent.tools?.length).toBeGreaterThan(0)
    expect(workflowDesignerAgent.tools?.every((t) => t.startsWith(`${PREFIX}wf_`))).toBe(true)
    expect(new Set(tools).size).toBe(tools.length)
  })

  it("reads the live node catalog and can build a graph", () => {
    expect(tools).toEqual(
      expect.arrayContaining([
        "wf_list_node_kinds",
        "wf_describe_node_kind",
        "wf_add_node",
        "wf_connect_edge",
      ])
    )
  })

  it("carries a description for delegation and a system prompt", () => {
    expect(workflowDesignerAgent.description.trim().length).toBeGreaterThan(20)
    expect(workflowDesignerAgent.prompt).toMatch(/workflow/i)
  })
})
