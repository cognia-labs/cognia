/**
 * In-memory registry mapping a subagent `runId` to the cancellation handler
 * owned by its runtime, for the subagents that have no run row to stop yet.
 *
 * A launched child is stopped through its run (`stopRunTree`, with the stop
 * the launcher registered in `lib/execution/run-stops.ts`). Two producers fill
 * this registry for what comes before or instead of that:
 *
 *   - `dispatch-run.ts`, from the dispatch's start until it is launched (its
 *     definition is being resolved, an approval routed), and on every
 *     terminal path it unregisters. The same cancellation is handed to the
 *     launcher as the run's stop, so both reach one adapter.
 *   - `sdk-subagent-bridge.ts`, for an in-turn SDK `Task`, which never gets a
 *     run row: its handler is the SDK's `stopTask`.
 *
 * `cancelChildRun` (`cancel-subagent.ts`) picks between the two. Mirrors
 * `lib/workflow/runtime/run-cancel-registry.ts` — one process-wide map, no
 * React/Zustand coupling, safe to import from any runtime module.
 */

export type SubagentCancellationHandler = (reason?: string) => void | Promise<void>

const subagentCancellations = new Map<string, SubagentCancellationHandler>()

/** Register a live run's runtime-specific cancellation adapter. */
export function registerSubagentCancellation(
  runId: string,
  handler: SubagentCancellationHandler
): void {
  subagentCancellations.set(runId, handler)
}

/** Register a live subagent run's abort controller. */
export function registerSubagentRun(runId: string, controller: AbortController): void {
  registerSubagentCancellation(runId, (reason) => {
    controller.abort(new Error(reason ?? "Subagent run cancelled by request"))
  })
}

/** Drop a subagent run from the registry. Called on every terminal path. */
export function unregisterSubagentRun(runId: string): void {
  subagentCancellations.delete(runId)
}

/**
 * Abort an in-flight subagent run by id. Returns `true` when a live run was
 * found and signalled, `false` when no run with that id is currently executing
 * in this runtime.
 */
export function requestCancelSubagentRun(runId: string, reason?: string): boolean {
  const cancel = subagentCancellations.get(runId)
  if (!cancel) return false
  subagentCancellations.delete(runId)
  try {
    void Promise.resolve(cancel(reason)).catch(() => undefined)
  } catch {
    // The request still reached the registered runtime. Its terminal event or
    // diagnostics owns surfacing a synchronous adapter failure.
  }
  return true
}

/** Await the runtime's cancellation receipt before announcing a completed stop. */
export async function requestCancelSubagentRunAndWait(
  runId: string,
  reason?: string
): Promise<boolean> {
  const cancel = subagentCancellations.get(runId)
  if (!cancel) return false
  subagentCancellations.delete(runId)
  try {
    await cancel(reason)
    return true
  } catch {
    return false
  }
}

/**
 * How many subagent runs are registered right now. A test seam only: the
 * dispatch suites assert that every run they start deregisters itself. No
 * production code reads it.
 */
export function __liveSubagentRunCountForTesting(): number {
  return subagentCancellations.size
}
