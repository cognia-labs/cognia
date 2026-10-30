import {
  runMarketplaceInstall,
  resolveConflictingPlugins,
  type RunMarketplaceInstallOpts,
  type RunMarketplaceInstallResult,
  type PreInstallDependencyPayload,
} from "./install-flow"
import type { PluginIntent } from "../core/lifecycle-state"
import { PluginLifecycleCoordinator } from "../core/lifecycle-coordinator"
import type { PluginManifest } from "@/types/plugin"
jest.mock("../core/manager", () => ({ getPluginManager: jest.fn() }))
import { getPluginManager } from "../core/manager"
import { PluginRegistry } from "../core/registry"
import { emitPluginIntentChange, subscribePluginIntentChanges } from "../core/plugin-intent-events"

jest.mock("../shortcuts/plugin-shortcut-bridge", () => {
  const actual = jest.requireActual("../shortcuts/plugin-shortcut-bridge")
  return { ...actual, flushPluginShortcutOperations: jest.fn(actual.flushPluginShortcutOperations) }
})

jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(),
  getPlugin: jest.fn(async () => ({ id: "demo-plugin" })),
  setPluginConfig: jest.fn(),
}))

const mockRuntimeConfig = jest.fn()
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: () => ({
      plugins: { "demo-plugin": { config: {} } },
      setPluginConfig: mockRuntimeConfig,
    }),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { listPlugins, setPluginConfig } = require("@/lib/db/plugins") as {
  listPlugins: jest.Mock
  setPluginConfig: jest.Mock
}

function makeManifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "demo-plugin",
    name: "Demo",
    version: "1.0.0",
    type: "frontend",
    capabilities: [],
    ...over,
  } as PluginManifest
}

function makeOpts(over: Partial<RunMarketplaceInstallOpts> = {}): RunMarketplaceInstallOpts {
  const client = {
    getPlugin: jest.fn().mockResolvedValue({ manifest: makeManifest(), name: "Demo" }),
    installPlugin: jest.fn().mockResolvedValue({ success: true }),
  }
  return {
    pluginId: "demo-plugin",
    requestConflictReview: jest.fn().mockResolvedValue("continue"),
    requestPermissionReview: jest.fn().mockResolvedValue("approve"),
    requestConfig: jest.fn().mockResolvedValue({ result: "save", value: {} }),
    client,
    dependencyClient: { getPlugin: jest.fn().mockResolvedValue(null), installPlugin: jest.fn() },
    ...over,
  }
}

