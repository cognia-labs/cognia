/**
 * The refusal to load a Python plugin whose environment is not ready (ENV01,
 * ADR-0258), and the one pattern that recognises it after it was stringified.
 *
 * The message travels as text: into the plugin store's error, the lifecycle
 * record's `lastError` and the enable-failed event. The error classifier reads
 * it to word the failure and offer to prepare; the plugin manager reads the
 * lifecycle record to start the plugin again once the preparation succeeded.
 * Both use {@link readDependenciesNotReady}, so the shape is defined here only.
 *
 * Zod-free on purpose: the enable-failure toaster is mounted at the app root.
 */
import type { PythonReadiness } from "@/lib/plugin/python/readiness"

/** The states that refuse a load, as the message names them. */
export type NotReadyState = "not-prepared" | "needs-uv" | "stale" | "preparing" | "failed"

export class PythonDependenciesNotReadyError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly readiness: PythonReadiness
  ) {
    super(
      `Cannot load Python plugin "${pluginId}": its Python dependencies are not ready (${readiness.state})`
    )
    this.name = "PythonDependenciesNotReadyError"
  }
}

/**
 * Not anchored: `PluginEnableError` wraps the message in its own prefix, and
 * the store keeps the class name in front of it.
 */
export const PYTHON_DEPENDENCIES_NOT_READY_PATTERN =
  /Cannot load Python plugin "([^"]+)": its Python dependencies are not ready \((not-prepared|needs-uv|stale|preparing|failed)\)/

/** The plugin and state a stringified refusal names, or `null` for any other text. */
export function readDependenciesNotReady(
  message: string | null | undefined
): { pluginId: string; state: NotReadyState } | null {
  const match = message?.match(PYTHON_DEPENDENCIES_NOT_READY_PATTERN)
  if (!match?.[1] || !match[2]) return null
  return { pluginId: match[1], state: match[2] as NotReadyState }
}
