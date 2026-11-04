/**
 * Global-search providers that feature modules contribute (ADR-0250 §14).
 *
 * A module names its providers with a lazy `searchProviders` entry in
 * `lib/<id>/module.ts`; this loads every active module's entry and registers
 * what it exports beside the built-ins. Registration bumps the registry
 * revision, so a dialog that opened before the load finished re-runs its query
 * when the providers arrive.
 *
 * One module failing to load does not keep the others out of the palette. The
 * failure is logged with the module's id and left out of the returned ids.
 */

import { loggers } from "@cognia/logging"

import type { HostModuleManifest } from "@/lib/modules/manifest-types"
import { activeHostModules } from "@/lib/modules/registry"
import { registerGlobalSearchProvider } from "../registry"

/** Register every active module's providers. Resolves to the ids registered. */
export async function registerModuleGlobalSearchProviders(
  modules: readonly HostModuleManifest[] = activeHostModules()
): Promise<string[]> {
  const contributing = modules.filter((manifest) => manifest.searchProviders)
  const loaded = await Promise.allSettled(
    contributing.map(async (manifest) => (await manifest.searchProviders!()).searchProviders)
  )
  const ids: string[] = []
  loaded.forEach((outcome, index) => {
    const moduleId = contributing[index]!.id
    if (outcome.status === "rejected") {
      loggers.search.error("module search providers failed to load", outcome.reason, {
        module: moduleId,
      })
      return
    }
    for (const provider of outcome.value) {
      registerGlobalSearchProvider(provider)
      ids.push(provider.id)
    }
  })
  return ids
}
