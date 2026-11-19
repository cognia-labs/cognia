/** @jest-environment node */

import type { DiskPluginEntry } from "../plugin/host"
import type { PluginGraphReservation } from "@/lib/plugin/core/lifecycle-coordinator"
import type { PluginIntent } from "@/lib/plugin/core/lifecycle-state"
import { contractViolations, scenariosFor } from "@/lib/plugin/lifecycle/contract"
import {
  __resetExpectedRuntimeEventsForTests,
  expectRuntimeEvent,
  provideHeadlessPackageRegistration,
} from "@/lib/plugin/lifecycle/host-package-change"
import { runtimeResumeStateOf, type RuntimeResumeState } from "@/lib/plugin/lifecycle/runtime-state"
import type { PluginManifest } from "@/types/plugin"
import type { VsCodeActivationEvent } from "@/types/plugin/plugin-vscode"
import { createNodePluginRuntimeAdapter } from "./plugin-runtime-adapter"

const withdrawRegistration = jest.fn()
jest.mock("@/lib/plugin/lifecycle/host-package-change", () => ({
  ...jest.requireActual("@/lib/plugin/lifecycle/host-package-change"),
  provideHeadlessPackageRegistration: jest.fn(() => withdrawRegistration),
}))

const manifest = {
  id: "demo",
  name: "Demo",
  description: "Demo plugin",
  version: "1.0.0",
  type: "frontend" as const,
  main: "index.js",
  capabilities: [],
}

type FakeStatus = "installed" | "loaded" | "enabled" | "disabled" | "suspended"

/**
 * A manager whose status moves the way the real lifecycle's does, so a test
 * can read the runtime state a reconcile left behind.
 */
function fakeManager(
  initial: { status: FakeStatus; version: string } | undefined,
  intent: PluginIntent = "auto"
) {
  const state: { status: FakeStatus | undefined; registered: string | undefined } = {
    status: initial?.status,
    registered: initial?.version,
  }
  const events: string[] = []
  const manager = {
    events,
    state,
    registerDiskPlugin: jest.fn(async (registered: PluginManifest) => {
      events.push(`register@${registered.version}`)
      state.registered = registered.version
      if (state.status === undefined) state.status = "installed"
    }),
    getPlugin: jest.fn((_id: string) =>
      state.status === undefined ? undefined : { status: state.status }
    ),
    getPluginLifecycleState: jest.fn(async (_id: string) => ({ intent })),
    loadPlugin: jest.fn(async (_id: string) => {
      events.push("load")
      state.status = "loaded"
    }),
    enablePlugin: jest.fn(async (_id: string, _reason?: string) => {
      events.push("enable")
      state.status = "enabled"
    }),
    disablePlugin: jest.fn(async (_id: string, _reason?: string) => {
      events.push("disable")
      state.status = "disabled"
    }),
    suspendPlugin: jest.fn(async (_id: string, _reason?: string) => {
      events.push("suspend")
      state.status = "suspended"
    }),
    unloadPlugin: jest.fn(async (_id: string) => {
      events.push("unload")
      if (state.status !== undefined) state.status = "installed"
    }),
    reservePluginRuntimeGraph: jest.fn(() => ({}) as PluginGraphReservation),
    releasePluginRuntimeGraph: jest.fn(() => true),
    withPluginPackageMutation: <T>(_id: string, operation: () => Promise<T>): Promise<T> =>
      operation(),
  }
  return manager
}

function harness(
  entry: DiskPluginEntry | null = { id: "demo", dir: "/data/demo", manifest, supported: true },
  manager = fakeManager({ status: "enabled", version: "1.0.0" })
) {
  const store = {
    plugins: { demo: { status: "enabled" } } as Record<string, { status: string }>,
    uninstallPlugin: jest.fn(async () => undefined),
  }
  const dispose = jest.fn(async () => undefined)
  const adapter = createNodePluginRuntimeAdapter({
    ensure: async () => ({ ok: true, toolCount: 1 }),
    discover: async () => (entry ? [entry] : []),
    manager: async () => manager,
    store: async () => store,
    dispose,
  })
  return { adapter, manager, store, dispose }
}

beforeEach(() => {
  __resetExpectedRuntimeEventsForTests()
})

it("fails startup visibly when the canonical PluginManager cannot boot", async () => {
  const adapter = createNodePluginRuntimeAdapter({
    ensure: async () => ({ ok: false, toolCount: 0, error: "indexeddb unavailable" }),
  })
  await expect(adapter.start()).rejects.toThrow("indexeddb unavailable")
})

