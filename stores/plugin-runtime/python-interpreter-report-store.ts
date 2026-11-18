/**
 * Non-persisted, per-plugin report of the interpreter each Python plugin last
 * loaded on (ENV03, ADR-0258), recorded by the plugin manager from the
 * `plugin_python_load` reply and read by the host settings card.
 *
 * Plain `create()` without `persist`: the report describes a running host. A
 * restart reloads the plugin, and the load writes a fresh one.
 */

import { create } from "zustand"

import type { PythonInterpreterReport } from "@/lib/plugin/python/interpreter-report"

export interface PythonInterpreterReportState {
  byPluginId: Record<string, PythonInterpreterReport>
}

export const usePythonInterpreterReportStore = create<PythonInterpreterReportState>(() => ({
  byPluginId: {},
}))

/** Record the latest load's report; `null` (a reply without one) clears it. */
export function recordPythonInterpreterReport(
  pluginId: string,
  report: PythonInterpreterReport | null
): void {
  usePythonInterpreterReportStore.setState((state) => {
    const byPluginId = { ...state.byPluginId }
    if (report) byPluginId[pluginId] = report
    else delete byPluginId[pluginId]
    return { byPluginId }
  })
}

export function __resetPythonInterpreterReportStoreForTesting(): void {
  usePythonInterpreterReportStore.setState({ byPluginId: {} })
}
