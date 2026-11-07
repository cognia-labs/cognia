/**
 * How each child run this process is executing is stopped, keyed by its
 * execution run id (ADR-0252 §3).
 *
 * The launcher registers every child it starts, for as long as its engine
 * runs: the engine's own stop, or the stop the caller handed it when stopping
 * means more than aborting (`dispatch_agent` records the cancellation in the
 * background outbox first; a Job Center agent is cancelled through the
 * background-agent manager). The `job` run-control handler stops through here,
 * so a stop pressed anywhere reaches the same function the engine registered.
 *
 * In-process only: a run another host executes has no entry here, and its
 * stop travels to that host through run control.
 */

export type RunStop = (reason?: string) => void | Promise<void>

const stops = new Map<string, RunStop>()

/**
 * Register how `runId` is stopped. Returns the unregister, which removes only
 * this registration (a later one for the same run is left alone). With
 * `ifAbsent`, an existing registration is kept and nothing is registered.
 */
export function registerRunStop(
  runId: string,
  stop: RunStop,
  options: { ifAbsent?: boolean } = {}
): () => void {
  if (options.ifAbsent && stops.has(runId)) return () => undefined
  stops.set(runId, stop)
  return () => {
    if (stops.get(runId) === stop) stops.delete(runId)
  }
}

/** True while `runId` has a registered stop in this process. */
export function hasRunStop(runId: string): boolean {
  return stops.has(runId)
}

/**
 * Stop `runId`. Resolves `true` when its registered stop ran and finished (a
 * stop that persists its intent resolves after the write), `false` when
 * nothing is registered or the stop threw. The registration stays until the
 * engine settles and the launcher removes it, so a stop that failed can be
 * pressed again; every registered stop is safe to call twice.
 */
export async function stopRegisteredRun(runId: string, reason?: string): Promise<boolean> {
  const stop = stops.get(runId)
  if (!stop) return false
  try {
    await stop(reason)
    return true
  } catch {
    return false
  }
}

/** Test-only: forget every registration. */
export function __resetRunStopsForTesting(): void {
  stops.clear()
}
