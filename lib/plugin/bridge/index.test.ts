import * as bridge from "./index"

describe("lib/plugin/bridge re-exports", () => {
  test("exposes the documented public surface", () => {
    const expected = [
      "PluginToolsBridge",
      "PluginWorkflowIntegration",
      "getPluginWorkflowIntegration",
      "resetPluginWorkflowIntegration",
      "usePluginWorkflowIntegration",
    ] as const

    for (const name of expected) {
      expect(bridge).toHaveProperty(name)
      expect((bridge as Record<string, unknown>)[name]).toBeDefined()
    }
    // The A2UI bridge belongs to the a2ui module (`lib/a2ui/plugin-api/`).
    expect(bridge).not.toHaveProperty("PluginA2UIBridge")
  })
})
