/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { PluginManager } from "./manager"
import { PluginServiceRegistry } from "./service-registry"
import { registerHostAuthProviderService } from "@/lib/plugin/auth/connection-access"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { Plugin } from "@/types/plugin"
import calendarPlugin from "@/plugins/feishu-calendar/src/index"
import { getDb } from "@/lib/db/schema"

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: jest.fn(), setState: jest.fn() },
}))
jest.mock("@/lib/plugin/security/signature", () => ({
  getPluginSignatureVerifier: () => ({ verify: async () => ({ valid: true }) }),
}))
jest.mock("@/lib/native/utils", () => ({ canUseTauriInvoke: () => false, isTauri: () => false }))
jest.mock("@/lib/plugin/dexie/bridge", () => ({
  ...jest.requireActual("@/lib/plugin/dexie/bridge"),
  applyPluginTables: async () => undefined,
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function setup() {
  const plugin: Plugin = {
    manifest: {
      id: "host-service-consumer",
      name: "Calendar",
      version: "1.0.0",
      type: "frontend",
      main: "index.ts",
      author: { name: "Test" },
      description: "Test",
      capabilities: [],
      engines: { cognia: ">=0.1.0" },
      requiresServices: { "auth.feishu": "^1.0.0" },
    },
    status: "installed",
    source: "builtin",
    path: "builtin://host-service-consumer",
    config: {},
  }
  const plugins: Record<string, Plugin> = { [plugin.manifest.id]: plugin }
  const store = {
    plugins,
    loadPlugin: async (id: string) => {
      plugins[id].status = "loaded"
    },
    enablePlugin: async (id: string) => {
      plugins[id].status = "enabled"
    },
    disablePlugin: async (id: string) => {
      plugins[id].status = "disabled"
    },
    unloadPlugin: async (id: string) => {
      plugins[id].status = "installed"
    },
    setPluginStatus: (id: string, status: Plugin["status"]) => {
      plugins[id].status = status
    },
    setPluginError: jest.fn(),
    registerPluginHooks: jest.fn(),
    registerPluginTool: jest.fn(),
  }
  jest.mocked(usePluginStore.getState).mockReturnValue(store as never)
  const registry = new PluginServiceRegistry()
  const manager = new PluginManager({
    pluginDirectory: "/plugins",
    lifecycleFeatures: { runtimeServices: true },
    serviceRegistry: registry,
  })
  const internals = manager as unknown as {
    loader: { load: jest.Mock; isLoaded: (id: string) => boolean; unload: jest.Mock }
    registerPluginContributions: jest.Mock
    hostServiceUpdates: Promise<void>
  }
  const activated = jest.fn()
  internals.loader.load = jest.fn(async (current: Plugin) => ({
    manifest: current.manifest,
    activate: activated,
  }))
  internals.loader.isLoaded = () => false
  internals.loader.unload = jest.fn(async () => undefined)
  internals.registerPluginContributions = jest.fn(async () => undefined)
  return { manager, registry, internals, activated, id: plugin.manifest.id }
}

it("resumes a waiting consumer when a matching Host service appears and quiesces it on removal", async () => {
  const f = setup()
  let dispose = () => {}
  try {
    await f.manager.enablePlugin(f.id)
    expect((await f.manager.getPluginLifecycleState(f.id)).actual).toBe("waiting")
    dispose = registerHostAuthProviderService("manager-lark", "auth.feishu", "2.0.0")
    await f.internals.hostServiceUpdates
    expect(f.activated).not.toHaveBeenCalled()
    dispose()
    dispose = registerHostAuthProviderService("manager-lark", "auth.feishu", "1.0.0")
    await f.internals.hostServiceUpdates
    expect((await f.manager.getPluginLifecycleState(f.id)).actual).toBe("active")
    expect(f.activated).toHaveBeenCalledTimes(1)
    dispose()
    await f.internals.hostServiceUpdates
    expect((await f.manager.getPluginLifecycleState(f.id)).actual).toBe("waiting")
    dispose = registerHostAuthProviderService("manager-lark", "auth.feishu", "1.1.0")
    await f.internals.hostServiceUpdates
    expect(f.activated).toHaveBeenCalledTimes(2)
  } finally {
    dispose()
    await f.internals.hostServiceUpdates
    await f.manager.unloadPlugin(f.id)
    f.manager.dispose()
  }
})

it("sees a Host service registered before load and retains it when a plugin provider drains", async () => {
  const dispose = registerHostAuthProviderService("manager-existing", "auth.feishu")
  const f = setup()
  try {
    await f.manager.enablePlugin(f.id)
    expect((await f.manager.getPluginLifecycleState(f.id)).actual).toBe("active")
    f.registry.beginProvider("feishu-auth", 1, { "auth.feishu": "1.0.0" })
    f.registry.publishProvider("feishu-auth", 1)
    await (
      f.manager as unknown as { quiesceServiceConsumers(id: string): Promise<void> }
    ).quiesceServiceConsumers("feishu-auth")
    expect((await f.manager.getPluginLifecycleState(f.id)).actual).toBe("active")
    f.registry.removeProvider("feishu-auth", 1)
  } finally {
    dispose()
    await f.internals.hostServiceUpdates
    await f.manager.unloadPlugin(f.id)
    f.manager.dispose()
  }
})

it("fences an active consumer even when its Host service is replaced in the same tick", async () => {
  let dispose = registerHostAuthProviderService("manager-replaced", "auth.feishu")
  const f = setup()
  try {
    await f.manager.enablePlugin(f.id)
    dispose()
    dispose = registerHostAuthProviderService("manager-replaced", "auth.feishu", "1.1.0")
    await f.internals.hostServiceUpdates
    expect(f.activated).toHaveBeenCalledTimes(2)
    expect((await f.manager.getPluginLifecycleState(f.id)).actual).toBe("active")
  } finally {
    dispose()
    await f.internals.hostServiceUpdates
    await f.manager.unloadPlugin(f.id)
    f.manager.dispose()
  }
})

it("activates the actual calendar consumer and migrates before Integration contributions are registered", async () => {
  const dispose = registerHostAuthProviderService("calendar-activation", "auth.feishu")
  const f = setup()
  const plugin = usePluginStore.getState().plugins[f.id]
  plugin.manifest.capabilities = ["integrations", "scheduler"]
  plugin.manifest.permissions = [
    "integrations:manage",
    "integrations:read",
    "integrations:execute",
    "auth:consume",
  ]
  f.internals.loader.load = jest.fn(async () => ({
    manifest: plugin.manifest,
    activate: calendarPlugin.activate,
  }))
  try {
    await f.manager.enablePlugin(f.id)
    expect((await f.manager.getPluginLifecycleState(f.id)).actual).toBe("active")
    expect(
      (await getDb().integrationAudit.toArray()).some(
        (entry) => entry.kind === "migration.feishu-calendar-host-connections-v1.completed"
      )
    ).toBe(true)
    expect(f.internals.registerPluginContributions).toHaveBeenCalled()
  } finally {
    dispose()
    await f.internals.hostServiceUpdates
    await f.manager.unloadPlugin(f.id)
    f.manager.dispose()
  }
})
