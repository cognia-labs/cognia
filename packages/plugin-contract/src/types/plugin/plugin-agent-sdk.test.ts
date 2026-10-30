import type { PluginDispatchSubagentOptions } from "./plugin-agent-sdk"

it("can carry an optional host observation snapshot without changing public options", () => {
  const plain: PluginDispatchSubagentOptions = { toolsEnabled: true }
  const nested: PluginDispatchSubagentOptions = {
    ...plain,
    _actingAuthority: { runId: "parent", revision: 3 },
  }
  expect(plain).not.toHaveProperty("_actingAuthority")
  expect(nested._actingAuthority).toEqual({ runId: "parent", revision: 3 })
})
