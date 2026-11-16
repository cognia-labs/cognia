import { workflowRefactorerAgent } from "./workflow-refactorer"

const PREFIX = "mcp__cognia-plugin-tools__"

describe("workflowRefactorerAgent", () => {
  const tools = (workflowRefactorerAgent.tools ?? []).map((t) => t.slice(PREFIX.length))

  it("offers only workflow plugin tools", () => {
    expect(workflowRefactorerAgent.tools?.length).toBeGreaterThan(0)
    expect(workflowRefactorerAgent.tools?.every((t) => t.startsWith(`${PREFIX}wf_`))).toBe(true)
    expect(new Set(tools).size).toBe(tools.length)
  })

  it("edits an existing graph in place", () => {
    expect(tools).toEqual(
      expect.arrayContaining(["wf_read_graph", "wf_batch_apply", "wf_configure_node"])
    )
    expect(tools).not.toContain("wf_apply_template")
  })

  it("carries a description for delegation and a system prompt", () => {
    expect(workflowRefactorerAgent.description.trim().length).toBeGreaterThan(20)
    expect(workflowRefactorerAgent.prompt).toMatch(/workflow/i)
  })
})
