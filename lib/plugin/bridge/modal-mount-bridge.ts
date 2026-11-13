/**
 * Moved to `@cognia/plugin-contract`, which owns the plugin contract.
 * This re-export keeps host imports of `@/lib/plugin/bridge/modal-mount-bridge` working.
 */
export * from "@cognia/plugin-contract/lib/plugin/bridge/modal-mount-bridge"

import {
  registerModalMountsForPlugin as registerPortableModalMounts,
  type RegisterModalMountsOptions,
} from "@cognia/plugin-contract/lib/plugin/bridge/modal-mount-bridge"
import type { PluginManifest } from "@/types/plugin/plugin"
import { markPluginSynchronousRenderer } from "@/lib/plugin/core/invocation-identity"

export function registerModalMountsForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: RegisterModalMountsOptions
): Promise<void> {
  const components = new Set(manifest.modalMounts?.map((def) => def.export))
  return registerPortableModalMounts(manifest, installRoot, {
    ...options,
    importer: async (entry) => {
      const importedModule = await options.importer(entry)
      return Object.fromEntries(
        Object.entries(importedModule).map(([key, value]) => [
          key,
          components.has(key) && typeof value === "function"
            ? markPluginSynchronousRenderer(manifest.id, value)
            : value,
        ])
      )
    },
  })
}