it("registers and activates persisted WASM plugins during brain startup", async () => {
  const wasmEntry: DiskPluginEntry = {
    id: "demo",
    dir: "/data/demo",
    manifest: {
      ...manifest,
      type: "wasm",
      main: undefined,
      wasmMain: "plugin.wasm",
      wasm: { apiVersion: "0.1.0" },
      runtimeCompatibility: { tauri: { availability: "supported" } },
    },
    supported: false,
  }
  const { adapter, manager } = harness(wasmEntry, fakeManager(undefined))

  await adapter.start()

  expect(manager.registerDiskPlugin).toHaveBeenCalledWith(wasmEntry.manifest, "/data/demo")
  expect(manager.enablePlugin).toHaveBeenCalledWith("demo", "headless-reconcile")
  expect(manager.state.status).toBe("enabled")
})

it.each([
  {
    type: "python" as const,
    manifest: {
      ...manifest,
      type: "python" as const,
      main: undefined,
      pythonMain: "main.py",
      runtimeCompatibility: { tauri: { availability: "supported" as const } },
    },
  },
  {
    type: "hybrid" as const,
    manifest: {
      ...manifest,
      type: "hybrid" as const,
      pythonMain: "main.py",
      runtimeCompatibility: { tauri: { availability: "supported" as const } },
    },
  },
  {
    type: "vscode-extension" as const,
    manifest: {
      ...manifest,
      type: "vscode-extension" as const,
      main: undefined,
      vscodeMain: "extension.js",
      vscodeExtension: {
        identifier: "demo",
        version: "1.0.0",
        engineVscode: ">=1.90.0",
        vsixSha256: "a".repeat(64),
        source: "vsix-upload" as const,
        bundleFormat: "cjs" as const,
        activationEvents: ["*" as VsCodeActivationEvent],
      },
      runtimeCompatibility: { tauri: { availability: "supported" as const } },
    },
  },
])("registers and activates persisted $type plugins during brain startup", async ({ manifest }) => {
  const entry: DiskPluginEntry = {
    id: "demo",
    dir: "/data/demo",
    manifest,
    supported: false,
  }
  const { adapter, manager } = harness(entry, fakeManager(undefined))

  await adapter.start()

  expect(manager.registerDiskPlugin).toHaveBeenCalledWith(entry.manifest, "/data/demo")
  expect(manager.enablePlugin).toHaveBeenCalledWith("demo", "headless-reconcile")
})

it("stops a running plugin, registers the package on disk, then brings it back", async () => {
  const { adapter, manager } = harness()
  await adapter.reconcile({ action: "restored", pluginId: "demo", accountId: "account-a" })
  expect(manager.events).toEqual(["disable", "unload", "register@1.0.0", "enable"])
  expect(manager.registerDiskPlugin).toHaveBeenCalledWith(manifest, "/data/demo")
})

it("never starts a plugin whose durable intent is disabled", async () => {
  const python: DiskPluginEntry = {
    id: "demo",
    dir: "/data/demo",
    manifest: { ...manifest, type: "python", main: undefined, pythonMain: "main.py" },
    supported: false,
  }
  const fresh = harness(python, fakeManager(undefined, "disabled"))
  await fresh.adapter.start()
  expect(fresh.manager.events).toEqual(["register@1.0.0"])
  expect(fresh.manager.enablePlugin).not.toHaveBeenCalled()

  const updated = harness(undefined, fakeManager({ status: "disabled", version: "0.9.0" }, "disabled"))
  await updated.adapter.reconcile({ action: "installed", pluginId: "demo" })
  expect(updated.manager.events).toEqual(["unload", "register@1.0.0"])
  expect(updated.manager.state.status).toBe("installed")
})

it("skips an event for a change this Host's own arm already applied", async () => {
  const { adapter, manager } = harness()
  expectRuntimeEvent("demo")
  await adapter.reconcile({ action: "installed", pluginId: "demo" })
  expect(manager.events).toEqual([])
  // Only that one event: the next is a change the brain has not seen.
  await adapter.reconcile({ action: "installed", pluginId: "demo" })
  expect(manager.events).toEqual(["disable", "unload", "register@1.0.0", "enable"])
})

