/**
 * The generated UI registry as the shells read it (ADR-0250 §14).
 *
 * `./generated/ui.ts` holds every `components/<id>/module.ui.ts`, written by
 * `scripts/build/gen-module-registry.mjs` and never committed. A UI manifest
 * is active when its host manifest is (`isActiveModule`): an `experimental`
 * module's settings section is off the settings navigation, and a deep link to
 * it shows that the section is off instead of falling through to another one.
 */

import { HOST_MODULES } from "@/lib/modules/generated/host"
import type { HostModuleManifest, UiModuleManifest } from "@/lib/modules/manifest-types"
import { isActiveModule } from "@/lib/modules/registry"
import { UI_MODULES } from "./generated/ui"

type SectionIdsOf<M> = M extends { settingsSections: readonly (infer S)[] }
  ? S extends { id: infer I extends string }
    ? I
    : never
  : never

/** `?section=` values the module registry contributes, typed from the manifests. */
export type ModuleSettingsSectionId = SectionIdsOf<(typeof UI_MODULES)[number]>

function partition(
  ui: readonly UiModuleManifest[],
  host: readonly HostModuleManifest[]
): { active: UiModuleManifest[]; dormant: UiModuleManifest[] } {
  const byId = new Map(host.map((manifest) => [manifest.id, manifest]))
  const active: UiModuleManifest[] = []
  const dormant: UiModuleManifest[] = []
  for (const manifest of ui) {
    const owner = byId.get(manifest.id)
    // The module gate refuses this (G1), so reaching it means the registry was
    // generated from a tree the gate never saw.
    if (!owner)
      throw new Error(
        `components/${manifest.id}/module.ui.ts has no host manifest lib/${manifest.id}/module.ts`
      )
    ;(isActiveModule(owner) ? active : dormant).push(manifest)
  }
  return { active, dormant }
}

/** UI manifests whose module is active. */
export function activeUiModules(
  ui: readonly UiModuleManifest[] = UI_MODULES,
  host: readonly HostModuleManifest[] = HOST_MODULES
): readonly UiModuleManifest[] {
  return partition(ui, host).active
}

/** UI manifests whose module is dormant (`experimental`). */
export function dormantUiModules(
  ui: readonly UiModuleManifest[] = UI_MODULES,
  host: readonly HostModuleManifest[] = HOST_MODULES
): readonly UiModuleManifest[] {
  return partition(ui, host).dormant
}
