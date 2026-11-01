jest.mock("@/lib/plugin/api/extension-api", () => ({ getPluginExtensions: jest.fn(() => []) }))
import { getPluginExtensions } from "@/lib/plugin/api/extension-api"
import { pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
jest.mock("@/lib/db/mcp-servers", () => ({
  getMcpServer: jest.fn(async () => ({ id: "s", name: "service", transport: "stdio" })),
}))
jest.mock("@/lib/mcp/invoke", () => ({
  invokeMcpTool: jest.fn(async () => ({ content: [], isError: false })),
}))
jest.mock("@/lib/db/plugins", () => ({
  getPlugin: jest.fn(async () => ({
    id: "integration",
    enabled: true,
    manifest: { permissions: [] },
  })),
}))
jest.mock("@/lib/workflow/runtime/plugin-dependency-lock", () => ({
  assertWorkflowPluginDependencyLock: jest.fn(),
}))
jest.mock("@/lib/plugin/core/invoke-plugin-tool", () => ({
  invokePluginTool: jest.fn(async () => ({ result: "ok" })),
}))
jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: () => ({
    dispatchMCPServerConnect: jest.fn(),
    dispatchMCPToolCall: jest.fn(),
    dispatchMCPToolResult: jest.fn(),
    dispatchMCPServerDisconnect: jest.fn(),
  }),
}))
import "."
import { getExecutor } from "../registry"

describe("integration-nodes registration", () => {
  it.each([
    ["action.mcp.invokeTool", 1],
    ["action.memory.recall", 1],
    ["action.memory.store", 1],
    ["action.plugin.invoke", 1],
    ["action.skill.invoke", 1],
    ["action.skill.upsert", 1],
    ["action.twin.ingest", 1],
    ["action.twin.rag", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})

it("anchors host MCP credentials to the exact workflow execution run", async () => {
  const { invokeMcpTool } = await import("@/lib/mcp/invoke")
  await getExecutor("action.mcp.invokeTool", 1)!.execute({
    runId: "wf",
    params: { serverId: "s", toolName: "read" },
    signal: new AbortController().signal,
  } as never)
  expect(invokeMcpTool).toHaveBeenCalledWith(
    expect.objectContaining({ credentialContext: { executionRunId: "execution:workflow:wf" } }),
    expect.anything()
  )
})

it("carries the workflow run through generic plugin-tool invocation", async () => {
  const { invokePluginTool } = await import("@/lib/plugin/core/invoke-plugin-tool")
  await getExecutor("action.plugin.invoke", 1)!.execute({
    runId: "wf",
    params: { pluginId: "integration", toolName: "readIssue", args: {} },
    signal: new AbortController().signal,
  } as never)
  expect(invokePluginTool).toHaveBeenCalledWith(
    "integration",
    "readIssue",
    {},
    expect.objectContaining({ executionRunId: "execution:workflow:wf" })
  )
})

it("binds workflow.task callbacks to the exact Host workflow execution", async () => {
  const handler = jest.fn(async () => {
    await Promise.resolve()
    expect(pluginExecutionContext("integration")?.executionRunId).toBe("execution:workflow:wf")
    return "bound"
  })
  jest
    .mocked(getPluginExtensions)
    .mockReturnValue([{ point: "workflow.task", registration: { task: "read", handler } }] as never)
  await expect(
    getExecutor("action.plugin.invoke", 1)!.execute({
      runId: "wf",
      params: {
        pluginId: "integration",
        taskId: "read",
        mode: "task",
        args: { executionRunId: "forged" },
      },
      signal: new AbortController().signal,
    } as never)
  ).resolves.toMatchObject({ output: { data: "bound" } })
  expect(pluginExecutionContext("integration")).toBeUndefined()
})
