/**
 * The generated host registry as the shells read it (ADR-0250 §14).
 *
 * `./generated/host.ts` holds every `lib/<id>/module.ts`, written by
 * `scripts/build/gen-module-registry.mjs` and never committed. Shells collect
 * their contributions from here rather than from a hand-written list: the
 * search dialog (`searchProviders`) and the chat composer (`slashCommands`).
 *
 * Dormancy (Rule 7). An `experimental` module contributes nothing: it stays
 * off every list a shell builds from this registry. `ModuleStage` documents
 * it, the settings shell labels a deep link to such a module's section as off
 * (`components/modules/registry.ts`), and `registry.test.ts` pins it.
 */

import { HOST_MODULES } from "./generated/host"
import type { HostModuleManifest } from "./manifest-types"

/** Whether a module's contributions reach the shells. */
export function isActiveModule(manifest: Pick<HostModuleManifest, "stage">): boolean {
  return manifest.stage !== "experimental"
}

/** Every module manifest, in id order. */
export function hostModules(): readonly HostModuleManifest[] {
  return HOST_MODULES
}

/** The modules whose contributions the shells collect. */
export function activeHostModules(
  modules: readonly HostModuleManifest[] = HOST_MODULES
): readonly HostModuleManifest[] {
  return modules.filter(isActiveModule)
}
