/**
 * One log stream per plugin, whatever runtime it happens to be.
 *
 * A plugin author's output used to live in unrelated places with different
 * gates, and some runtimes had none at all. Each runtime now has a source:
 *
 *   frontend / hybrid  `debugger.ts` ring.
 *   python / hybrid    `lib/plugin/python/log-buffer.ts`.
 *   wasm               `lib/plugin/wasm-bridge/log-buffer.ts`, the guest's
 *                      `log` calls as the host bounded and recorded them.
 *   vscode-extension   `lib/plugin/vscode-shim/vscode-log-buffer.ts`, its
 *                      host's stderr and its output channels.
 *
 * This module merges them into one time-ordered stream, so the Dev Session
 * workbench shows a plugin's output wherever it was written.
 */

import type { PluginType } from "@/types/plugin"
import type { JsonSafeValue } from "@/lib/error/serialize-error"
import { getPluginDebugger, type LogEntry } from "./debugger"
import {
  clearPythonLogs,
  getPythonLogs,
  subscribePythonLogs,
  type PythonLogEntry,
} from "@/lib/plugin/python/log-buffer"
import {
  clearVscodeLogs,
  getVscodeLogs,
  subscribeVscodeLogs,
} from "@/lib/plugin/vscode-shim/vscode-log-buffer"
import { clearWasmLogs, getWasmLogs, subscribeWasmLogs } from "@/lib/plugin/wasm-bridge/log-buffer"
import { drainWasmLogs } from "@/lib/plugin/wasm-bridge/log-source"

export type PluginLogRuntime = "frontend" | "python" | "wasm" | "vscode"
export type PluginLogLevel = "debug" | "info" | "warn" | "error"

export interface PluginRuntimeLogEntry {
  id: string
  pluginId: string
  runtime: PluginLogRuntime
  /**
   * Lifecycle generation as a string, because the sources disagree: the
   * frontend ring counts, the python host sends an opaque token, the WASM
   * buffer maps its host token to the manager's count. `null` means the source
   * did not say.
   */
  generation: string | null
  level: PluginLogLevel
  message: string
  timestamp: number
  /** The python host's frame kind (`progress`, `chunk`, `exit`, …), or a WASM guest's scope. */
  kind?: string
  /** Extra values logged after the message, JSON-safe and bounded. */
  args?: JsonSafeValue[]
  /** Stack of the logged Error (or of the error-level call site). */
  stack?: string
}

/** Every member of `PluginType`, so the switch below cannot silently miss one. */
const PLUGIN_TYPES: PluginType[] = ["frontend", "python", "hybrid", "wasm", "vscode-extension"]

/**
 * Narrow a stored value to a known runtime.
 *
 * `PluginRow.type` is a loose `string` out of Dexie, and the Logs tab decides
 * whether to exist from it. An unrecognised value gets no tab, which is the
 * conservative direction.
 */
export function isPluginType(value: string): value is PluginType {
  return (PLUGIN_TYPES as string[]).includes(value)
}

/** Which sources a plugin type can produce. Pure. */
export function logSourcesFor(type: PluginType): { runtimes: PluginLogRuntime[] } {
  switch (type) {
    case "frontend":
      return { runtimes: ["frontend"] }
    case "python":
      return { runtimes: ["python"] }
    case "hybrid":
      return { runtimes: ["frontend", "python"] }
    case "wasm":
      return { runtimes: ["wasm"] }
    case "vscode-extension":
      return { runtimes: ["vscode"] }
  }
}

/** Pure. */
export function normalizeFrontendEntry(entry: LogEntry): PluginRuntimeLogEntry {
  return {
    id: entry.id,
    pluginId: entry.pluginId,
    runtime: "frontend",
    generation: String(entry.generation),
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    ...(entry.args.length > 0 ? { args: entry.args } : {}),
    ...(entry.stack ? { stack: entry.stack } : {}),
  }
}

const PYTHON_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"])

/**
 * Pure. Mirrors how the plugin detail Logs tab already reads these frames, so
 * the same event does not read differently on two screens.
 */
