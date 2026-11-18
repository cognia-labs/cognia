/**
 * CLI plugin host. Unifies disk plugins (`~/.cognia/plugins/<id>`) onto the same
 * PluginManager the CLI already bootstraps for builtins, so their tools reach
 * the model and lifecycle (enable / disable / reload / uninstall) is real.
 *
 * All manager interaction goes through the injected {@link HostManager} so these
 * helpers stay pure and unit-testable; the real adapter lives in `host-manager.ts`.
 */
import nodeFsPromises from "node:fs/promises"
import path from "node:path"
import { releaseAuthProviderOwnership } from "@/lib/plugin/auth/auth-provider-registry"
import {
  quiesceRuntime,
  restoreRuntimeState,
  runtimeResumeStateOf,
} from "@/lib/plugin/lifecycle/runtime-state"
import type { PluginGraphReservation } from "@/lib/plugin/core/lifecycle-coordinator"

import { discoverPlugins, type PluginFs } from "./discover-plugins"
import type { StagedInstall } from "./install"
import type { PluginManifest } from "@/types/plugin"

export type PluginOrigin = "builtin" | "disk" | "marketplace"

export interface HostPluginRow {
  id: string
  name: string
  version: string
  type: string
  origin: PluginOrigin
  status: string
  toolCount: number
}

/** A disk plugin resolved to its full manifest, ready to register. */
export interface DiskPluginEntry {
  id: string
  dir: string
  manifest: PluginManifest
  /** Whether the CLI can run it (frontend/JS only). */
  supported: boolean
}

/** Minimal manager surface the host needs. Real impl wraps `getPluginManager()`. */
export interface HostManager {
  registerDiskPlugin: (manifest: PluginManifest, dir: string) => Promise<void>
  loadPlugin: (id: string) => Promise<void>
  enablePlugin: (id: string, reason?: string) => Promise<void>
  disablePlugin: (id: string, reason?: string) => Promise<void>
  suspendPlugin: (id: string, reason?: string) => Promise<void>
  setPluginIntent: (id: string, intent: "enabled" | "disabled") => Promise<void>
  unloadPlugin: (id: string) => Promise<void>
  /** The manager's reload: quiesce, unload, and return to the state it was in. */
  reloadPlugin: (id: string, reason: string) => Promise<void>
  /** Serialize package I/O with activation of the same plugin. */
  withPluginPackageMutation: <T>(id: string, operation: () => Promise<T>) => Promise<T>
  reservePluginRuntimeGraph: (id: string) => PluginGraphReservation
  releasePluginRuntimeGraph: (reservation: PluginGraphReservation) => void
  list: () => Array<{
    id: string
    name: string
    version: string
    type: string
    path: string
    status: string
    tools?: unknown[]
  }>
}

export interface RegisterDeps {
  manager: HostManager
  /** Resolve disk plugins to full manifests. Default: {@link defaultDiscoverDiskPlugins}. */
  discover: () => Promise<DiskPluginEntry[]>
  /** Plugin ids the CLI `/plugin disable` overlay marks off. */
  disabled: Set<string>
  notify: (message: string) => void
}

function originOf(pluginPath: string): PluginOrigin {
  return pluginPath.startsWith("builtin://") ? "builtin" : "disk"
}

/**
 * Register disk plugins into the manager, then load + enable each supported one
 * not in the disabled set. Best-effort: a bad plugin is reported via `notify`
 * and skipped so the rest (and chat) keep working.
 */
