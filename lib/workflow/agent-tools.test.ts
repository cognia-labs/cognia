import type { ToolSurfaceContext } from "@/lib/modules/manifest-types"
import {
  buildWorkflowRunnerToolEntry,
  toolFamily,
  WORKFLOW_RUNNER_TOOL_NAME,
  workflowRunnerOffered,
} from "./agent-tools"

const mockExecuteRunWorkflowTyped = jest.fn()
jest.mock("./publish/run-workflow-typed-tool", () => ({
  executeRunWorkflowTyped: (args: Record<string, unknown>) => mockExecuteRunWorkflowTyped(args),
}))

function ctx(partial: Partial<ToolSurfaceContext> = {}): ToolSurfaceContext {
  return { host: "desktop", ...partial } as ToolSurfaceContext
}

const ultracode = { id: "s1", thinkingLevel: "ultracode", effort: "xhigh" }

describe("workflowRunnerOffered", () => {
  it("offers the runner to a run with a graph-bodied skill", () => {
    expect(workflowRunnerOffered(ctx({ skills: [{ id: "sk", kind: "workflow" }] }))).toBe(true)
  })

  it("offers the runner at the ultracode tier", () => {
    expect(workflowRunnerOffered(ctx({ session: ultracode } as never))).toBe(true)
  })

  it("keeps the runner off a plain run", () => {
    expect(workflowRunnerOffered(ctx({ skills: [{ id: "sk", kind: "markdown" }] } as never))).toBe(
      false
    )
    expect(
      workflowRunnerOffered(
        ctx({ session: { id: "s1", thinkingLevel: "xhigh", effort: "xhigh" } } as never)
      )
    ).toBe(false)
  })

  it("keeps the runner off an agent with plugin tools switched off", () => {
    expect(
      workflowRunnerOffered(
        ctx({
          agent: { disablePluginTools: true },
          skills: [{ id: "sk", kind: "workflow" }],
          session: ultracode,
        } as never)
      )
    ).toBe(false)
  })
})

describe("toolFamily", () => {
  afterEach(() => mockExecuteRunWorkflowTyped.mockReset())

  it("surfaces the runner with the plugin contract's schema", async () => {
    const surface = await toolFamily.surface(ctx({ skills: [{ id: "sk", kind: "workflow" }] }))
    expect(surface).toEqual({ tools: [buildWorkflowRunnerToolEntry()] })
    expect(surface?.tools[0]?.name).toBe(WORKFLOW_RUNNER_TOOL_NAME)
    expect(surface?.tools[0]?.jsonSchema).toEqual(expect.objectContaining({ type: "object" }))
  })

  it("surfaces nothing when the runner is not offered", async () => {
    expect(await toolFamily.surface(ctx())).toBeNull()
  })

  it("runs the runner through the shared core", async () => {
    mockExecuteRunWorkflowTyped.mockResolvedValue({ ok: true, runId: "r1" })
    const result = await toolFamily.run(WORKFLOW_RUNNER_TOOL_NAME, { name: "X", input: { a: 1 } }, {
      sessionId: "s1",
    } as never)
    expect(mockExecuteRunWorkflowTyped).toHaveBeenCalledWith({ name: "X", input: { a: 1 } })
    expect(result).toEqual({ ok: true, runId: "r1" })
  })

  it("refuses a name it does not declare", async () => {
    const result = await toolFamily.run("wf_read_graph", {}, { sessionId: "s1" } as never)
    expect(result).toEqual({
      ok: false,
      error: { code: "unknown-tool", message: "unknown workflow tool: wf_read_graph" },
    })
    expect(mockExecuteRunWorkflowTyped).not.toHaveBeenCalled()
  })
})
