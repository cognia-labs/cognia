import type { ModulePluginApiHost } from "@/types/plugin/module-plugin-api"

const created: Array<{ config: Record<string, unknown>; bridge: Record<string, jest.Mock> }> = []

jest.mock("./plugin-bridge", () => ({
  createPluginA2UIBridge: (config: Record<string, unknown>) => {
    const bridge = {
      registerComponent: jest.fn(),
      registerTemplate: jest.fn(),
      unregisterPluginComponents: jest.fn(),
      unregisterPluginTemplates: jest.fn(),
    }
    created.push({ config, bridge })
    return bridge
  },
}))
jest.mock("@/stores/a2ui", () => ({ useA2UIStore: { getState: () => ({}) } }))

import { pluginApi } from "./plugin-api"

function host(): ModulePluginApiHost {
  return {
    registry: {} as ModulePluginApiHost["registry"],
    hooksManager: {} as ModulePluginApiHost["hooksManager"],
    contextOf: jest.fn(() => undefined),
  }
}

beforeEach(() => {
  created.length = 0
})

describe("a2ui plugin API", () => {
  it("creates the bridge on the first registration, one per manager", () => {
    const first = host()
    const second = host()
    const a = pluginApi.namespaces!.a2ui!("p1", first)
    const b = pluginApi.namespaces!.a2ui!("p2", first)
    expect(created).toHaveLength(0)
    a.registerComponent({ type: "chart" } as never)
    b.registerTemplate({ id: "t1" } as never)
    expect(created).toHaveLength(1)
    expect(created[0].config).toMatchObject({
      registry: first.registry,
      hooksManager: first.hooksManager,
    })
    expect(created[0].bridge.registerComponent).toHaveBeenCalledWith("p1", { type: "chart" })
    expect(created[0].bridge.registerTemplate).toHaveBeenCalledWith("p2", { id: "t1" })
    pluginApi.namespaces!.a2ui!("p3", second).registerComponent({ type: "map" } as never)
    expect(created).toHaveLength(2)
    const resolve = created[0].config.contextResolver as (pluginId: string) => unknown
    resolve("p1")
    expect(first.contextOf).toHaveBeenCalledWith("p1")
  })

  it("drops a plugin's components and templates on unload, and nothing before a bridge exists", async () => {
    const managerHost = host()
    await pluginApi.unload!("p1", managerHost)
    expect(created).toHaveLength(0)
    pluginApi.namespaces!.a2ui!("p1", managerHost).registerComponent({ type: "chart" } as never)
    await pluginApi.unload!("p1", managerHost)
    expect(created[0].bridge.unregisterPluginComponents).toHaveBeenCalledWith("p1")
    expect(created[0].bridge.unregisterPluginTemplates).toHaveBeenCalledWith("p1")
  })
})
