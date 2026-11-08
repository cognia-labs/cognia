/**
 * The plugin host API feature modules contribute (ADR-0250 §9, §14
 * `pluginApi`). A module declares, in its manifest, the `ctx.<namespace>`
 * objects and the module bridges it builds, with the file that exports them;
 * the generated registry (`lib/modules/generated/plugin-api.ts`) lists them
 * with one lazy import per module, so the plugin host builds a plugin's
 * context and registers its contributions without importing any module.
 *
 * A plugin context is built synchronously, so the manager awaits
 * {@link preloadModulePluginApis} before it builds one; a namespace asked for
 * before then, or one no active module provides, throws a named error rather
 * than mounting an empty object. Bridges load on demand. A failed load is
 * tried again on the next call. An `experimental` module contributes nothing.
 */

import type { ModulePluginApiEntry } from "@/lib/modules/manifest-types"
import { MODULE_PLUGIN_API } from "@/lib/modules/generated/plugin-api"
import type {
  ModulePluginApiContribution,
  ModulePluginApiHost,
  ModulePluginBridge,
  ModulePluginNamespace,
  ModulePluginNamespaceMap,
} from "@/types/plugin/module-plugin-api"
import type { PluginManager } from "./manager"

let entries: readonly ModulePluginApiEntry[] = MODULE_PLUGIN_API
const loads = new Map<string, Promise<ModulePluginApiContribution>>()
const loaded = new Map<string, ModulePluginApiContribution>()

function active(): readonly ModulePluginApiEntry[] {
  return entries.filter((entry) => entry.stage !== "experimental")
}

function loadEntry(entry: ModulePluginApiEntry): Promise<ModulePluginApiContribution> {
  const pending = loads.get(entry.module)
  if (pending) return pending
  const load = entry
    .load()
    .then(({ pluginApi }) => {
      loaded.set(entry.module, pluginApi)
      return pluginApi
    })
    .catch((error: unknown) => {
      loads.delete(entry.module)
      throw error
    })
  loads.set(entry.module, load)
  return load
}

const hosts = new WeakMap<PluginManager, ModulePluginApiHost>()

/**
 * The manager as a module's plugin API sees it: one object per manager, whose
 * members read the manager on first use.
 */
export function modulePluginApiHostOf(manager: PluginManager): ModulePluginApiHost {
  let host = hosts.get(manager)
  if (!host) {
    host = {
      get registry() {
        return manager.getRegistry()
      },
      get hooksManager() {
        return manager.getHooksManager()
      },
      contextOf: (pluginId) => manager.getPluginContext(pluginId),
    }
    hosts.set(manager, host)
  }
  return host
}

/** Load every active module's plugin API; resolves once each is ready. */
export async function preloadModulePluginApis(): Promise<void> {
  await Promise.all(active().map(loadEntry))
}

/** The namespaces active modules declare, in module order. */
export function modulePluginNamespaces(): readonly string[] {
  return active().flatMap((entry) => entry.namespaces)
}

/**
 * Build `pluginId`'s `ctx.<namespace>` from the module that declares it. Throws
 * when no active module declares it, when the module's file is not loaded yet,
 * or when the file does not provide it.
 */
export function buildModulePluginNamespace<K extends ModulePluginNamespace>(
  namespace: K,
  pluginId: string,
  host: ModulePluginApiHost
): ModulePluginNamespaceMap[K] {
  const entry = active().find((candidate) => candidate.namespaces.includes(namespace))
  if (!entry) throw new Error(`no module provides the ctx.${namespace} plugin API`)
  const contribution = loaded.get(entry.module)
  if (!contribution)
    throw new Error(
      `ctx.${namespace} is provided by ${entry.module}, whose plugin API is not loaded yet; ` +
        "await preloadModulePluginApis() before building a plugin context"
    )
  const factory = contribution.namespaces?.[namespace]
  if (!factory) throw new Error(`ctx.${namespace} is declared by ${entry.module} but not provided`)
  return factory(pluginId, host)
}

/**
 * The module bridge an active module answers for `capability`, loading its
 * file; `undefined` when no module declares it.
 */
export async function moduleBridge(capability: string): Promise<ModulePluginBridge | undefined> {
  const entry = active().find((candidate) => candidate.bridges.includes(capability))
  if (!entry) return undefined
  const bridge = (await loadEntry(entry)).bridges?.[capability]
  if (!bridge)
    throw new Error(`module bridge ${capability} is declared by ${entry.module} but not provided`)
  return bridge
}

/**
 * What `pluginId` contributes through the `capability` bridge, by id; empty
 * when no module answers it or its file has not loaded (no plugin context was
 * built yet, so no plugin registered through it).
 */
export function moduleBridgeContributions(capability: string, pluginId: string): readonly string[] {
  const entry = active().find((candidate) => candidate.bridges.includes(capability))
  if (!entry) return []
  return loaded.get(entry.module)?.bridges?.[capability]?.listContributions?.(pluginId) ?? []
}

/**
 * Let every loaded module drop what `pluginId` registered through its
 * namespaces. A module whose file never loaded built no namespace, so it holds
 * nothing to drop. Every module is asked even when one throws; the first error
 * is rethrown after.
 */
export async function unloadModulePluginApis(
  pluginId: string,
  host: ModulePluginApiHost
): Promise<void> {
  let failure: unknown
  let failed = false
  for (const entry of active()) {
    const contribution = loaded.get(entry.module)
    if (!contribution?.unload) continue
    try {
      await contribution.unload(pluginId, host)
    } catch (error) {
      if (!failed) failure = error
      failed = true
    }
  }
  if (failed) throw failure
}

/** Replace the registry and forget what was loaded. */
export function __setModulePluginApisForTesting(
  next: readonly ModulePluginApiEntry[] = MODULE_PLUGIN_API
): void {
  entries = next
  loads.clear()
  loaded.clear()
}
