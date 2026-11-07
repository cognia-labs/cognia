/**
 * Run-scoped resources a node family owns outside the workflow engine, and
 * how the engine releases them when a run ends however it ended.
 *
 * A family that opens something that outlives a step (the terminal module's
 * session nodes open PTYs) registers a releaser when it loads; the
 * orchestrator calls every releaser once per run. The engine so never imports
 * the module that owns the resource (ADR-0250 §14 `workflowNodes`). Release is
 * best effort: a releaser that throws is logged and the others still run, and
 * a failure never masks the run's result.
 */

import { loggers } from "@cognia/logging"

/** Releases what a run left open; called once when the run ends. */
export type RunResourceReleaser = (runId: string) => Promise<void>

const releasers = new Map<string, RunResourceReleaser>()

/**
 * Register a releaser under a stable name; registering the same name again
 * replaces it, so a module reloaded by a test or a hot reload is not called
 * twice.
 */
export function registerRunResourceReleaser(name: string, release: RunResourceReleaser): void {
  releasers.set(name, release)
}

/** Run every registered releaser for `runId`. Never throws. */
export async function releaseRegisteredRunResources(runId: string): Promise<void> {
  for (const [name, release] of releasers) {
    try {
      await release(runId)
    } catch (error) {
      loggers.app.warn("run resource release failed", {
        releaser: name,
        runId,
        error: String(error),
      })
    }
  }
}

export function __resetRunResourceReleasersForTesting(): void {
  releasers.clear()
}
