"use client"

/**
 * Renders every active module's `effects` (ADR-0250 §14, M2): side effects
 * that need React context, the router, i18n or toasts, declared in a module's
 * UI manifest instead of mounted by hand in the app runtime.
 *
 * Mounted once, inside the app's providers, and in every window: an effect
 * decides which window it acts in (the pet's, for one, runs its controller
 * only in the main window). Each loads lazily, in module id order and then
 * manifest order, behind its own `ModuleBoundary`. An `experimental` module
 * mounts nothing (`activeUiModules`).
 */

import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react"

import { ModuleBoundary } from "@/components/modules/module-boundary"
import { activeUiModules } from "@/components/modules/registry"
import type { UiModuleManifest } from "@/lib/modules/manifest-types"

interface EffectEntry {
  key: string
  module: string
  name: string
  Component: LazyExoticComponent<ComponentType>
}

const components = new Map<string, LazyExoticComponent<ComponentType>>()

/** The active modules' effects, in the order they mount. */
export function moduleEffectEntries(
  modules: readonly UiModuleManifest[] = activeUiModules()
): EffectEntry[] {
  return [...modules]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((manifest) =>
      (manifest.effects ?? []).map((effect) => {
        const key = `${manifest.id}:${effect.name}`
        let Component = components.get(key)
        if (!Component) {
          Component = lazy(effect.load)
          components.set(key, Component)
        }
        return { key, module: manifest.id, name: effect.name, Component }
      })
    )
}

export function ModuleEffectsHost() {
  return (
    <>
      {moduleEffectEntries().map(({ key, module, name, Component }) => (
        <ModuleBoundary key={key} module={module} part={`effect:${name}`}>
          <Suspense fallback={null}>
            <Component />
          </Suspense>
        </ModuleBoundary>
      ))}
    </>
  )
}

/** Test seam: forget the loaded components. */
export function __resetModuleEffectsForTests(): void {
  components.clear()
}

export default ModuleEffectsHost