it("lends the Host's own arm the brain's disk discovery while it runs", async () => {
  const { adapter, manager } = harness(undefined, fakeManager(undefined))
  await adapter.start()
  const provided = (provideHeadlessPackageRegistration as jest.Mock).mock.calls.at(-1)?.[0] as (
    pluginId: string
  ) => Promise<void>
  manager.events.length = 0
  await provided("demo")
  expect(manager.events).toEqual(["register@1.0.0"])
  await expect(provided("missing")).rejects.toThrow("manifest is missing")

  await adapter.stop?.()
  expect(withdrawRegistration).toHaveBeenCalledTimes(1)
})

describe("ADR-0258 contract: headless-reconcile", () => {
  const STATUS_OF: Record<RuntimeResumeState, FakeStatus> = {
    enabled: "enabled",
    suspended: "suspended",
    loaded: "loaded",
    stopped: "installed",
  }

  it.each(scenariosFor("headless-reconcile").map((scenario) => [scenario.id, scenario] as const))(
    "%s",
    async (_id, scenario) => {
      const disk = { ...manifest, version: "2.0.0" }
      const manager = fakeManager({ status: STATUS_OF[scenario.before], version: "1.0.0" })
      const { adapter } = harness(
        { id: "demo", dir: "/data/demo", manifest: disk, supported: true },
        manager
      )
      let outcome: "succeeded" | "failed" = "succeeded"
      await adapter.reconcile({ action: "installed", pluginId: "demo" }).catch(() => {
        outcome = "failed"
      })
      expect(
        contractViolations(
          scenario,
          { from: "1.0.0", to: "2.0.0" },
          {
            outcome,
            restartRequired: false,
            packageVersion: "2.0.0",
            recordedVersion: manager.state.registered,
            runtime: runtimeResumeStateOf(manager.state.status),
          }
        )
      ).toEqual([])
    }
  )
})

it("unloads and removes only the brain projection after native uninstall", async () => {
  const { adapter, manager, store } = harness()
  await adapter.reconcile({ action: "uninstalled", pluginId: "demo" })
  expect(manager.unloadPlugin).toHaveBeenCalledWith("demo")
  expect(store.uninstallPlugin).toHaveBeenCalledWith("demo", {
    skipFileRemoval: true,
    viaManager: false,
  })
})

it("unloads every active plugin in reverse registration order on shutdown", async () => {
  const { adapter, manager, store, dispose } = harness()
  store.plugins = {
    first: { status: "enabled" },
    dormant: { status: "installed" },
    last: { status: "disabled" },
  }
  await adapter.stop?.()
  expect(manager.unloadPlugin.mock.calls).toEqual([["last"], ["first"]])
  expect(dispose).toHaveBeenCalledTimes(1)
})

it("rejects a missing or unsupported installed manifest instead of silently degrading", async () => {
  const missing = harness(null)
  await expect(
    missing.adapter.reconcile({ action: "installed", pluginId: "demo" })
  ).rejects.toThrow("manifest is missing")

  const unsupported = harness({
    id: "demo",
    dir: "/data/demo",
    manifest: {
      ...manifest,
      // Forward-safety: a future isolated runtime must be explicitly wired
      // before the brain accepts it.
      type: "future-native" as never,
    },
    supported: false,
  })
  await expect(
    unsupported.adapter.reconcile({ action: "installed", pluginId: "demo" })
  ).rejects.toThrow('Plugin type "future-native" is unavailable')
})

it("isolates one native plugin activation failure and continues booting other plugins", async () => {
  const entries: DiskPluginEntry[] = ["broken", "healthy"].map((id) => ({
    id,
    dir: `/data/${id}`,
    supported: false,
    manifest: { ...manifest, id, type: "python", pythonMain: "main.py" },
  }))
  const enablePlugin = jest.fn(async (id: string) => {
    if (id === "broken") throw new Error("plugin activation failed")
  })
  const adapter = createNodePluginRuntimeAdapter({
    ensure: async () => ({ ok: true, toolCount: 0 }),
    discover: async () => entries,
    manager: async () => ({ ...fakeManager(undefined), enablePlugin }),
    store: async () => ({ plugins: {}, uninstallPlugin: jest.fn() }),
  })
  await expect(adapter.start()).resolves.toBeUndefined()
  expect(enablePlugin.mock.calls).toEqual([
    ["broken", "headless-reconcile"],
    ["healthy", "headless-reconcile"],
  ])
})
