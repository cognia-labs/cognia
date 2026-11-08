/**
 * A plugin's `ctx.a2ui`: surfaces it creates and feeds through the A2UI
 * store, and the components and templates it registers through the plugin
 * A2UI bridge (`./plugin-bridge.ts`), which the a2ui module's plugin API
 * keeps one of per plugin manager.
 */

import type { A2UITemplateDef, PluginA2UIAPI, PluginA2UIComponent } from "@/types/plugin"
import type { A2UIComponent, A2UISurfaceType } from "@/types/artifact/a2ui"
import { useA2UIStore } from "@/stores/a2ui"
import type { PluginA2UIBridge } from "./plugin-bridge"

export function createA2UIAPI(pluginId: string, bridge: () => PluginA2UIBridge): PluginA2UIAPI {
  const a2uiStore = useA2UIStore.getState()

  return {
    createSurface: (id: string, type: A2UISurfaceType, options?: { title?: string }) => {
      a2uiStore.createSurface(id, type, options)
    },

    deleteSurface: (id: string) => {
      a2uiStore.deleteSurface(id)
    },

    updateComponents: (surfaceId: string, components: A2UIComponent[]) => {
      a2uiStore.processMessage({
        type: "updateComponents",
        surfaceId,
        components,
      })
    },

    setReady: (surfaceId: string) => {
      a2uiStore.processMessage({ type: "surfaceReady", surfaceId })
    },

    updateDataModel: (surfaceId: string, data: Record<string, unknown>, merge = true) => {
      a2uiStore.processMessage({
        type: "dataModelUpdate",
        surfaceId,
        data,
        merge,
      })
    },

    getSurface: (id: string) => {
      return a2uiStore.getSurface(id)
    },

    registerComponent: (component: PluginA2UIComponent) => {
      bridge().registerComponent(pluginId, component)
    },

    registerTemplate: (template: A2UITemplateDef) => {
      bridge().registerTemplate(pluginId, template)
    },
  }
}
