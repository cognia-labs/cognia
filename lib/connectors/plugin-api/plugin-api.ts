/**
 * The connectors' plugin host API (ADR-0250 §9, §14 `pluginApi`): a plugin's
 * `ctx.connectors` and the `connectors` module bridge that turns the
 * `connectors` entries of its manifest into running adapters. The plugin host
 * reaches both through `lib/plugin/core/module-plugin-api.ts`.
 */

import type { ModulePluginApiContribution } from "@/types/plugin/module-plugin-api"
import { createConnectorsAPI } from "./connectors-api"
import {
  getPluginConnectorKinds,
  registerPluginAdapters,
  unregisterPluginAdapters,
} from "./adapters-bridge"

export const pluginApi: ModulePluginApiContribution = {
  namespaces: { connectors: (pluginId) => createConnectorsAPI(pluginId) },
  bridges: {
    connectors: {
      // Needs the plugin's loaded exports (factory lookup by name) rather than
      // a per-entry importer; the manager supplies them from its loader cache.
      register: async (ctx) => {
        await registerPluginAdapters(ctx.pluginId, ctx.manifest, ctx.moduleExports)
      },
      unregister: unregisterPluginAdapters,
      // The connector kinds the plugin provides, for its Contributed tab.
      listContributions: getPluginConnectorKinds,
    },
  },
}
