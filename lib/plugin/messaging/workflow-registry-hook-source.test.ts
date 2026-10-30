import { installWorkflowRegistryHookSource } from "./workflow-registry-hook-source"
import { getPluginEventHooks } from "./hooks-system"
import {
  registerNodeExecutor,
  unregisterNodeExecutor,
  __resetRegistryForTesting,
} from "@/lib/workflow/nodes/registry"
import {
  registerPluginTrigger,
  unregisterPluginTrigger,
  __resetTriggerRegistryForTesting,
} from "@/lib/workflow/triggers/registry"

jest.mock("./hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchWorkflowNodeRegister: jest.fn(),
    dispatchWorkflowNodeUnregister: jest.fn(),
    dispatchWorkflowTriggerRegister: jest.fn(),
    dispatchWorkflowTriggerUnregister: jest.fn(),
  }),
}))

it("delivers real registry changes with ownership and stops after cleanup", async () => {
  __resetRegistryForTesting()
  __resetTriggerRegistryForTesting()
  const dispatch = getPluginEventHooks()
  jest.spyOn(jest.requireMock("./hooks-system"), "getPluginEventHooks").mockReturnValue(dispatch)
  const stop = installWorkflowRegistryHookSource()
  registerNodeExecutor({
    kind: "ai.prompt",
    typeVersion: 1,
    pluginId: "node-owner",
    execute: async () => ({ output: {} }),
  })
  await Promise.resolve()
  unregisterNodeExecutor("ai.prompt", 1)
  await Promise.resolve()
  expect(dispatch.dispatchWorkflowNodeRegister).toHaveBeenCalledWith({
    kind: "ai.prompt",
    typeVersion: 1,
    pluginId: "node-owner",
  })
  expect(dispatch.dispatchWorkflowNodeUnregister).toHaveBeenCalledWith({
    kind: "ai.prompt",
    typeVersion: 1,
    pluginId: "node-owner",
  })
  registerPluginTrigger({
    kind: "trigger.owner.event",
    typeVersion: 1,
    pluginId: "owner",
    instances: new Map(),
    def: {
      kind: "trigger.event",
      label: "Event",
      description: "Event source",
      iconName: "Zap",
      paramsSchema: {},
      typeVersion: 1,
      start: async () => ({ stop: async () => {} }),
    },
  })
  await Promise.resolve()
  await unregisterPluginTrigger("trigger.owner.event", 1)
  await Promise.resolve()
  expect(dispatch.dispatchWorkflowTriggerRegister).toHaveBeenCalledWith({
    kind: "trigger.owner.event",
    typeVersion: 1,
    pluginId: "owner",
  })
  expect(dispatch.dispatchWorkflowTriggerUnregister).toHaveBeenCalledWith({
    kind: "trigger.owner.event",
    typeVersion: 1,
    pluginId: "owner",
  })
  stop()
  registerNodeExecutor({ kind: "ai.prompt", typeVersion: 2, execute: async () => ({ output: {} }) })
  await Promise.resolve()
  expect(dispatch.dispatchWorkflowNodeRegister).toHaveBeenCalledTimes(1)
  __resetRegistryForTesting()
  __resetTriggerRegistryForTesting()
})
