/**
 * The single source of truth for global developer mode (ADR-0117).
 *
 * The persisted `pluginSettings.developerModeEnabled` is the only signal: the
 * devtools panel, `managed-ide-dev-mode` and Creator all read it, so none of
 * them can disagree about whether developer mode is on.
 *
 * The per-plugin `config.debug` / `config.devMode` flag in
 * `lib/plugin/core/manager.ts` is deliberately NOT folded in here. That one
 * enables debug instrumentation for a single plugin; this one decides whether
 * developer surfaces exist at all.
 */

import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

/** Whether developer surfaces (devtools panel, Creator) may be offered. */
export function isDeveloperModeEnabled(): boolean {
  return usePluginStore.getState().pluginSettings.developerModeEnabled === true
}

/**
 * Reactive form of {@link isDeveloperModeEnabled} for React surfaces.
 *
 * The imperative getter reads a snapshot, so a component using it would not
 * re-render when the user flips the switch — and a Creator gate that stays shut
 * after developer mode is enabled looks like a broken feature.
 */
export function useDeveloperMode(): boolean {
  return usePluginStore((state) => state.pluginSettings.developerModeEnabled === true)
}

export function setDeveloperModeEnabled(enabled: boolean): void {
  usePluginStore.getState().updatePluginSettings({ developerModeEnabled: enabled })
}

/**
 * Turn developer mode on for a development build and return the resulting
 * value.
 *
 * One-way: it can only enable, never disable, so a production build leaves a
 * user's own choice alone. Idempotent, so safe to call on every boot.
 */
export function applyBootDeveloperMode(options: { developmentBuild?: boolean } = {}): boolean {
  if (isDeveloperModeEnabled()) return true
  const developmentBuild =
    options.developmentBuild ??
    (typeof process !== "undefined" && process.env.NODE_ENV === "development")
  if (developmentBuild) setDeveloperModeEnabled(true)
  return developmentBuild
}
