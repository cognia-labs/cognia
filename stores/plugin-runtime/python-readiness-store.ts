/**
 * Non-persisted, per-plugin state of each Python plugin's environment (ENV01,
 * ADR-0258): the Host's last readiness answer, and how the last preparation
 * started from this app ended. The plugin manager writes both
 * (`getPythonReadiness` before every load and after every preparation,
 * `installPythonDeps`); the plugin card, the status badge, the detail page and
 * the prepare prompt read them, so a preparation started in one place shows
 * everywhere.
 *
 * Plain `create()` without `persist`: readiness describes the Host's
 * environment now, and the next query replaces it.
 */

import { create } from "zustand"

import type { PythonReadinessReport } from "@/lib/plugin/python/readiness"
import type { PythonInstallOutcome } from "@/types/plugin"

/** How the last preparation ended. */
export type PythonPreparationResult =
  | { status: "succeeded"; outcome: PythonInstallOutcome | null }
  | { status: "failed"; message: string }

export interface PythonReadinessStoreState {
  byPluginId: Record<string, PythonReadinessReport>
  lastPreparationByPluginId: Record<string, PythonPreparationResult>
}

export const usePythonReadinessStore = create<PythonReadinessStoreState>(() => ({
  byPluginId: {},
  lastPreparationByPluginId: {},
}))

/** Record the latest report; `null` (no answer this build can read) clears it. */
export function recordPythonReadiness(
  pluginId: string,
  report: PythonReadinessReport | null
): void {
  usePythonReadinessStore.setState((state) => {
    const byPluginId = { ...state.byPluginId }
    if (report) byPluginId[pluginId] = report
    else delete byPluginId[pluginId]
    return { byPluginId }
  })
}

/**
 * A preparation started: every view shows it as running until the Host's next
 * answer. Without a report naming the installer there is nothing to mark, and
 * the views keep what they had.
 */
export function markPythonPreparing(pluginId: string): void {
  usePythonReadinessStore.setState((state) => {
    const current = state.byPluginId[pluginId]
    const lastPreparationByPluginId = { ...state.lastPreparationByPluginId }
    delete lastPreparationByPluginId[pluginId]
    if (!current || !("installer" in current.readiness)) return { lastPreparationByPluginId }
    return {
      lastPreparationByPluginId,
      byPluginId: {
        ...state.byPluginId,
        [pluginId]: {
          ...current,
          readiness: { state: "preparing", installer: current.readiness.installer },
        },
      },
    }
  })
}

export function recordPythonPreparation(pluginId: string, result: PythonPreparationResult): void {
  usePythonReadinessStore.setState((state) => ({
    lastPreparationByPluginId: { ...state.lastPreparationByPluginId, [pluginId]: result },
  }))
}

/** Drop everything about a plugin, when it is uninstalled. */
export function forgetPythonReadiness(pluginId: string): void {
  usePythonReadinessStore.setState((state) => {
    const byPluginId = { ...state.byPluginId }
    const lastPreparationByPluginId = { ...state.lastPreparationByPluginId }
    delete byPluginId[pluginId]
    delete lastPreparationByPluginId[pluginId]
    return { byPluginId, lastPreparationByPluginId }
  })
}

export function __resetPythonReadinessStoreForTesting(): void {
  usePythonReadinessStore.setState({ byPluginId: {}, lastPreparationByPluginId: {} })
}