describe("runMarketplaceInstall", () => {
  const lifecycleManager = (ids: string[], intent: "auto" | "enabled" = "enabled") => {
    const coordinator = new PluginLifecycleCoordinator()
    const statuses = new Map(ids.map((id) => [id, "enabled"]))
    const intents = new Map<string, PluginIntent>(ids.map((id) => [id, intent]))
    const disablePlugin = jest.fn(async (id: string) => {
      statuses.set(id, "disabled")
    })
    const enablePlugin = jest.fn(async (id: string, _reason?: string) => {
      statuses.set(id, "enabled")
    })
    const manager = {
      getPlugin: (id: string) => (statuses.has(id) ? { status: statuses.get(id) } : undefined),
      getPluginLifecycleState: async (id: string) => ({ intent: intents.get(id) ?? "auto" }),
      disablePlugin,
      enablePlugin,
      suspendPlugin: jest.fn(async (id: string) => {
        statuses.set(id, "suspended")
      }),
      setPluginIntent: jest.fn(
        async (
          id: string,
          next: "auto" | "enabled" | "disabled",
          reason?: string,
          options?: { reconcile?: boolean; emitChange?: boolean }
        ) => {
          return coordinator.withIntentTransition("test-manager", id, async () => {
            intents.set(id, next)
            coordinator.invalidateIntentPause(id)
            if (options?.reconcile !== false) {
              if (next === "disabled") await disablePlugin(id)
              if (next === "enabled") await enablePlugin(id)
            }
            if (options?.emitChange !== false)
              emitPluginIntentChange({ pluginId: id, intent: next, reason: reason ?? "manual" })
          })
        }
      ),
      acquirePluginInstallPause: (id: string, options: { deferred?: boolean } = {}) =>
        coordinator.acquireIntentPause(
          "test-manager",
          id,
          {
            snapshot: async () => ({
              intent: intents.get(id) ?? "auto",
              resume:
                intents.get(id) !== "disabled" &&
                ["enabled", "suspended", "loading", "enabling"].includes(statuses.get(id) ?? ""),
              suspended: statuses.get(id) === "suspended",
            }),
            pause: async () => {
              intents.set(id, "disabled")
              await disablePlugin(id)
            },
            restore: async (snapshot) => {
              intents.set(id, snapshot.intent)
              if (snapshot.resume) {
                await enablePlugin(id, "marketplace-restore")
                if (snapshot.suspended) statuses.set(id, "suspended")
              }
            },
            commit: () => {
              emitPluginIntentChange({
                pluginId: id,
                intent: "disabled",
                reason: "marketplace-replacement",
              })
            },
          },
          options
        ),
    }
    jest.mocked(getPluginManager).mockReturnValue(manager as never)
    return { manager, statuses, intents }
  }

  it("pauses persistent enabled intent and restores the prior auto intent and runtime", async () => {
    const { statuses, intents } = lifecycleManager(["consumer"], "auto")
    const restore = await resolveConflictingPlugins(["consumer"])
    expect(statuses.get("consumer")).toBe("disabled")
    expect(intents.get("consumer")).toBe("disabled")
    await restore()
    expect(statuses.get("consumer")).toBe("enabled")
    expect(intents.get("consumer")).toBe("auto")
  })

  it("compensates the current peer when disable changes it before rejecting", async () => {
    const { manager, statuses, intents } = lifecycleManager(["first", "late"])
    manager.disablePlugin.mockImplementation(async (id: string) => {
      statuses.set(id, id === "late" ? "error" : "disabled")
      if (id === "late") throw new Error("late failure")
    })
    await expect(resolveConflictingPlugins(["first", "late"])).rejects.toThrow("late failure")
    expect(statuses.get("late")).toBe("enabled")
    expect(intents.get("late")).toBe("enabled")
    expect(statuses.get("first")).toBe("enabled")
  })

  it("preserves a suspended peer's state and intent when restoring", async () => {
    const { statuses, intents } = lifecycleManager(["sleeping"])
    statuses.set("sleeping", "suspended")
    const restore = await resolveConflictingPlugins(["sleeping"])
    expect(intents.get("sleeping")).toBe("disabled")
    await restore()
    expect(statuses.get("sleeping")).toBe("suspended")
    expect(intents.get("sleeping")).toBe("enabled")
  })

  it.each(["loading", "enabling"])(
    "restores a consumer whose %s activation was queued before its pause",
    async (status) => {
      const { statuses, intents } = lifecycleManager(["consumer"])
      statuses.set("consumer", status)
      const restore = await resolveConflictingPlugins(["consumer"])
      expect(statuses.get("consumer")).toBe("disabled")
      await restore()
      expect(statuses.get("consumer")).toBe("enabled")
      expect(intents.get("consumer")).toBe("enabled")
    }
  )

  it("cancels before commit if aborted while the consumer pause is pending", async () => {
    let releasePause!: (restore: () => Promise<void>) => void
    let started!: () => void
    const pauseStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const restore = jest.fn(async () => undefined)
    const install = jest.fn(async () => ({ success: true }))
    const dispose = jest.fn(async () => undefined)
    const controller = new AbortController()
    const pending = runMarketplaceInstall(
      makeOpts({
        signal: controller.signal,
        pauseBeforeInstall: ["consumer"],
        client: {
          getPlugin: jest.fn(),
          preparePlugin: async () => ({ manifest: makeManifest(), install, dispose }),
          installPlugin: jest.fn(),
        },
        resolveConflictingPlugins: async () => {
          started()
          return new Promise((resolve) => {
            releasePause = resolve
          })
        },
      })
    )
    await pauseStarted
    controller.abort()
    releasePause(restore)
    expect(await pending).toEqual({ status: "cancelled", stage: "install" })
    expect(install).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    "rejects replacement of a required provider (transitive: %s)",
    async (transitive) => {
      const tool = { name: "shared", description: "Shared", parametersSchema: {} }
      listPlugins.mockResolvedValue([
        {
          id: "provider",
          version: "1.0.0",
          enabled: true,
          manifest: makeManifest({ id: "provider", tools: [tool] }),
        },
        ...(transitive
          ? [
              {
                id: "middle",
                version: "1.0.0",
                enabled: false,
                manifest: makeManifest({ id: "middle", dependencies: { provider: "*" } }),
              },
            ]
          : []),
      ])
      const resolve = jest.fn(async () => async () => undefined)
      const opts = makeOpts({
        client: {
          getPlugin: async () => ({
            manifest: makeManifest({
              tools: [tool],
              dependencies: { [transitive ? "middle" : "provider"]: "*" },
            }),
          }),
          installPlugin: jest.fn(),
        },
        checkInstalledPlugin: async () => ({ version: "1.0.0" }),
        requestConflictReview: async () => "disable-conflicting",
        resolveConflictingPlugins: resolve,
      })
      expect(await runMarketplaceInstall(opts)).toMatchObject({
        status: "failed",
        stage: "conflict",
        message: "requiredProviderConflict",
      })
      expect(resolve).not.toHaveBeenCalled()
      expect(opts.client.installPlugin).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    "uses the selected dependency edges before replacing an old provider (retains provider: %s)",
    async (retainsProvider) => {
      const { intents, statuses } = lifecycleManager(["c"])
      const tool = { name: "shared", description: "Shared", parametersSchema: {} }
      const b2 = makeManifest({
        id: "b",
        version: "2.0.0",
        ...(retainsProvider ? { dependencies: { c: "*" } } : {}),
      })
      const rows = new Map([
        [
          "b",
          {
            id: "b",
            version: "1.0.0",
            enabled: false,
            manifest: makeManifest({ id: "b", dependencies: { c: "*" } }),
          },
        ],
        [
          "c",
          {
            id: "c",
            version: "1.0.0",
            enabled: true,
            manifest: makeManifest({ id: "c", tools: [tool] }),
          },
        ],
      ])
      listPlugins.mockImplementation(async () => [...rows.values()])
      const installed: string[] = []
      const opts = makeOpts({
        client: {
          getPlugin: async () => ({
            manifest: makeManifest({ tools: [tool], dependencies: { b: "^2.0.0" } }),
          }),
          installPlugin: async () => {
            installed.push("target")
          },
        },
        dependencyClient: {
          getPlugin: async () => ({ manifest: b2 }),
          installPlugin: async () => {
            expect(intents.get("c")).toBe("enabled")
            rows.set("b", { id: "b", version: "2.0.0", enabled: false, manifest: b2 })
            installed.push("b@2.0.0")
          },
        },
        checkInstalledPlugin: async (id) => rows.get(id) ?? null,
        requestConflictReview: async ({ pluginId }) =>
          pluginId === "demo-plugin" ? "disable-conflicting" : "continue",
        requestDependencyReview: async () => {
          expect(intents.get("c")).toBe("enabled")
          return "resolve"
        },
      })
      if (retainsProvider) {
        expect(await runMarketplaceInstall(opts)).toMatchObject({
          status: "failed",
          message: "requiredProviderConflict",
        })
        expect(installed).toEqual([])
        expect(intents.get("c")).toBe("enabled")
        expect(statuses.get("c")).toBe("enabled")
      } else {
        expect(await runMarketplaceInstall(opts)).toEqual({
          status: "installed",
          pluginId: "demo-plugin",
        })
        expect(installed).toEqual(["b@2.0.0", "target"])
        expect(intents.get("c")).toBe("disabled")
      }
    }
  )

  it("does not apply an old replacement decision after a manual choice during dependency review", async () => {
    const { manager, intents } = lifecycleManager(["c"])
    const tool = { name: "shared", description: "Shared", parametersSchema: {} }
    listPlugins.mockResolvedValue([
      { id: "c", enabled: true, manifest: makeManifest({ id: "c", tools: [tool] }) },
    ])
    let bInstalled = false
    const opts = makeOpts({
      client: {
        getPlugin: async () => ({
          manifest: makeManifest({ tools: [tool], dependencies: { b: "*" } }),
        }),
        installPlugin: jest.fn(),
      },
      dependencyClient: {
        getPlugin: async () => ({ manifest: makeManifest({ id: "b" }) }),
        installPlugin: async () => {
          bInstalled = true
        },
      },
      checkInstalledPlugin: async () => (bInstalled ? { version: "1.0.0" } : null),
      requestConflictReview: async () => "disable-conflicting",
      requestDependencyReview: async () => {
        await manager.setPluginIntent("c", "enabled", "manual")
        return "resolve"
      },
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(intents.get("c")).toBe("enabled")
    expect(manager.disablePlugin).not.toHaveBeenCalled()
  })

  it("excludes a manually disabled consumer from the actual resume graph after replanning", async () => {
    const { manager, intents, statuses } = lifecycleManager(["c", "d"])
    const cTool = { name: "c_shared", description: "C", parametersSchema: {} }
    const dTool = { name: "d_shared", description: "D", parametersSchema: {} }
    const c = makeManifest({
      id: "c",
      tools: [cTool],
      dependencies: { b: ">=1.0.0 <3.0.0", d: "*" },
    })
    let bVersion = "1.0.0"
    listPlugins.mockImplementation(async () => [
      {
        id: "b",
        version: bVersion,
        enabled: false,
        manifest: makeManifest({ id: "b", version: bVersion }),
      },
      { id: "c", version: "1.0.0", enabled: statuses.get("c") === "enabled", manifest: c },
      {
        id: "d",
        version: "1.0.0",
        enabled: statuses.get("d") === "enabled",
        manifest: makeManifest({ id: "d", tools: [dTool] }),
      },
    ])
    const installs: string[] = []
    const opts = makeOpts({
      client: {
        getPlugin: async () => ({
          manifest: makeManifest({ tools: [cTool, dTool], dependencies: { b: "^2.0.0" } }),
        }),
        installPlugin: async () => {
          installs.push("target")
        },
      },
      dependencyClient: {
        getPlugin: async () => ({ manifest: makeManifest({ id: "b", version: "2.0.0" }) }),
        installPlugin: async () => {
          bVersion = "2.0.0"
          installs.push("b")
        },
      },
      checkInstalledPlugin: async (id) => ({ version: id === "b" ? bVersion : "1.0.0" }),
      requestConflictReview: async ({ pluginId }) =>
        pluginId === "demo-plugin" ? "disable-conflicting" : "continue",
      requestDependencyReview: async () => {
        await manager.setPluginIntent("c", "disabled", "manual")
        return "resolve"
      },
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(installs).toEqual(["b", "target"])
    expect(intents.get("c")).toBe("disabled")
    expect(intents.get("d")).toBe("disabled")
    expect(manager.enablePlugin).not.toHaveBeenCalled()
  })

  it("skips a stale sibling action once recursion installed a compatible version", async () => {
    const rows: Array<{ id: string; version: string; enabled: boolean; manifest: PluginManifest }> =
      []
    listPlugins.mockImplementation(async () => rows)
    const events: string[] = []
    const depManifest = (id: string, version?: string) =>
      makeManifest({
        id,
        version: version ?? (id === "d" ? "2.0.0" : "3.0.0"),
        ...(id === "d" ? { dependencies: { e: "^2.0.0" } } : {}),
      })
    const opts = makeOpts({
      client: {
        getPlugin: async () => ({
          manifest: makeManifest({ dependencies: { d: ">=1.0.0", e: ">=1.0.0" } }),
        }),
        installPlugin: async () => {
          events.push("target")
        },
      },
      dependencyClient: {
        getPlugin: async (id) => ({ manifest: depManifest(id) }),
        getVersions: async (id) =>
          (id === "d" ? ["2.0.0"] : ["3.0.0", "2.0.0"]).map((version) => ({ version })),
        installPlugin: jest.fn(),
        preparePlugin: async (id, version) => ({
          manifest: depManifest(id, version),
          install: async () => {
            const manifest = depManifest(id, version)
            rows.push({ id, version: manifest.version, manifest, enabled: false })
            events.push(`${id}@${manifest.version}`)
          },
          dispose: async () => undefined,
        }),
      },
      requestDependencyReview: async () => "resolve",
      checkInstalledPlugin: async (id) => rows.find((row) => row.id === id) ?? null,
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(events).toEqual(["e@2.0.0", "d@2.0.0", "target"])
  })

  it("replans an incompatible stale sibling and reviews its new version before installing", async () => {
    const rows = new Map<
      string,
      { id: string; version: string; enabled: boolean; manifest: PluginManifest }
    >()
    const dependency = (id: string, version: string) =>
      makeManifest({
        id,
        version,
        ...(id === "d" ? { dependencies: { e: ">=1.0.0 <3.0.0" } } : {}),
      })
    rows.set("e", { id: "e", version: "1.0.0", enabled: false, manifest: dependency("e", "1.0.0") })
    listPlugins.mockImplementation(async () => [...rows.values()])
    const events: string[] = []
    const requestDependencyReview = jest.fn(
      async (_payload: PreInstallDependencyPayload) => "resolve" as const
    )
    const opts = makeOpts({
      client: {
        getPlugin: async () => ({
          manifest: makeManifest({ dependencies: { d: ">=1.0.0", e: ">=2.0.0" } }),
        }),
        installPlugin: async () => {
          events.push("target")
        },
      },
      dependencyClient: {
        getPlugin: async (id) => ({ manifest: dependency(id, id === "d" ? "2.0.0" : "3.0.0") }),
        getVersions: async (id) =>
          (id === "d" ? ["2.0.0"] : ["3.0.0", "2.0.0", "1.0.0"]).map((version) => ({ version })),
        installPlugin: jest.fn(),
        preparePlugin: async (id, version) => ({
          manifest: dependency(id, version!),
          install: async () => {
            const manifest = dependency(id, version!)
            rows.set(id, { id, version: manifest.version, enabled: false, manifest })
            events.push(`${id}@${manifest.version}`)
          },
          dispose: async () => undefined,
        }),
      },
      checkInstalledPlugin: async (id) => rows.get(id) ?? null,
      requestDependencyReview,
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(requestDependencyReview).toHaveBeenCalledTimes(2)
    expect(requestDependencyReview.mock.calls[0][0]).toMatchObject({
      actions: [
        { pluginId: "d", version: "2.0.0" },
        { pluginId: "e", version: "3.0.0" },
      ],
    })
    expect(requestDependencyReview.mock.calls[1][0]).toMatchObject({
      actions: [{ pluginId: "e", version: "2.0.0" }],
    })
    expect(events).toEqual(["d@2.0.0", "e@2.0.0", "target"])
  })

  it("protects required providers of consumers that will resume after a dependency upgrade", async () => {
    const { manager, intents, statuses } = lifecycleManager(["consumer", "provider", "d", "c"])
    let versionD = "0.5.0"
    const tool = { name: "shared", description: "Shared", parametersSchema: {} }
    listPlugins.mockImplementation(async () => [
      {
        id: "consumer",
        version: "1.0.0",
        enabled: statuses.get("consumer") === "enabled",
        manifest: makeManifest({
          id: "consumer",
          dependencies: { d: ">=0.5.0 <2.0.0", provider: "*" },
        }),
      },
      {
        id: "provider",
        version: "1.0.0",
        enabled: true,
        manifest: makeManifest({ id: "provider", tools: [tool] }),
      },
      {
        id: "d",
        version: versionD,
        enabled: true,
        manifest: makeManifest({ id: "d", version: versionD }),
      },
      {
        id: "c",
        version: "0.5.0",
        enabled: true,
        manifest: makeManifest({ id: "c", version: "0.5.0" }),
      },
    ])
    const installDependency = jest.fn(async (id: string) => {
      if (id === "d") versionD = "1.2.0"
    })
    const opts = makeOpts({
      client: {
        getPlugin: async () => ({
          manifest: makeManifest({ dependencies: { d: "^1.0.0", c: "^1.0.0" } }),
        }),
        installPlugin: jest.fn(),
      },
      dependencyClient: {
        getPlugin: async (id) => ({
          manifest: makeManifest({
            id,
            version: id === "d" ? "1.2.0" : "1.0.0",
            ...(id === "c" ? { tools: [tool] } : {}),
          }),
        }),
        installPlugin: installDependency,
      },
      checkInstalledPlugin: async (id) =>
        id === "d" ? { version: versionD } : { version: "0.5.0" },
      requestDependencyReview: async () => "resolve",
      requestConflictReview: async ({ pluginId }) =>
        pluginId === "c" ? "disable-conflicting" : "continue",
    })
    expect(await runMarketplaceInstall(opts)).toMatchObject({
      status: "failed",
      message: "requiredProviderConflict",
    })
    expect(installDependency.mock.calls.map(([id]) => id)).toEqual(["d"])
    expect(manager.setPluginIntent).not.toHaveBeenCalledWith(
      "provider",
      "disabled",
      "marketplace-review"
    )
    expect(intents.get("consumer")).toBe("enabled")
    expect(intents.get("provider")).toBe("enabled")
    expect(statuses.get("consumer")).toBe("enabled")
  })

  it("does not offer to disable commands which only share a plugin-local id", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other",
        enabled: true,
        manifest: makeManifest({ id: "other", commands: [{ id: "run", name: "/alpha" }] }),
      },
    ])
    const opts = makeOpts({
      client: {
        getPlugin: async () => ({
          manifest: makeManifest({ commands: [{ id: "run", name: "/beta" }] }),
        }),
        installPlugin: jest.fn(),
      },
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(opts.requestConflictReview).not.toHaveBeenCalled()
  })

  it("restores earlier competitors if disabling a later competitor fails", async () => {
    const { manager } = lifecycleManager(["first", "blocked"])
    manager.disablePlugin.mockImplementation(async (id: string) => {
      if (id === "blocked") throw new Error("active dependent")
    })
    await expect(resolveConflictingPlugins(["first", "blocked"])).rejects.toThrow(
      "active dependent"
    )
    expect(manager.enablePlugin).toHaveBeenCalledWith("first", "marketplace-restore")
  })

  it("keeps explicit replacement intent disabled after successful installation", async () => {
    const { intents } = lifecycleManager(["other"])
    const tool = { name: "shared", description: "Shared", parametersSchema: {} }
    listPlugins.mockResolvedValue([
      { id: "other", enabled: true, manifest: makeManifest({ id: "other", tools: [tool] }) },
    ])
    const changes: unknown[] = []
    const off = subscribePluginIntentChanges((change) => changes.push(change))
    const opts = makeOpts({
      client: {
        getPlugin: async () => ({ manifest: makeManifest({ tools: [tool] }) }),
        installPlugin: jest.fn(async () => {
          expect(changes).toEqual([])
        }),
      },
      requestConflictReview: async () => "disable-conflicting",
    })
    try {
      expect(await runMarketplaceInstall(opts)).toEqual({
        status: "installed",
        pluginId: "demo-plugin",
      })
      expect(intents.get("other")).toBe("disabled")
      expect(changes).toEqual([
        { pluginId: "other", intent: "disabled", reason: "marketplace-replacement" },
      ])
    } finally {
      off()
    }
  })

  it("publishes no user-intent changes for an explicit replacement that is later cancelled", async () => {
    const { intents } = lifecycleManager(["other"])
    const tool = { name: "shared", description: "Shared", parametersSchema: {} }
    listPlugins.mockResolvedValue([
      { id: "other", enabled: true, manifest: makeManifest({ id: "other", tools: [tool] }) },
    ])
    const changes: unknown[] = []
    const off = subscribePluginIntentChanges((change) => changes.push(change))
    try {
      const result = await runMarketplaceInstall(
        makeOpts({
          client: {
            getPlugin: async () => ({
              manifest: makeManifest({ tools: [tool], permissions: ["network:fetch"] }),
            }),
            installPlugin: jest.fn(),
          },
          requestConflictReview: async () => "disable-conflicting",
          requestPermissionReview: async () => "cancel",
        })
      )
      expect(result).toEqual({ status: "cancelled", stage: "permission" })
      expect(intents.get("other")).toBe("enabled")
      expect(changes).toEqual([])
    } finally {
      off()
    }
  })

  it("does not publish a replacement invalidated while the final shortcut drain is pending", async () => {
    const { manager, intents } = lifecycleManager(["other"])
    const tool = { name: "shared", description: "Shared", parametersSchema: {} }
    listPlugins.mockResolvedValue([
      { id: "other", enabled: true, manifest: makeManifest({ id: "other", tools: [tool] }) },
    ])
    const shortcuts = await import("../shortcuts/plugin-shortcut-bridge")
    let release!: () => void
    let started!: () => void
    const draining = new Promise<void>((resolve) => {
      started = resolve
    })
    const flush = jest.mocked(shortcuts.flushPluginShortcutOperations).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
          started()
        })
    )
    const changes: unknown[] = []
    const off = subscribePluginIntentChanges((change) => changes.push(change))
    try {
      const run = runMarketplaceInstall(
        makeOpts({
          client: {
            getPlugin: async () => ({ manifest: makeManifest({ tools: [tool] }) }),
            installPlugin: jest.fn(),
          },
          requestConflictReview: async () => "disable-conflicting",
        })
      )
      await draining
      expect(intents.get("other")).toBe("disabled")
      expect(changes).toEqual([])
      await manager.setPluginIntent("other", "enabled", "manual")
      release()
      expect(await run).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(changes).toEqual([{ pluginId: "other", intent: "enabled", reason: "manual" }])
      expect(intents.get("other")).toBe("enabled")
    } finally {
      release?.()
      flush
        .mockReset()
        .mockImplementation(
          jest.requireActual("../shortcuts/plugin-shortcut-bridge").flushPluginShortcutOperations
        )
      off()
    }
  })

  it("reports failed restoration distinctly after cancellation", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other",
        enabled: true,
        manifest: makeManifest({ id: "other", commands: [{ id: "cmd", name: "Cmd" }] }),
      },
    ])
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({
            commands: [{ id: "cmd", name: "Cmd" }],
            permissions: ["network:fetch"],
          }),
        })),
        installPlugin: jest.fn(),
      },
      requestConflictReview: jest.fn(async () => "disable-conflicting"),
      requestPermissionReview: jest.fn(async () => "cancel"),
      resolveConflictingPlugins: async () => async () => {
        throw new Error("cannot restore")
      },
    })
    expect(await runMarketplaceInstall(opts)).toMatchObject({
      status: "failed",
      stage: "install-rollback",
    })
  })
  beforeEach(() => {
    jest.mocked(getPluginManager).mockReturnValue({
      getPlugin: jest.fn(),
      rollbackInstallation: jest.fn(async () => undefined),
    } as never)
    listPlugins.mockReset()
    listPlugins.mockResolvedValue([])
    setPluginConfig.mockReset()
    setPluginConfig.mockResolvedValue(undefined)
    mockRuntimeConfig.mockClear()
  })

  it("returns failed when the marketplace has no entry for the id", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue(null),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({ client })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual<RunMarketplaceInstallResult>({
      status: "failed",
      stage: "install",
      message: "plugin_not_found",
    })
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("happy path: skips conflict + permission + config when manifest is bare", async () => {
    const opts = makeOpts()
    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(opts.requestConflictReview).not.toHaveBeenCalled()
    expect(opts.requestPermissionReview).not.toHaveBeenCalled()
    expect(opts.requestConfig).not.toHaveBeenCalled()
    expect(opts.client.installPlugin).toHaveBeenCalledWith("demo-plugin", undefined)
  })

  it("cancels at conflict step when an id is already installed and user backs out", async () => {
    listPlugins.mockResolvedValue([{ id: "demo-plugin", version: "0.9.0" }])
    const opts = makeOpts({
      requestConflictReview: jest.fn().mockResolvedValue("cancel"),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "conflict" })
    expect(opts.requestConflictReview).toHaveBeenCalledTimes(1)
    expect(opts.requestPermissionReview).not.toHaveBeenCalled()
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })

  it("continues past conflict when the user confirms", async () => {
    listPlugins.mockResolvedValue([{ id: "demo-plugin", version: "0.9.0" }])
    const opts = makeOpts()

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(opts.requestConflictReview).toHaveBeenCalledTimes(1)
  })

  // -- ADR 0016 P1-6 — ConflictDetector wired into install pipeline ------------

  it("surfaces a command-conflict when an installed plugin owns the same slash token", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other-plugin",
        manifest: makeManifest({
          id: "other-plugin",
          version: "1.0.0",
          commands: [{ id: "duplicate.command", name: "/duplicate" }],
        } as never),
      },
    ])
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          id: "demo-plugin",
          commands: [{ id: "duplicate.command", name: "/duplicate" }],
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const requestConflictReview = jest.fn().mockResolvedValue("cancel")
    const opts = makeOpts({ client, requestConflictReview })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "conflict" })
    expect(requestConflictReview).toHaveBeenCalledTimes(1)
    const conflictArg = requestConflictReview.mock.calls[0][0] as {
      reasons: Array<{ severity: string; message: string }>
    }
    expect(conflictArg.reasons.some((r) => r.message.startsWith("command:"))).toBe(true)
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("surfaces a shortcut-conflict alongside id-collision when both occur", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other-plugin",
        manifest: makeManifest({
          id: "other-plugin",
          version: "1.0.0",
          commands: [{ id: "other.cmd", title: "Other", shortcut: "ctrl+shift+x" }],
        } as never),
      },
      {
        id: "demo-plugin",
        version: "0.9.0",
        manifest: makeManifest({ id: "demo-plugin", version: "0.9.0" }),
      },
    ])
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          id: "demo-plugin",
          commands: [{ id: "demo.cmd", title: "Demo", shortcut: "ctrl+shift+x" }],
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const requestConflictReview = jest.fn().mockResolvedValue("continue")
    const opts = makeOpts({ client, requestConflictReview })

    await runMarketplaceInstall(opts)

    const conflictArg = requestConflictReview.mock.calls[0][0] as {
      reasons: Array<{ severity: string; message: string }>
    }
    const messages = conflictArg.reasons.map((r) => r.message)
    expect(messages.some((m) => m.startsWith("alreadyInstalled:"))).toBe(true)
    expect(messages.some((m) => m.startsWith("shortcut:"))).toBe(true)
  })

  it("requests permission review when manifest declares permissions and cancels there", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          permissions: ["filesystem:read" as never],
        }),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client,
      requestPermissionReview: jest.fn().mockResolvedValue("cancel"),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "permission" })
    expect(opts.requestPermissionReview).toHaveBeenCalledTimes(1)
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("requests config when manifest has a non-empty configSchema and cancels there", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "cancel" }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "config" })
    expect(opts.requestConfig).toHaveBeenCalledTimes(1)
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("forwards the manifest's own locale bundles with the config schema", async () => {
    const i18n = { locales: { en: { "config.token.title": "Token" } } }
    const configSchema = {
      type: "object",
      properties: { token: { type: "string", titleKey: "config.token.title" } },
    }
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({ configSchema, i18n } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "cancel" }),
    })
    await runMarketplaceInstall(opts)
    expect(opts.requestConfig).toHaveBeenCalledWith(expect.objectContaining({ configSchema, i18n }))
  })

  it("does NOT request permission review when there are no declared or optional permissions", async () => {
    const opts = makeOpts()
    await runMarketplaceInstall(opts)
    expect(opts.requestPermissionReview).not.toHaveBeenCalled()
  })

  it("does NOT request config when configSchema is empty / missing", async () => {
    const opts = makeOpts()
    await runMarketplaceInstall(opts)
    expect(opts.requestConfig).not.toHaveBeenCalled()
  })

  it("captures install errors and returns a failed result", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({ manifest: makeManifest(), name: "Demo" }),
      installPlugin: jest.fn().mockRejectedValue(new Error("network down")),
    }
    const opts = makeOpts({ client })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "network down",
    })
  })

  it("captures getPlugin throws and returns a failed result", async () => {
    const client = {
      getPlugin: jest.fn().mockRejectedValue(new Error("offline")),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({ client })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "offline",
    })
    expect(client.installPlugin).not.toHaveBeenCalled()
  })

  it("passes configuration into the package transaction instead of writing it after finalization", async () => {
    const client = {
      supportsTransactionalConfig: true,
      getPlugin: jest.fn(async () => ({
        manifest: makeManifest({
          configSchema: { type: "object", properties: { token: { type: "string" } } },
        } as never),
      })),
      installPlugin: jest.fn(async () => ({ success: true })),
    }
    const result = await runMarketplaceInstall(
      makeOpts({
        client,
        requestConfig: jest.fn(async () => ({
          result: "save" as const,
          value: { token: "atomic" },
        })),
      })
    )
    expect(result.status).toBe("installed")
    expect(client.installPlugin).toHaveBeenCalledWith("demo-plugin", undefined, {
      config: { token: "atomic" },
    })
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("propagates a direct registry client's resolved failure", async () => {
    const opts = makeOpts()
    opts.client.installPlugin = jest.fn(async () => ({
      success: false,
      error: "configuration transaction failed",
    }))
    expect(await runMarketplaceInstall(opts)).toMatchObject({
      status: "failed",
      message: "configuration transaction failed",
    })
  })

  it("persists user-supplied config to dexie after install success", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc123" } }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(client.installPlugin).toHaveBeenCalledWith("demo-plugin", undefined)
    expect(setPluginConfig).toHaveBeenCalledWith("demo-plugin", { token: "abc123" })
    expect(mockRuntimeConfig).toHaveBeenCalledWith("demo-plugin", { token: "abc123" })
    expect(mockRuntimeConfig.mock.invocationCallOrder[0]).toBeGreaterThan(
      setPluginConfig.mock.invocationCallOrder[0]
    )
    // setPluginConfig must be invoked after installPlugin — order matters
    // because the dexie row only exists once installPlugin returns.
    const installOrder = client.installPlugin.mock.invocationCallOrder[0]
    const configOrder = setPluginConfig.mock.invocationCallOrder[0]
    expect(configOrder).toBeGreaterThan(installOrder)
  })

  it("does NOT call setPluginConfig when the config step was skipped", async () => {
    const opts = makeOpts()
    const result = await runMarketplaceInstall(opts)
    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("does NOT call setPluginConfig when the user provided an empty {} payload", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: {} }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("does NOT call setPluginConfig when the user cancels at the config step", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "cancel" }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({ status: "cancelled", stage: "config" })
    expect(client.installPlugin).not.toHaveBeenCalled()
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("does NOT call setPluginConfig when installPlugin itself fails", async () => {
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockRejectedValue(new Error("network down")),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "network down",
    })
    expect(setPluginConfig).not.toHaveBeenCalled()
  })

  it("surfaces a failed result when setPluginConfig throws after install success", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("indexeddb full"))
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "indexeddb full",
    })
    // installPlugin already ran — the dexie row exists, only the config
    // write failed. The orchestrator's contract is to surface this rather
    // than silently dropping the user's input.
    expect(client.installPlugin).toHaveBeenCalledTimes(1)
  })

  it("invokes the rollback hook when setPluginConfig throws after install success", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("indexeddb full"))
    const rollback = jest.fn().mockResolvedValue(undefined)
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
      rollback,
    })

    const result = await runMarketplaceInstall(opts)

    expect(rollback).toHaveBeenCalledTimes(1)
    expect(rollback).toHaveBeenCalledWith("demo-plugin", expect.stringContaining("indexeddb full"))
    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "indexeddb full",
    })
  })

  it("returns install-rollback failure when the rollback hook itself throws", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("indexeddb full"))
    const rollback = jest.fn().mockRejectedValue(new Error("uninstall locked"))
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
      rollback,
    })

    const result = await runMarketplaceInstall(opts)

    expect(result).toEqual({
      status: "failed",
      stage: "install-rollback",
      message: "uninstall locked",
    })
  })

  it("does not invoke the rollback hook when client.installPlugin itself failed", async () => {
    // installPlugin throw means the manager's own rollback already ran
    // (or never installed at all). The orchestrator must NOT double-roll-back.
    const rollback = jest.fn().mockResolvedValue(undefined)
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockRejectedValue(new Error("net down")),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
      rollback,
    })

    await runMarketplaceInstall(opts)
    expect(rollback).not.toHaveBeenCalled()
  })

  it("skips rollback entirely when opts.rollback is explicitly null", async () => {
    setPluginConfig.mockRejectedValueOnce(new Error("indexeddb full"))
    const client = {
      getPlugin: jest.fn().mockResolvedValue({
        manifest: makeManifest({
          configSchema: {
            type: "object",
            properties: { token: { type: "string" } },
          },
        } as never),
        name: "Demo",
      }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    }
    const opts = makeOpts({
      client,
      requestConfig: jest.fn().mockResolvedValue({ result: "save", value: { token: "abc" } }),
      rollback: null,
    })

    const result = await runMarketplaceInstall(opts)
    expect(result).toEqual({
      status: "failed",
      stage: "install",
      message: "indexeddb full",
    })
  })

  describe("requires.binaries gate", () => {
    const manifestWithBinary = () =>
      makeManifest({
        requires: { binaries: [{ name: "git", minVersion: "2.0.0" }] },
      } as never)

    it("skips the gate when the manifest declares no binaries", async () => {
      const detectBinary = jest.fn()
      const opts = makeOpts({ detectBinary })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(detectBinary).not.toHaveBeenCalled()
    })

    it("proceeds when all required binaries are present and satisfy minVersion", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest
        .fn()
        .mockResolvedValue({ available: true, version: "git version 2.43.0" })
      const requestBinaryReview = jest.fn()
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(detectBinary).toHaveBeenCalledWith("git")
      expect(requestBinaryReview).not.toHaveBeenCalled()
    })

    it("prompts the binary dialog when a required binary is missing", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest.fn().mockResolvedValue({ available: false, version: null })
      const requestBinaryReview = jest.fn().mockResolvedValue("proceed")
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      const result = await runMarketplaceInstall(opts)
      expect(requestBinaryReview).toHaveBeenCalledTimes(1)
      expect(requestBinaryReview.mock.calls[0][0]).toMatchObject({
        pluginId: "demo-plugin",
        missing: [expect.objectContaining({ name: "git", minVersion: "2.0.0" })],
      })
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
    })

    it("treats a below-minVersion binary as missing", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest
        .fn()
        .mockResolvedValue({ available: true, version: "git version 1.9.0" })
      const requestBinaryReview = jest.fn().mockResolvedValue("proceed")
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      await runMarketplaceInstall(opts)
      expect(requestBinaryReview).toHaveBeenCalledTimes(1)
      expect(requestBinaryReview.mock.calls[0][0].missing[0]).toMatchObject({
        name: "git",
        detectedVersion: "git version 1.9.0",
      })
    })

    it("cancels at binary-requirements when the user backs out", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest.fn().mockResolvedValue({ available: false, version: null })
      const requestBinaryReview = jest.fn().mockResolvedValue("cancel")
      const opts = makeOpts({ client, detectBinary, requestBinaryReview })

      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "cancelled", stage: "binary-requirements" })
      expect(client.installPlugin).not.toHaveBeenCalled()
    })

    it("blocks the install when no binary-review UI is wired and a binary is missing", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({ manifest: manifestWithBinary(), name: "Demo" }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const detectBinary = jest.fn().mockResolvedValue({ available: false, version: null })
      const opts = makeOpts({ client, detectBinary })
      // requestBinaryReview intentionally omitted.

      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "cancelled", stage: "binary-requirements" })
      expect(client.installPlugin).not.toHaveBeenCalled()
    })
  })

  describe("dependency requirements (Step 1.5)", () => {
    const clientWithDeps = (dependencies: Record<string, string>) => ({
      getPlugin: jest
        .fn()
        .mockResolvedValue({ manifest: makeManifest({ dependencies } as never), name: "Demo" }),
      installPlugin: jest.fn().mockResolvedValue({ success: true }),
    })

    it("blocks when a required dependency is missing and no review UI is wired", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0" })
      const opts = makeOpts({
        client,
        checkInstalledPlugin: jest.fn().mockResolvedValue(null), // not installed
      })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "cancelled", stage: "dependencies" })
      expect(client.installPlugin).not.toHaveBeenCalled()
    })

    it("surfaces missing + conflicting deps to the review callback", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0", "dep-b": "^2.0.0" })
      const requestDependencyReview = jest.fn().mockResolvedValue("cancel")
      const checkInstalledPlugin = jest.fn(async (id: string) =>
        id === "dep-b" ? { version: "1.5.0" } : null
      )
      const opts = makeOpts({ client, requestDependencyReview, checkInstalledPlugin })
      const result = await runMarketplaceInstall(opts)

      expect(result).toEqual({ status: "cancelled", stage: "dependencies" })
      const payload = requestDependencyReview.mock.calls[0][0] as {
        missing: string[]
        conflicts: Array<{ pluginId: string; required: string; available: string }>
      }
      expect(payload.missing).toEqual(["dep-a"])
      expect(payload.conflicts).toEqual([
        { pluginId: "dep-b", required: "^2.0.0", available: "1.5.0" },
      ])
    })

    it("rechecks rather than bypassing unmet dependencies when the user continues", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0" })
      const opts = makeOpts({
        client,
        checkInstalledPlugin: jest.fn().mockResolvedValue(null),
        requestDependencyReview: jest
          .fn()
          .mockResolvedValueOnce("continue")
          .mockResolvedValue("cancel"),
      })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "cancelled", stage: "dependencies" })
      expect(client.installPlugin).not.toHaveBeenCalled()
      expect(opts.requestDependencyReview).toHaveBeenLastCalledWith(
        expect.objectContaining({ unresolved: true })
      )
    })

    it("does not gate when every required dependency is satisfied", async () => {
      const client = clientWithDeps({ "dep-a": "^1.0.0" })
      const requestDependencyReview = jest.fn()
      const opts = makeOpts({
        client,
        requestDependencyReview,
        checkInstalledPlugin: jest.fn().mockResolvedValue({ version: "1.4.0" }),
      })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(requestDependencyReview).not.toHaveBeenCalled()
    })

    it("ignores optionalDependencies (only required `dependencies` gate)", async () => {
      const client = {
        getPlugin: jest.fn().mockResolvedValue({
          manifest: makeManifest({ optionalDependencies: { "opt-a": "^1.0.0" } } as never),
          name: "Demo",
        }),
        installPlugin: jest.fn().mockResolvedValue({ success: true }),
      }
      const requestDependencyReview = jest.fn()
      const checkInstalledPlugin = jest.fn().mockResolvedValue(null)
      const opts = makeOpts({ client, requestDependencyReview, checkInstalledPlugin })
      const result = await runMarketplaceInstall(opts)
      expect(result).toEqual({ status: "installed", pluginId: "demo-plugin" })
      expect(requestDependencyReview).not.toHaveBeenCalled()
      expect(checkInstalledPlugin).not.toHaveBeenCalled()
    })
  })

  it("resolves dependencies through their own consent/config chain before installing the target", async () => {
    const installed = new Map<string, { version: string }>()
    const events: string[] = []
    const dependencyClient = {
      getPlugin: jest.fn(async (id: string) => ({
        manifest: makeManifest({
          id,
          version: "2.1.0",
          permissions: ["network:fetch"],
          configSchema: { type: "object", properties: { url: { type: "string" } } },
        }),
      })),
      getVersions: jest.fn(async () => [{ version: "1.0.0" }, { version: "2.1.0" }]),
      supportsTransactionalConfig: true,
      installPlugin: jest.fn(async (id: string) => {
        installed.set(id, { version: "2.1.0" })
        events.push(`install:${id}`)
      }),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({ dependencies: { dep: "^2.0.0" } }),
        })),
        installPlugin: jest.fn(async () => {
          events.push("install:target")
        }),
      },
      dependencyClient,
      checkInstalledPlugin: async (id) => installed.get(id) ?? null,
      requestDependencyReview: jest.fn(async () => "resolve"),
      requestPermissionReview: jest.fn(async (payload) => {
        events.push(`permission:${payload.pluginId}`)
        return "approve"
      }),
      requestConfig: jest.fn(async (payload) => {
        events.push(`config:${payload.pluginId}`)
        return { result: "save" as const, value: { url: "example" } }
      }),
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(events).toEqual(["permission:dep", "config:dep", "install:dep", "install:target"])
    expect(dependencyClient.installPlugin).toHaveBeenCalledWith("dep", "2.1.0", {
      config: { url: "example" },
    })
  })

  it("does not select a dependency version that breaks another installed consumer", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "consumer",
        manifest: makeManifest({ id: "consumer", dependencies: { dep: "^1.0.0" } }),
      },
    ])
    const dependencyClient = {
      getPlugin: jest.fn(async () => ({ manifest: makeManifest({ id: "dep", version: "2.0.0" }) })),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({ dependencies: { dep: "^2.0.0" } }),
        })),
        installPlugin: jest.fn(),
      },
      dependencyClient,
      checkInstalledPlugin: jest.fn(async () => null),
      requestDependencyReview: jest.fn(async () => "resolve"),
    })
    expect(await runMarketplaceInstall(opts)).toMatchObject({
      status: "failed",
      stage: "dependencies",
    })
    expect(dependencyClient.installPlugin).not.toHaveBeenCalled()
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })

  it("restores explicitly disabled competitors when later permission review is cancelled", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other",
        enabled: true,
        manifest: makeManifest({ id: "other", commands: [{ id: "cmd", name: "Cmd" }] }),
      },
    ])
    const restore = jest.fn(async () => undefined)
    const resolveConflictingPlugins = jest.fn(async () => restore)
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({
            commands: [{ id: "cmd", name: "Cmd" }],
            permissions: ["network:fetch"],
          }),
        })),
        installPlugin: jest.fn(),
      },
      requestConflictReview: jest.fn(async () => "disable-conflicting"),
      requestPermissionReview: jest.fn(async () => "cancel"),
      resolveConflictingPlugins,
    })
    expect(await runMarketplaceInstall(opts)).toEqual({ status: "cancelled", stage: "permission" })
    expect(resolveConflictingPlugins).toHaveBeenCalledWith(["other"])
    expect(restore).toHaveBeenCalledTimes(1)
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })

  it("disposes the reviewed package on cancellation and never installs it", async () => {
    const prepared = {
      manifest: makeManifest({ permissions: ["network:fetch"] }),
      install: jest.fn(),
      dispose: jest.fn(async () => undefined),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(),
        preparePlugin: jest.fn(async () => prepared),
        installPlugin: jest.fn(),
      },
      requestPermissionReview: jest.fn(async () => "cancel"),
    })
    expect(await runMarketplaceInstall(opts)).toEqual({ status: "cancelled", stage: "permission" })
    expect(prepared.install).not.toHaveBeenCalled()
    expect(prepared.dispose).toHaveBeenCalledTimes(1)
  })

  it("does not offer to disable other theme providers for an informational overlap", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "theme",
        enabled: true,
        manifest: makeManifest({ id: "theme", capabilities: ["themes"] }),
      },
    ])
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({ manifest: makeManifest({ capabilities: ["themes"] }) })),
        installPlugin: jest.fn(),
      },
    })
    await runMarketplaceInstall(opts)
    expect(opts.requestConflictReview).toHaveBeenCalledWith(
      expect.objectContaining({ conflictingPluginIds: [] })
    )
  })

  it("refuses a manifest for a different selected version", async () => {
    const opts = makeOpts({ version: "9.0.0" })
    expect(await runMarketplaceInstall(opts)).toMatchObject({
      status: "failed",
      message: "reviewIdentityMismatch",
    })
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })

  it("rejects dependency cycles before any package is installed", async () => {
    const dependencyClient = {
      getPlugin: jest.fn(async (id: string) => ({
        manifest: makeManifest({ id, dependencies: { "demo-plugin": "*" } }),
      })),
      installPlugin: jest.fn(),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({ dependencies: { dep: "*" } }),
        })),
        installPlugin: jest.fn(),
      },
      dependencyClient,
      checkInstalledPlugin: async () => null,
      requestDependencyReview: async () => "resolve",
    })
    expect(await runMarketplaceInstall(opts)).toMatchObject({
      status: "failed",
      stage: "dependencies",
      message: "dependencyCycle",
    })
    expect(dependencyClient.installPlugin).not.toHaveBeenCalled()
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })

  it("restores competitors disabled by a successful dependency if a later dependency is cancelled", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "other",
        enabled: true,
        manifest: makeManifest({ id: "other", commands: [{ id: "cmd", name: "Cmd" }] }),
      },
    ])
    const installed = new Map<string, { version: string }>()
    const restore = jest.fn(async () => undefined)
    const dependencyClient = {
      getPlugin: jest.fn(async (id: string) => ({
        manifest: makeManifest({
          id,
          ...(id === "b"
            ? { commands: [{ id: "cmd", name: "Cmd" }] }
            : { permissions: ["network:fetch"] }),
        }),
      })),
      installPlugin: jest.fn(async (id: string) => {
        installed.set(id, { version: "1.0.0" })
      }),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({ dependencies: { b: "*", c: "*" } }),
        })),
        installPlugin: jest.fn(),
      },
      dependencyClient,
      checkInstalledPlugin: async (id) => installed.get(id) ?? null,
      requestDependencyReview: async () => "resolve",
      requestConflictReview: async () => "disable-conflicting",
      requestPermissionReview: async () => "cancel",
      resolveConflictingPlugins: async () => restore,
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "cancelled",
      stage: "dependencies",
    })
    expect(dependencyClient.installPlugin).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })

  it("restores the incumbent's actual tool ownership after a child update is cancelled later", async () => {
    const registry = new PluginRegistry()
    const tool = (id: string) => ({
      name: "shared_tool",
      pluginId: id,
      definition: { name: "shared_tool", description: "Shared", parametersSchema: {} },
      execute: jest.fn(),
    })
    registry.registerTool("other", tool("other"))
    listPlugins.mockResolvedValue([
      {
        id: "other",
        enabled: true,
        manifest: makeManifest({ id: "other", commands: [{ id: "cmd", name: "Cmd" }] }),
      },
    ])
    const installed = new Map<string, { version: string }>()
    const { manager, statuses } = lifecycleManager([])
    manager.disablePlugin.mockImplementation(async (id: string) => {
      statuses.set(id, "disabled")
      registry.unregisterPluginTools(id)
    })
    manager.enablePlugin.mockImplementation(async (id: string) => {
      statuses.set(id, "enabled")
      registry.registerTool(id, tool(id))
    })
    const dependencyClient = {
      getPlugin: jest.fn(async (id: string) => ({
        manifest: makeManifest({
          id,
          ...(id === "b"
            ? { commands: [{ id: "cmd", name: "Cmd" }] }
            : { permissions: ["network:fetch"] }),
        }),
      })),
      installPlugin: jest.fn(async (id: string) => {
        installed.set(id, { version: "1.0.0" })
        statuses.set(id, "enabled")
        registry.registerTool(id, tool(id))
      }),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({ dependencies: { b: "*", c: "*" } }),
        })),
        installPlugin: jest.fn(),
      },
      dependencyClient,
      checkInstalledPlugin: async (id) => installed.get(id) ?? null,
      requestDependencyReview: async () => "resolve",
      requestConflictReview: async () => "disable-conflicting",
      requestPermissionReview: async () => "cancel",
      resolveConflictingPlugins: async () => {
        registry.unregisterPluginTools("other")
        return async () => {
          registry.registerTool("other", tool("other"))
        }
      },
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "cancelled",
      stage: "dependencies",
    })
    expect(registry.getTool("shared_tool")?.pluginId).toBe("other")
  })

  it("pauses compatible active consumers and resumes them after dependency replacement", async () => {
    listPlugins.mockResolvedValue([
      {
        id: "consumer",
        enabled: true,
        manifest: makeManifest({ id: "consumer", dependencies: { dep: "^1.0.0" } }),
      },
    ])
    let version = "0.5.0"
    const restore = jest.fn(async () => undefined)
    const resolve = jest.fn(async () => restore)
    const dependencyClient = {
      getPlugin: jest.fn(async () => ({ manifest: makeManifest({ id: "dep", version: "1.2.0" }) })),
      installPlugin: jest.fn(async () => {
        version = "1.2.0"
      }),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({ dependencies: { dep: "^1.0.0" } }),
        })),
        installPlugin: jest.fn(),
      },
      dependencyClient,
      checkInstalledPlugin: async () => ({ version }),
      requestDependencyReview: async () => "resolve",
      resolveConflictingPlugins: resolve,
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(resolve).toHaveBeenCalledWith(["consumer"])
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it("preserves paused consumer ownership on success even when dependency activation runs first", async () => {
    const registry = new PluginRegistry()
    const tool = (id: string) => ({
      name: "shared_tool",
      pluginId: id,
      definition: { name: "shared_tool", description: "Shared", parametersSchema: {} },
      execute: jest.fn(),
    })
    registry.registerTool("consumer", tool("consumer"))
    let version = "0.5.0"
    const statuses = new Map([
      ["consumer", "enabled"],
      ["dep", "enabled"],
    ])
    const consumer = makeManifest({
      id: "consumer",
      dependencies: { dep: ">=0.5.0 <2.0.0" },
      tools: [tool("consumer").definition],
    })
    listPlugins.mockImplementation(async () => [
      { id: "consumer", enabled: statuses.get("consumer") === "enabled", manifest: consumer },
    ])
    const manager = {
      getPlugin: (id: string) => ({ status: statuses.get(id) }),
      disablePlugin: async (id: string) => {
        statuses.set(id, "disabled")
        registry.unregisterPluginTools(id)
      },
      enablePlugin: async (id: string) => {
        // Real manager enables dependencies before registering their consumer.
        if (id === "consumer") registry.registerTool("dep", tool("dep"))
        statuses.set(id, "enabled")
        registry.registerTool(id, tool(id))
      },
    }
    jest.mocked(getPluginManager).mockReturnValue(manager as never)
    const dependencyClient = {
      getPlugin: jest.fn(async () => ({
        manifest: makeManifest({ id: "dep", version: "1.2.0", tools: [tool("dep").definition] }),
      })),
      installPlugin: jest.fn(async () => {
        version = "1.2.0"
        registry.registerTool("dep", tool("dep"))
      }),
    }
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({ dependencies: { dep: "^1.0.0" } }),
        })),
        installPlugin: jest.fn(),
      },
      dependencyClient,
      checkInstalledPlugin: async () => ({ version }),
      requestDependencyReview: async () => "resolve",
      resolveConflictingPlugins: async (ids) => {
        for (const id of ids) await manager.disablePlugin(id)
        return async () => {
          for (const id of ids) await manager.enablePlugin(id)
        }
      },
    })
    expect(await runMarketplaceInstall(opts)).toEqual({
      status: "installed",
      pluginId: "demo-plugin",
    })
    expect(opts.requestConflictReview).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "dep" })
    )
    expect(registry.getTool("shared_tool")?.pluginId).toBe("consumer")
  })

  it("rechecks dependencies after permission review and refuses changed versions", async () => {
    let version = "1.0.0"
    const opts = makeOpts({
      client: {
        getPlugin: jest.fn(async () => ({
          manifest: makeManifest({
            dependencies: { dep: "^1.0.0" },
            permissions: ["network:fetch"],
          }),
        })),
        installPlugin: jest.fn(),
      },
      checkInstalledPlugin: async () => ({ version }),
      requestPermissionReview: async () => {
        version = "2.0.0"
        return "approve"
      },
    })
    expect(await runMarketplaceInstall(opts)).toMatchObject({
      status: "failed",
      stage: "dependencies",
      message: "dependenciesChanged",
    })
    expect(opts.client.installPlugin).not.toHaveBeenCalled()
  })
})
