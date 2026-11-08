/**
 * The plugin host API a feature module contributes (ADR-0250 §9, §14
 * `pluginApi`): the `ctx.<namespace>` objects it builds for each plugin, the
 * module bridges that register a plugin's manifest contributions into it, and
 * what it drops when a plugin unloads. The plugin host reads these through
 * `lib/plugin/core/module-plugin-api.ts`, so it imports no module's code.
 */

import type { PluginA2UIAPI, PluginContext } from "@/types/plugin/plugin"
import type { PluginConnectorsAPI } from "@cognia/plugin-contract/lib/plugin/api/connectors-api"
import type { PluginRegistry } from "@/lib/plugin/core/registry"
import type { PluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import type { ModuleBridgeContext } from "@/lib/plugin/contracts/module-bridge-map"

/**
 * What the plugin manager gives a module's plugin API: its registry, its
 * lifecycle hooks and each loaded plugin's context. One object per manager, so
 * a module may keep per-manager state keyed by it.
 */
export interface ModulePluginApiHost {
  readonly registry: PluginRegistry
  readonly hooksManager: PluginLifecycleHooks
  contextOf(pluginId: string): PluginContext | undefined
}

/** The `ctx.<namespace>` objects modules build, by catalog namespace id. */
export interface ModulePluginNamespaceMap {
  a2ui: PluginA2UIAPI
  connectors: PluginConnectorsAPI
}

export type ModulePluginNamespace = keyof ModulePluginNamespaceMap

/** Builds one plugin's `ctx.<namespace>`; called once per context. */
export type ModulePluginNamespaceFactory<K extends ModulePluginNamespace> = (
  pluginId: string,
  host: ModulePluginApiHost
) => ModulePluginNamespaceMap[K]

/**
 * A module bridge: registers every contribution of one manifest field
 * (`MODULE_BRIDGE_CAPABILITIES` names the field) and drops them again.
 */
export interface ModulePluginBridge {
  register(ctx: ModuleBridgeContext): Promise<void>
  unregister(pluginId: string): void | Promise<void>
  /** What the plugin currently contributes through it, by id, for the plugin's detail page. */
  listContributions?(pluginId: string): readonly string[]
}

/** What a module's `pluginApi` file exports as `pluginApi`. */
export interface ModulePluginApiContribution {
  namespaces?: { readonly [K in ModulePluginNamespace]?: ModulePluginNamespaceFactory<K> }
  /** Keyed by bridge capability (`MODULE_BRIDGE_CAPABILITIES`). */
  bridges?: Readonly<Record<string, ModulePluginBridge>>
  /** Drops what the plugin registered through the namespaces, on unload. */
  unload?(pluginId: string, host: ModulePluginApiHost): void | Promise<void>
}
