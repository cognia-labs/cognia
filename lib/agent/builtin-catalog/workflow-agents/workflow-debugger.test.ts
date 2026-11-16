import { workflowDebuggerAgent } from "./workflow-debugger"

const PREFIX = "mcp__cognia-plugin-tools__"

describe("workflowDebuggerAgent", () => {
  const tools = (workflowDebuggerAgent.tools ?? []).map((t) => t.slice(PREFIX.length))

  it("offers only workflow plugin tools", () => {
    expect(workflowDebuggerAgent.tools?.length).toBeGreaterThan(0)
    expect(workflowDebuggerAgent.tools?.every((t) => t.startsWith(`${PREFIX}wf_`))).toBe(true)
    expect(new Set(tools).size).toBe(tools.length)
  })

  it("reads the graph and run history without editing it", () => {
    expect(tools.every((t) => /^wf_(read|get)_/.test(t))).toBe(true)
    expect(tools).toEqual(expect.arrayContaining(["wf_get_validation_errors", "wf_get_last_run"]))
  })

  it("carries a description for delegation and a system prompt", () => {
    expect(workflowDebuggerAgent.description.trim().length).toBeGreaterThan(20)
    expect(workflowDebuggerAgent.prompt).toMatch(/workflow/i)
  })
})
