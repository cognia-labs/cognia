/**
 * A module's view of the person's settings (ADR-0250 §14, settings-key
 * ownership, M3).
 *
 * A module claims the flat `AppSettings` keys it owns in its manifest
 * (`settings.keys`) and reads and writes the settings through one view built
 * from that list, `defineSettingsView(module.settings.keys)`, instead of
 * importing the settings store. The store, its persistence and the wire
 * (`packages/agent-config-types/src/settings-sync.ts`) do not change: a view
 * is a narrow door onto the same `useSettingsStore` state.
 *
 * - Reading sees the whole settings object, because a module also reads the
 *   kernel's keys (providers, the profile, the language). Reading a key
 *   another module claims is the module gate's `settingsAccess` measure
 *   (`scripts/gates/check-modules.mjs`), which may only fall: such a read
 *   belongs behind the owner's `api`.
 * - Writing is limited to the view's own keys. A patch naming any other key
 *   throws before anything is saved.
 *
 * The gate checks the other end: only a manifest module defines a view, and
 * only over its own manifest's `settings.keys`.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { useSettingsStore } from "./settings-store"

/** A flat `AppSettings` key a module can own; the row id is the store's. */
export type SettingsKey = Exclude<keyof AppSettings, "id">

/** A patch of a view's own keys. */
export type SettingsPatch<K extends SettingsKey> = Partial<Pick<AppSettings, K>>

export interface SettingsView<K extends SettingsKey> {
  /** The keys this view owns, as its module's manifest declares them. */
  readonly keys: readonly K[]
  /** The person's settings now, or `null` before the first load. */
  get(): Readonly<AppSettings> | null
  /** Whether the settings have loaded (or fallen back to the defaults). */
  isLoaded(): boolean
  /**
   * React hook: what `select` picks from the settings, re-rendering when it
   * changes. `select` follows a store selector's rule: return a stored value
   * or a primitive, never a fresh object.
   */
  use<T>(select: (settings: Readonly<AppSettings> | null) => T): T
  /** Hear every change of the settings object. Returns the unsubscribe function. */
  subscribe(
    listener: (
      settings: Readonly<AppSettings> | null,
      previous: Readonly<AppSettings> | null
    ) => void
  ): () => void
  /** Persist a patch of this view's keys. */
  update(patch: SettingsPatch<K>): Promise<void>
  /**
   * Put a patch of this view's keys into this window's state without
   * persisting it, for a value another window already saved. A patch that
   * changes nothing leaves the state as it is.
   */
  applyLocal(patch: SettingsPatch<K>): void
}

export function defineSettingsView<const K extends SettingsKey>(
  keys: readonly K[]
): SettingsView<K> {
  const owned = new Set<string>(keys)
  const assertOwned = (patch: object) => {
    for (const key of Object.keys(patch))
      if (!owned.has(key))
        throw new Error(`settings key "${key}" is not one of this view's own keys`)
  }
  return {
    keys,
    get: () => useSettingsStore.getState().settings,
    isLoaded: () => useSettingsStore.getState().loaded,
    use: (select) => useSettingsStore((state) => select(state.settings)),
    subscribe: (listener) =>
      useSettingsStore.subscribe((state, previous) => {
        if (state.settings !== previous.settings) listener(state.settings, previous.settings)
      }),
    update: async (patch) => {
      assertOwned(patch)
      await useSettingsStore.getState().save(patch)
    },
    applyLocal: (patch) => {
      assertOwned(patch)
      useSettingsStore.setState((state) => {
        const current = state.settings
        if (!current) return state
        const changed = (Object.keys(patch) as K[]).some((key) => current[key] !== patch[key])
        return changed ? { settings: { ...current, ...patch } } : state
      })
    },
  }
}
