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
jest.mock("@/lib/db/skills", () => ({
  ...jest.requireActual("@/lib/db/skills"),
  listSkillsByIds: jest.fn(async () => []),
  recordSkillUsage: jest.fn(async () => undefined),
}))
import "."
import { listSkillsByIds } from "@/lib/db/skills"
import { __resetSkillsForTesting, registerSkill } from "@/lib/plugin/registries/skill-registry"
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

describe("action.skill.invoke", () => {
  const invoke = (skillIds: string) =>
    getExecutor("action.skill.invoke", 1)!.execute({
      runId: "wf",
      params: { skillIds },
      signal: new AbortController().signal,
    } as never)

  beforeEach(() => {
    __resetSkillsForTesting()
    jest.mocked(listSkillsByIds).mockClear().mockResolvedValue([])
  })

  it("injects a stored skill's body", async () => {
    jest
      .mocked(listSkillsByIds)
      .mockResolvedValue([
        { id: "review", name: "Review", content: "Refute every finding." },
      ] as never)

    await expect(invoke("review")).resolves.toEqual({
      output: {
        skills: [{ id: "review", name: "Review" }],
        markdown: "### Review\n\nRefute every finding.",
      },
    })
  })

  it("injects a plugin skill's body with its plugin root bound", async () => {
    registerSkill(
      "plugin.lint",
      {
        id: "plugin.lint",
        name: "Lint",
        description: "",
        source: { kind: "inline", markdown: "Run ${COGNIA_PLUGIN_ROOT}/lint.sh" },
        runtimePluginRoot: "/plugins/lint",
      } as never,
      { pluginId: "lint" }
    )

    const result = await invoke("plugin.lint")
    expect(result.output).toMatchObject({ markdown: "### Lint\n\nRun /plugins/lint/lint.sh" })
  })

  it("keeps the stored and plugin skills in one body and skips unknown ids", async () => {
    jest
      .mocked(listSkillsByIds)
      .mockResolvedValue([{ id: "a", name: "A", content: "first" }] as never)
    registerSkill(
      "b",
      {
        id: "b",
        name: "B",
        description: "",
        source: { kind: "inline", markdown: "second" },
      } as never,
      { pluginId: "p" }
    )

    const result = await invoke("a, b, missing")
    expect(result.output).toEqual({
      skills: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      markdown: "### A\n\nfirst\n\n### B\n\nsecond",
    })
  })

  it("returns an empty body when no ids are given", async () => {
    await expect(invoke(" , ")).resolves.toEqual({ output: { skills: [], markdown: "" } })
    expect(listSkillsByIds).not.toHaveBeenCalled()
  })
})