export function normalizePythonEntry(entry: PythonLogEntry, index: number): PluginRuntimeLogEntry {
  const data = (entry.data ?? {}) as Record<string, unknown>
  let level: PluginLogLevel = "info"
  let message = ""

  switch (entry.kind) {
    case "log": {
      const declared = typeof data.level === "string" ? data.level.toLowerCase() : ""
      level = PYTHON_LEVELS.has(declared) ? (declared as PluginLogLevel) : "info"
      message = typeof data.line === "string" ? data.line : safeJson(entry.data)
      break
    }
    case "progress": {
      level = "debug"
      const phase = typeof data.phase === "string" ? `[${data.phase}] ` : ""
      const text = typeof data.message === "string" ? data.message : ""
      const pct = typeof data.pct === "number" ? ` (${data.pct}%)` : ""
      message = `${phase}${text}${pct}`.trim() || safeJson(entry.data)
      break
    }
    case "chunk":
      level = "debug"
      message = typeof entry.data === "string" ? entry.data : safeJson(entry.data)
      break
    case "chunk_end":
      level = "debug"
      break
    case "exit":
      level = typeof data.code === "number" && data.code !== 0 ? "error" : "info"
      message = typeof data.code === "number" ? String(data.code) : ""
      break
    default:
      message = safeJson(entry.data)
  }

  return {
    // The python buffer has no id of its own, and two frames can share a
    // millisecond, so the index inside the snapshot keeps keys unique.
    id: `py-${entry.pluginId}-${entry.ts}-${index}`,
    pluginId: entry.pluginId,
    runtime: "python",
    generation: entry.generation ?? null,
    level,
    message,
    timestamp: entry.ts,
    kind: entry.kind,
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

export interface RuntimeLogQuery {
  /**
   * Keep only entries from this lifecycle generation. Compared as a string,
   * so the frontend ring's number and the python host's token both work.
   * Entries whose source reported no generation are kept either way: dropping
   * them would hide a whole runtime rather than filter it.
   */
  generation?: string | number | null
  limit?: number
}

/** Merge every source for one plugin, oldest first. */
export function getPluginRuntimeLogs(
  pluginId: string,
  query: RuntimeLogQuery = {}
): PluginRuntimeLogEntry[] {
  const merged = [
    ...getPluginDebugger().getLogs(pluginId).map(normalizeFrontendEntry),
    ...getPythonLogs(pluginId).map(normalizePythonEntry),
    ...getVscodeLogs(pluginId),
    ...getWasmLogs(pluginId),
  ]
  const wanted = query.generation == null ? null : String(query.generation)
  const filtered =
    wanted === null
      ? merged
      : merged.filter((entry) => entry.generation === null || entry.generation === wanted)
  filtered.sort((a, b) => a.timestamp - b.timestamp)
  return query.limit != null ? filtered.slice(-query.limit) : filtered
}

/**
 * Fires whenever a source writes for this plugin. Subscribing also reads what
 * the WASM host recorded before this renderer was listening (a no-op for any
 * other runtime, and before any WASM plugin loaded).
 */
export function subscribePluginRuntimeLogs(pluginId: string, onChange: () => void): () => void {
  const offFrontend = getPluginDebugger().onLog((entry) => {
    if (entry.pluginId === pluginId) onChange()
  })
  const offPython = subscribePythonLogs((changedId) => {
    if (changedId === pluginId) onChange()
  })
  const offVscode = subscribeVscodeLogs((changedId) => {
    if (changedId === pluginId) onChange()
  })
  const offWasm = subscribeWasmLogs((changedId) => {
    if (changedId === pluginId) onChange()
  })
  void drainWasmLogs(pluginId)
  return () => {
    offFrontend()
    offPython()
    offVscode()
    offWasm()
  }
}

export function clearPluginRuntimeLogs(pluginId: string): void {
  getPluginDebugger().clearLogs(pluginId)
  clearPythonLogs(pluginId)
  clearVscodeLogs(pluginId)
  clearWasmLogs(pluginId)
}
