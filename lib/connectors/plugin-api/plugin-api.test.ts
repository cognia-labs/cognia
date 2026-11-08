import type { ModuleBridgeContext } from "@/lib/plugin/contracts/module-bridge-map"
import type { ModulePluginApiHost } from "@/types/plugin/module-plugin-api"

const createConnectorsAPI = jest.fn((pluginId: string) => ({ pluginId }))
const registerPluginAdapters = jest.fn(async () => undefined)
const unregisterPluginAdapters = jest.fn()
const getPluginConnectorKinds = jest.fn((pluginId: string) => [`${pluginId}-kind`])

jest.mock("./connectors-api", () => ({
  createConnectorsAPI: (pluginId: string) => createConnectorsAPI(pluginId),
}))
jest.mock("./adapters-bridge", () => ({
  registerPluginAdapters: (...args: unknown[]) => registerPluginAdapters(...(args as [])),
  unregisterPluginAdapters: (pluginId: string) => unregisterPluginAdapters(pluginId),
  getPluginConnectorKinds: (pluginId: string) => getPluginConnectorKinds(pluginId),
}))

import { pluginApi } from "./plugin-api"

describe("connectors plugin API", () => {
  it("builds ctx.connectors for the plugin", () => {
    const api = pluginApi.namespaces?.connectors?.("p1", {} as ModulePluginApiHost)
    expect(createConnectorsAPI).toHaveBeenCalledWith("p1")
    expect(api).toEqual({ pluginId: "p1" })
  })

  it("registers and drops a plugin's adapters through the connectors bridge", async () => {
    const ctx = {
      pluginId: "p1",
      manifest: { id: "p1" },
      moduleExports: { makeAdapter: () => null },
    } as unknown as ModuleBridgeContext
    await pluginApi.bridges?.connectors.register(ctx)
    expect(registerPluginAdapters).toHaveBeenCalledWith("p1", ctx.manifest, ctx.moduleExports)
    await pluginApi.bridges?.connectors.unregister("p1")
    expect(unregisterPluginAdapters).toHaveBeenCalledWith("p1")
    expect(pluginApi.bridges?.connectors.listContributions?.("p1")).toEqual(["p1-kind"])
  })
})
