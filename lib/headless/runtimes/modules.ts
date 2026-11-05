/**
 * Module runtimes on the brain (ADR-0250 §14, M2).
 *
 * Every module manifest's brain adapter, from `lib/modules/generated/brain.ts`,
 * registers here as a `HeadlessRuntime`: the manifest gives the name,
 * criticality and the brain profiles it starts on, and the adapter's `start`
 * is `HeadlessRuntime.start` unchanged. Imported by the roster
 * (`./index.ts`), so every brain adapter is called on the brain, the rule
 * `check-headless-registry` holds the initializers to.
 *
 * Dormancy (Rule 7): an `experimental` module registers nothing
 * (`isActiveModule`); `modules.test.ts` pins it.
 */

import { BRAIN_RUNTIMES } from "@/lib/modules/generated/brain"
import type { BrainRuntimeEntry } from "@/lib/modules/manifest-types"
import { isActiveModule } from "@/lib/modules/registry"

import { registerHeadlessRuntime } from "../registry"

export function registerModuleRuntimes(
  entries: readonly BrainRuntimeEntry[] = BRAIN_RUNTIMES
): void {
  for (const entry of entries) {
    if (!isActiveModule(entry)) continue
    registerHeadlessRuntime({
      name: entry.name,
      criticality: entry.criticality,
      hosts: [...entry.hosts],
      start: async (ctx) => (await entry.load()).start(ctx),
    })
  }
}

registerModuleRuntimes()
