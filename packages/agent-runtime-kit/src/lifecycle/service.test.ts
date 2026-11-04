import type { CreateExternalAgentInput } from "@cognia/agent-contracts/external-agent"
import { ExternalAgentLifecycleService, type LifecycleDependencies } from "./service"
import type { LifecycleAgentConfig } from "./credentials"
import { createRuntimeCatalog } from "./catalog"
import type { ExternalAgentRuntimeCatalog } from "@cognia/agent-contracts/external-agent-lifecycle"
const fixtureCatalog = () =>
  createRuntimeCatalog(
    {
      version: 1,
      runtimes: [],
      unpinnedLaunchWaivers: { runtimes: {} },
    } as ExternalAgentRuntimeCatalog,
    { presetId: () => undefined, baseCommandName: (value) => value }
  )

it("persists credential references and tears down a changed runtime through supplied ports", async () => {
  const configs = new Map<string, LifecycleAgentConfig>(),
    secrets = new Map<string, string>()
  let registered = false
  const manager = {
    addAgent: jest.fn(async () => {
      registered = true
    }),
    removeAgent: jest.fn(async () => {
      registered = false
    }),
    connect: jest.fn(async () => {}),
    disconnect: jest.fn(async () => {}),
    getAgent: () => (registered ? { sessions: new Map<string, unknown>() } : undefined),
    closeSession: jest.fn(async () => {}),
  }
  const deps: LifecycleDependencies = {
    store: {
      getAgent: (id) => configs.get(id),
      getAllAgents: () => [...configs.values()],
      addAgent: (input) => {
        configs.set("own-config", { id: "own-config", ...input } as LifecycleAgentConfig)
        return "own-config"
      },
      updateAgent: (id, updates) => {
        configs.set(id, { ...configs.get(id)!, ...updates } as LifecycleAgentConfig)
      },
      replaceAgentConfig: (id, config) => {
        configs.set(id, config)
      },
      patchLifecycle: (id, fields) => {
        configs.set(id, { ...configs.get(id)!, ...fields })
      },
      removeAgent: (id) => {
        configs.delete(id)
      },
      setConnectionStatus: jest.fn(),
    },
    manager,
    keyring: {
      save: async (key, value) => {
        secrets.set(key, value)
      },
      load: async (key) => secrets.get(key) ?? null,
      delete: async (key) => {
        secrets.delete(key)
      },
    },
    adapters: { isProtocolAvailable: () => true },
    catalog: fixtureCatalog(),
    sandboxSupportsPlatform: () => true,
    duplicateConfig: () => {
      throw new Error("not requested")
    },
    discoverRegistry: async () => ({ result: undefined, runtimes: [] }),
    platform: "darwin",
    hostId: "host-1",
    policyRevision: 1,
    now: () => new Date("2026-11-01T00:00:00Z"),
  }
  const service = new ExternalAgentLifecycleService(deps)
  const id = await service.createConfig({
    name: "Example",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "example", env: { API_KEY: "private-value" } },
  } as CreateExternalAgentInput)
  expect(id).toBe("own-config")
  expect(JSON.stringify(configs.get(id))).not.toContain("private-value")
  expect(secrets.size).toBe(1)
  manager.addAgent.mockClear()
  await service.updateConfig(id, { name: "Renamed" })
  expect(manager.addAgent).not.toHaveBeenCalled()
  await service.updateConfig(id, { process: { command: "example", args: ["acp"] } })
  expect(manager.removeAgent).toHaveBeenCalledWith(id)
  expect(manager.addAgent).toHaveBeenCalled()
})
