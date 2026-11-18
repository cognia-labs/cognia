/**
 * Adapter mapping the real `PluginManager` singleton + plugin store to the
 * `HostManager` interface the host helpers (`host.ts`) consume. Kept thin and
 * fully injectable so the host helpers stay pure and this wiring is isolated.
 */
import type { HostManager } from "./host"
import type { PluginGraphReservation } from "@/lib/plugin/core/lifecycle-coordinator"
import type { PluginManifest } from "@/types/plugin"

/** The lifecycle slice of `PluginManager` the host needs. */
export interface ManagerLike {
  registerDiskPlugin: (manifest: PluginManifest, dir: string) => Promise<void>
  loadPlugin: (id: string) => Promise<void>
  enablePlugin: (id: string, reason?: string) => Promise<void>
  disablePlugin: (id: string, reason?: string) => Promise<void>
  suspendPlugin: (id: string, reason?: string) => Promise<void>
  setPluginIntent: (id: string, intent: "enabled" | "disabled", reason?: string) => Promise<void>
  unloadPlugin: (id: string) => Promise<void>
  reloadPlugin: (id: string, reason?: string) => Promise<void>
  withPluginPackageMutation: <T>(id: string, operation: () => Promise<T>) => Promise<T>
  reservePluginRuntimeGraph: (id: string) => PluginGraphReservation
  releasePluginRuntimeGraph: (reservation: PluginGraphReservation) => boolean
}

/** A plugin row as held in the runtime store (`usePluginStore`). */
export interface StorePlugin {
  manifest: PluginManifest
  path: string
  status: string
}

export interface HostManagerDeps {
  manager: ManagerLike
  /** Snapshot of the runtime store's plugin map. */
  getPlugins: () => Record<string, StorePlugin>
}

export function makeHostManager(deps: HostManagerDeps): HostManager {
  return {
    registerDiskPlugin: (m, dir) => deps.manager.registerDiskPlugin(m, dir),
    loadPlugin: (id) => deps.manager.loadPlugin(id),
    enablePlugin: (id, reason) => deps.manager.enablePlugin(id, reason),
    disablePlugin: (id, reason) => deps.manager.disablePlugin(id, reason),
    suspendPlugin: (id, reason) => deps.manager.suspendPlugin(id, reason),
    setPluginIntent: (id, intent) => deps.manager.setPluginIntent(id, intent, "cli-command"),
    unloadPlugin: (id) => deps.manager.unloadPlugin(id),
    reloadPlugin: (id, reason) => deps.manager.reloadPlugin(id, reason),
    withPluginPackageMutation: (id, operation) =>
      deps.manager.withPluginPackageMutation(id, operation),
    reservePluginRuntimeGraph: (id) => deps.manager.reservePluginRuntimeGraph(id),
    releasePluginRuntimeGraph: (reservation) => {
      deps.manager.releasePluginRuntimeGraph(reservation)
    },
    list: () =>
      Object.values(deps.getPlugins()).map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        type: p.manifest.type,
        path: p.path,
        status: p.status,
        tools: Array.isArray(p.manifest.tools) ? p.manifest.tools : [],
      })),
  }
}
