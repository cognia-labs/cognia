import type {
  PluginToolExecRequest,
  PluginToolExecResponse,
  PluginToolResolver,
} from "./agent-tool-types"

describe("plugin-tool exec wire types", () => {
  it("pins the request and response discriminators the sidecar bridge matches on", () => {
    const request: PluginToolExecRequest = {
      type: "plugin_tool_exec",
      sessionId: "s",
      toolUseId: "t",
      name: "tool",
      args: {},
    }
    const response: PluginToolExecResponse = {
      type: "plugin_tool_response",
      sessionId: request.sessionId,
      toolUseId: request.toolUseId,
      result: { ok: true },
    }
    expect(request.type).toBe("plugin_tool_exec")
    expect(response.type).toBe("plugin_tool_response")
  })

  it("lets a resolver report an unknown tool and omit plugin config", async () => {
    const execute = jest.fn(async () => "done")
    const resolver: PluginToolResolver = {
      getTool: (name) => (name === "known" ? { pluginId: "p", execute } : undefined),
    }
    expect(resolver.getTool("missing")).toBeUndefined()
    expect(resolver.getPluginConfig).toBeUndefined()
    await expect(resolver.getTool("known")?.execute({}, {} as never)).resolves.toBe("done")
  })
})
