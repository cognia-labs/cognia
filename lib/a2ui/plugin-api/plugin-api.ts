/**
 * The a2ui module's plugin host API (ADR-0250 §9, §14 `pluginApi`): a
 * plugin's `ctx.a2ui`, and the plugin A2UI bridge behind it. The bridge is
 * created the first time a plugin registers a component or template, one per
 * plugin manager, and from then on forwards surface lifecycle, actions and data
 * changes to the manager's lifecycle hooks. When a plugin unloads, what it
 * registered through the bridge goes with it.
 */

import type {
  ModulePluginApiContribution,
  ModulePluginApiHost,
} from "@/types/plugin/module-plugin-api"
import { createA2UIAPI } from "./a2ui-api"
import { createPluginA2UIBridge, type PluginA2UIBridge } from "./plugin-bridge"

const bridges = new WeakMap<ModulePluginApiHost, PluginA2UIBridge>()

function bridgeFor(host: ModulePluginApiHost): PluginA2UIBridge {
  let bridge = bridges.get(host)
  if (!bridge) {
    bridge = createPluginA2UIBridge({
      registry: host.registry,
      hooksManager: host.hooksManager,
      contextResolver: (pluginId) => host.contextOf(pluginId),
    })
    bridges.set(host, bridge)
  }
  return bridge
}

export const pluginApi: ModulePluginApiContribution = {
  namespaces: { a2ui: (pluginId, host) => createA2UIAPI(pluginId, () => bridgeFor(host)) },
  unload: (pluginId, host) => {
    const bridge = bridges.get(host)
    bridge?.unregisterPluginComponents(pluginId)
    bridge?.unregisterPluginTemplates(pluginId)
  },
}
