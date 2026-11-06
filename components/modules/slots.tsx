"use client"

/**
 * Module contributions to canonical extension points (ADR-0250 §14, M2).
 *
 * A module fills a point with `slots` in its UI manifest. The point's host
 * renders them through `PluginExtensionSlot`, ahead of plugin contributions
 * and in module id order, each loaded lazily on first render and kept apart
 * by its own `ModuleBoundary`. An `experimental` module contributes nothing
 * (`activeUiModules`), which `slots.test.tsx` pins.
 */

import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react"

import type { ModuleSlotProps, UiModuleManifest } from "@/lib/modules/manifest-types"
import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"

import { ModuleBoundary } from "./module-boundary"
import { activeUiModules } from "./registry"

/** One module's contribution to one point. */
export interface ModuleSlotEntry {
  module: string
  point: CanonicalExtensionPoint
  Component: LazyExoticComponent<ComponentType<ModuleSlotProps>>
}

const components = new Map<string, LazyExoticComponent<ComponentType<ModuleSlotProps>>>()

/** The active modules' contributions to `point`, in module id order. */
export function moduleSlotEntries(
  point: CanonicalExtensionPoint,
  modules: readonly UiModuleManifest[] = activeUiModules()
): ModuleSlotEntry[] {
  return [...modules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((manifest) => {
      const load = manifest.slots?.[point]
      if (!load) return []
      const key = `${manifest.id}:${point}`
      let Component = components.get(key)
      if (!Component) {
        Component = lazy(load)
        components.set(key, Component)
      }
      return [{ module: manifest.id, point, Component }]
    })
}

/** Renders module contributions, each behind its own boundary. */
export function ModuleSlotContributions({
  entries,
  formFactor,
  context,
}: { entries: readonly ModuleSlotEntry[] } & ModuleSlotProps) {
  return (
    <>
      {entries.map(({ module, point, Component }) => (
        <div key={module} data-module-slot={module} className="contents">
          <ModuleBoundary module={module} part={`slot:${point}`}>
            <Suspense fallback={null}>
              <Component formFactor={formFactor} context={context} />
            </Suspense>
          </ModuleBoundary>
        </div>
      ))}
    </>
  )
}

/** Test seam: forget the loaded components. */
export function __resetModuleSlotsForTests(): void {
  components.clear()
}
