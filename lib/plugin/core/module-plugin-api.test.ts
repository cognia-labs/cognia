import type { ModulePluginApiEntry } from "@/lib/modules/manifest-types"
import { MODULE_PLUGIN_API } from "@/lib/modules/generated/plugin-api"
import type { PluginManager } from "./manager"
import type {
  ModulePluginApiContribution,
  ModulePluginApiHost,
} from "@/types/plugin/module-plugin-api"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  __setModulePluginApisForTesting,
  buildModulePluginNamespace,
  moduleBridge,
  moduleBridgeContributions,
  modulePluginApiHostOf,
  modulePluginNamespaces,
  preloadModulePluginApis,
  unloadModulePluginApis,
} from "./module-plugin-api"

const host = {} as ModulePluginApiHost
const bridge = {
  register: jest.fn(async () => undefined),
  unregister: jest.fn(),
  listContributions: jest.fn((pluginId: string) => [`${pluginId}-bot`]),
}

function entry(
  contribution: ModulePluginApiContribution,
  overrides: Partial<ModulePluginApiEntry> = {}
): ModulePluginApiEntry {
  return {
    module: "connectors",
    stage: "stable",
    namespaces: ["connectors"],
    bridges: ["connectors"],
    load: async () => ({ pluginApi: contribution }),
    ...overrides,
  }
}

const connectorsApi = { listAdapters: () => [] }
const contribution: ModulePluginApiContribution = {
  namespaces: { connectors: (pluginId) => ({ ...connectorsApi, pluginId }) as never },
  bridges: { connectors: bridge },
}

afterEach(() => __setModulePluginApisForTesting())

describe("module plugin APIs", () => {
  it("builds a namespace only after its module loaded, loading each file once", async () => {
    const load = jest.fn(entry(contribution).load)
    __setModulePluginApisForTesting([entry(contribution, { load })])
    expect(() => buildModulePluginNamespace("connectors", "p1", host)).toThrow(
      "ctx.connectors is provided by connectors, whose plugin API is not loaded yet; await preloadModulePluginApis() before building a plugin context"
    )
    await preloadModulePluginApis()
    await preloadModulePluginApis()
    expect(load).toHaveBeenCalledTimes(1)
    expect(buildModulePluginNamespace("connectors", "p1", host)).toMatchObject({ pluginId: "p1" })
  })

  it("names a namespace no active module provides, or one a module declares but does not build", async () => {
    __setModulePluginApisForTesting([entry(contribution, { stage: "experimental" })])
    await preloadModulePluginApis()
    expect(modulePluginNamespaces()).toEqual([])
    expect(() => buildModulePluginNamespace("connectors", "p1", host)).toThrow(
      "no module provides the ctx.connectors plugin API"
    )
    __setModulePluginApisForTesting([entry({}, { namespaces: ["a2ui"], bridges: [] })])
    await preloadModulePluginApis()
    expect(() => buildModulePluginNamespace("a2ui", "p1", host)).toThrow(
      "ctx.a2ui is declared by connectors but not provided"
    )
  })

  it("retries a file that failed to load", async () => {
    const load = jest
      .fn<ReturnType<ModulePluginApiEntry["load"]>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockImplementation(entry(contribution).load)
    __setModulePluginApisForTesting([entry(contribution, { load })])
    await expect(preloadModulePluginApis()).rejects.toThrow("chunk failed")
    await expect(preloadModulePluginApis()).resolves.toBeUndefined()
  })

  it("hands out the bridge a module answers, and what a plugin contributes through it", async () => {
    __setModulePluginApisForTesting([entry(contribution)])
    expect(moduleBridgeContributions("connectors", "p1")).toEqual([])
    await expect(moduleBridge("connectors")).resolves.toBe(bridge)
    await expect(moduleBridge("fonts")).resolves.toBeUndefined()
    expect(moduleBridgeContributions("connectors", "p1")).toEqual(["p1-bot"])
    expect(moduleBridgeContributions("fonts", "p1")).toEqual([])
    __setModulePluginApisForTesting([entry({ namespaces: contribution.namespaces })])
    await expect(moduleBridge("connectors")).rejects.toThrow(
      "module bridge connectors is declared by connectors but not provided"
    )
  })

  it("asks every loaded module to drop a plugin's registrations, rethrowing the first failure", async () => {
    const first = jest.fn(() => {
      throw new Error("first")
    })
    const second = jest.fn()
    __setModulePluginApisForTesting([
      entry({ unload: first }, { module: "a2ui", namespaces: [], bridges: [] }),
      entry({ unload: second }, { namespaces: [], bridges: [] }),
    ])
    await unloadModulePluginApis("p1", host)
    expect(first).not.toHaveBeenCalled()
    await preloadModulePluginApis()
    await expect(unloadModulePluginApis("p1", host)).rejects.toThrow("first")
    expect(second).toHaveBeenCalledWith("p1", host)
  })

  it("gives one host per manager, reading the manager on first use", () => {
    const registry = {}
    const manager = {
      getRegistry: jest.fn(() => registry),
      getHooksManager: jest.fn(() => ({})),
      getPluginContext: jest.fn(() => undefined),
    } as unknown as PluginManager
    const managerHost = modulePluginApiHostOf(manager)
    expect(modulePluginApiHostOf(manager)).toBe(managerHost)
    expect(manager.getRegistry).not.toHaveBeenCalled()
    expect(managerHost.registry).toBe(registry)
    expect(managerHost.contextOf("p1")).toBeUndefined()
    expect(manager.getPluginContext).toHaveBeenCalledWith("p1")
  })

  it("every generated namespace and bridge is one the plugin contract names", () => {
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), "packages/plugin-contract/contract/catalog.json"), "utf8")
    ) as { apiNamespaces: { id: string }[]; capabilities: { id: string }[] }
    const namespaces = new Set(catalog.apiNamespaces.map((entry) => entry.id))
    const capabilities = new Set(catalog.capabilities.map((entry) => entry.id))
    expect(MODULE_PLUGIN_API.map((owner) => owner.module)).toEqual(["a2ui", "connectors"])
    for (const owner of MODULE_PLUGIN_API) {
      for (const namespace of owner.namespaces) expect(namespaces).toContain(namespace)
      for (const capability of owner.bridges) expect(capabilities).toContain(capability)
    }
  })
})
