/** Node adapter for the headless PluginManager lifecycle. */

import { loggers } from "@cognia/logging"

import type { HeadlessPluginRuntimeAdapter } from "@/lib/headless/types"
import type { PluginGraphReservation } from "@/lib/plugin/core/lifecycle-coordinator"
import type { PluginIntent } from "@/lib/plugin/core/lifecycle-state"
import {
  provideHeadlessPackageRegistration,
  takeExpectedRuntimeEvent,
} from "@/lib/plugin/lifecycle/host-package-change"
import { packageOwnerOf, replacePluginPackage } from "@/lib/plugin/lifecycle/replace-package"
import type { PluginManifest, PluginStatus } from "@/types/plugin"

import { defaultDiscoverDiskPlugins, type DiskPluginEntry } from "../plugin/host"
import {
  ensurePluginRuntime,
  pluginDiscoveryRoots,
  type PluginRuntimeResult,
} from "../plugin/plugin-runtime"

interface PluginManagerLifecycle {
  registerDiskPlugin(manifest: PluginManifest, dir: string): Promise<void>
  getPlugin(id: string): { status: PluginStatus } | undefined
  getPluginLifecycleState(id: string): Promise<{ intent: PluginIntent }>
  loadPlugin(id: string): Promise<void>
  enablePlugin(id: string, reason?: string): Promise<void>
  disablePlugin(id: string, reason?: string): Promise<void>
  suspendPlugin(id: string, reason?: string): Promise<void>
  unloadPlugin(id: string): Promise<void>
  reservePluginRuntimeGraph(id: string): PluginGraphReservation
  releasePluginRuntimeGraph(reservation: PluginGraphReservation): unknown
  withPluginPackageMutation<T>(id: string, operation: () => Promise<T>): Promise<T>
}

interface PluginStoreLifecycle {
  plugins: Record<string, { status: string }>
  uninstallPlugin(
    id: string,
    options: { skipFileRemoval: boolean; viaManager: boolean }
  ): Promise<void>
}

function isRunnableInNodeBrain(entry: DiskPluginEntry): boolean {
  return (
    entry.supported ||
    entry.manifest.type === "wasm" ||
    entry.manifest.type === "python" ||
    entry.manifest.type === "hybrid" ||
    entry.manifest.type === "vscode-extension"
  )
}

export interface NodePluginRuntimeDeps {
  ensure?: () => Promise<PluginRuntimeResult>
  discover?: () => Promise<DiskPluginEntry[]>
  manager?: () => Promise<PluginManagerLifecycle>
  store?: () => Promise<PluginStoreLifecycle>
  dispose?: () => Promise<void> | void
}

async function defaultManager(): Promise<PluginManagerLifecycle> {
  const { getPluginManager } = await import("@/lib/plugin/core/manager")
  return getPluginManager()
}

async function defaultStore(): Promise<PluginStoreLifecycle> {
  const { usePluginStore } = await import("@/stores/plugin-runtime")
  return usePluginStore.getState() as PluginStoreLifecycle
}

async function defaultDispose(): Promise<void> {
  const { disposePluginManager } = await import("@/lib/plugin/core/manager")
  disposePluginManager()
}

/**
 * Bind cognia-server's native disk lifecycle to the already-canonical Node
 * PluginManager (ADR-0258 §4, headless Host reconcile).
 *
 * A `plugin://runtime-changed` event reports a package that already changed on
 * disk, so reconciling is a replacement whose commit is done: through the one
 * replacement every environment shares, the plugin is stopped, the manifest on
 * disk registered, and the plugin brought back to the state it was in. A
 * plugin new to the brain starts; one whose durable intent is disabled stays
 * stopped either way. An event for a change this Host's own arm already
 * applied (`host-package-change.ts`) is skipped. Uninstalls unload
 * contributions before removing the store projection.
 */
export function createNodePluginRuntimeAdapter(
  deps: NodePluginRuntimeDeps = {}
): HeadlessPluginRuntimeAdapter {
  const getManager = deps.manager ?? defaultManager
  const getStore = deps.store ?? defaultStore
  const dispose = deps.dispose ?? defaultDispose
  const discover =
    deps.discover ?? (() => defaultDiscoverDiskPlugins(pluginDiscoveryRoots(process.env)))
  let withdrawRegistration: (() => void) | undefined

  /** The disk entry for `pluginId`, refused when the Node brain cannot run it. */
  const runnableEntry = async (pluginId: string): Promise<DiskPluginEntry> => {
    const entry = (await discover()).find((candidate) => candidate.id === pluginId)
    if (!entry) {
      throw new Error(`Installed plugin manifest is missing: ${pluginId}`)
    }
    if (!isRunnableInNodeBrain(entry)) {
      throw new Error(
        `Plugin type "${entry.manifest.type}" is unavailable in the Node brain: ${pluginId}`
      )
    }
    return entry
  }

  const register = async (pluginId: string): Promise<void> => {
    const entry = await runnableEntry(pluginId)
    await (await getManager()).registerDiskPlugin(entry.manifest, entry.dir)
  }

  const reconcile = async (change: Parameters<HeadlessPluginRuntimeAdapter["reconcile"]>[0]) => {
    if (takeExpectedRuntimeEvent(change.pluginId)) return
    const manager = await getManager()
    const store = await getStore()
    const existing = store.plugins[change.pluginId]

    if (change.action === "uninstalled") {
      if (!existing) return
      await manager.unloadPlugin(change.pluginId)
      await store.uninstallPlugin(change.pluginId, {
        skipFileRemoval: true,
        viaManager: false,
      })
      return
    }

    const entry = await runnableEntry(change.pluginId)
    await replacePluginPackage(packageOwnerOf(manager), {
      pluginId: change.pluginId,
      // The package on disk already changed; only the runtime is left.
      commit: async () => undefined,
      register: () => manager.registerDiskPlugin(entry.manifest, entry.dir),
      whenNew: "enabled",
      reason: "headless-reconcile",
    })
  }

  return {
    async start() {
      const result = await (deps.ensure ?? ensurePluginRuntime)()
      if (!result.ok) {
        throw new Error(result.error || "PluginManager bootstrap failed")
      }
      withdrawRegistration = provideHeadlessPackageRegistration(register)
      // The shared CLI bootstrap already registers frontend entries. Native
      // entries were intentionally skipped by its standalone-CLI filter. In
      // the supervised brain the service transport provides their real
      // WASM/Python hosts, so project and activate them now. Hybrid is included
      // because both halves transition through one PluginManager lifecycle.
      for (const entry of await discover()) {
        if (
          entry.manifest.type === "wasm" ||
          entry.manifest.type === "python" ||
          entry.manifest.type === "hybrid" ||
          entry.manifest.type === "vscode-extension"
        ) {
          try {
            await reconcile({ action: "installed", pluginId: entry.id })
          } catch (error) {
            loggers.plugin.error(`Headless plugin activation failed: ${entry.id}`, error)
          }
        }
      }
    },

    reconcile,

    async stop() {
      const manager = await getManager()
      const store = await getStore()
      const activeIds = Object.entries(store.plugins)
        .filter(([, plugin]) => plugin.status !== "installed")
        .map(([id]) => id)
        .reverse()
      withdrawRegistration?.()
      withdrawRegistration = undefined
      try {
        for (const id of activeIds) {
          await manager.unloadPlugin(id)
        }
      } finally {
        await dispose()
      }
    },
  }
}
