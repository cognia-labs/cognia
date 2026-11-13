/**
 * Moved to `@cognia/plugin-contract`, which owns the plugin contract.
 * This re-export keeps host imports of `@/lib/plugin/api/modal-api` working.
 */
export * from "@cognia/plugin-contract/lib/plugin/api/modal-api"

import {
  createModalAPI as createPortableModalAPI,
  type PluginModalAPI,
} from "@cognia/plugin-contract/lib/plugin/api/modal-api"
import { markPluginSynchronousRenderer } from "@/lib/plugin/core/invocation-identity"

/** Host callback policy stays outside the portable plugin contract. */
export function createModalAPI(pluginId: string): PluginModalAPI {
  const api = createPortableModalAPI(pluginId)
  return {
    ...api,
    openModal: (component, args, options) =>
      api.openModal(markPluginSynchronousRenderer(pluginId, component), args, options),
  }
}