export async function registerDiskPlugins(deps: RegisterDeps): Promise<void> {
  for (const entry of await deps.discover()) {
    if (!entry.supported) continue
    try {
      await deps.manager.registerDiskPlugin(entry.manifest, entry.dir)
      if (!deps.disabled.has(entry.id)) {
        await deps.manager.loadPlugin(entry.id)
        await deps.manager.enablePlugin(entry.id)
      }
    } catch (err) {
      deps.notify(
        `Plugin "${entry.id}" failed to load: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

/** Project the manager store into unified rows with an origin label. */
export function listHostPlugins(deps: { manager: HostManager }): HostPluginRow[] {
  return deps.manager.list().map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    type: p.type,
    origin: originOf(p.path),
    status: p.status,
    toolCount: Array.isArray(p.tools) ? p.tools.length : 0,
  }))
}

/**
 * Hot-reload through the manager's own reload, which re-activates only what
 * was active and never a plugin whose intent is disabled. Calling
 * disable/unload/load/enable here re-loaded a disabled plugin and then failed
 * on its enable, reporting a broken reload for a plugin that was simply off.
 */
export async function reloadPlugin(id: string, deps: { manager: HostManager }): Promise<void> {
  await deps.manager.reloadPlugin(id, "cli-reload")
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Swap a staged tree in for a disk plugin's live directory.
 *
 * The runtime is stopped first and brought back to exactly the state it was
 * in afterwards (enabled, suspended, loaded or stopped). The new manifest is
 * registered before it restarts, so the manager loads the new tree rather than
 * the manifest it held for the old one. If the swap fails the old tree is
 * still in place and its runtime state is restored.
 */
export async function replaceDiskPlugin(
  staged: Pick<StagedInstall, "id" | "dir" | "manifest" | "commit">,
  deps: { manager: HostManager }
): Promise<void> {
  const { manager } = deps
  const current = manager.list().find((plugin) => plugin.id === staged.id)
  const resume = runtimeResumeStateOf(current?.status)
  const reservation = current ? manager.reservePluginRuntimeGraph(staged.id) : undefined
  try {
    await quiesceRuntime(manager, staged.id, resume, "cli-update")
    // A disabled plugin is inactive but still loaded from the old tree.
    if (current?.status === "disabled") await manager.unloadPlugin(staged.id)
    try {
      await manager.withPluginPackageMutation(staged.id, () => staged.commit())
    } catch (error) {
      try {
        await restoreRuntimeState(manager, staged.id, resume, "cli-update-restore")
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `${messageOf(error)}; restoring the previous runtime also failed: ${messageOf(restoreError)}`
        )
      }
      throw error
    }
    await manager.registerDiskPlugin(staged.manifest, staged.dir)
    await restoreRuntimeState(manager, staged.id, resume, "cli-update")
  } finally {
    if (reservation) manager.releasePluginRuntimeGraph(reservation)
  }
}

/** Unload then remove the plugin's on-disk directory. */
export async function uninstallHostPlugin(
  id: string,
  dir: string,
  deps: {
    manager: Pick<HostManager, "unloadPlugin">
    rm?: (p: string, opts: { recursive: boolean; force: boolean }) => Promise<void>
  }
): Promise<void> {
  await deps.manager.unloadPlugin(id)
  await (deps.rm ?? ((p, o) => nodeFsPromises.rm(p, o)))(dir, { recursive: true, force: true })
  releaseAuthProviderOwnership(id)
}

/**
 * Default disk discovery: enumerate `.cognia/plugins/<id>` via `discoverPlugins`,
 * then read each plugin's FULL `plugin.json` (the lightweight scan keeps only a
 * subset, but the manager needs the whole manifest to register capabilities).
 */
export async function defaultDiscoverDiskPlugins(
  roots: string[],
  fs?: PluginFs
): Promise<DiskPluginEntry[]> {
  const infos = await discoverPlugins(roots, fs)
  const entries: DiskPluginEntry[] = []
  for (const info of infos) {
    try {
      const text = fs
        ? await fs.readText(path.join(info.dir, "plugin.json"))
        : await nodeFsPromises.readFile(path.join(info.dir, "plugin.json"), "utf8")
      const manifest = JSON.parse(text) as PluginManifest
      entries.push({ id: info.id, dir: info.dir, manifest, supported: info.supported })
    } catch {
      // Skip a plugin whose manifest vanished or won't parse between scan + read.
    }
  }
  return entries
}
