/**
 * Who wants to know that a crashed agent run was resumed (ADR-0090).
 *
 * The run-control `resume` command (`./control-handlers.ts`) brings a crashed
 * run back; a feature that parked work behind it continues its own side. The
 * connector runtime resumes its durable inbound jobs, which wait on the run
 * (`lib/connectors/bootstrap/install-connector-runtime.ts`). It registers
 * where it runs, so the kernel names no feature.
 */

type RunResumedListener = (runId: string) => void | Promise<void>

const listeners = new Set<RunResumedListener>()

/** Listen for resumed runs; returns the unsubscribe. */
export function onAgentRunResumed(listener: RunResumedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Tell every listener that `runId` was resumed, and wait for them. A
 * listener's failure rejects, so the `resume` command reports it.
 */
export async function notifyAgentRunResumed(runId: string): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener(runId)))
}
