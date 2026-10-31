/**
 * In-memory diagnostics for trigger projections and the crash-resume mirror.
 * This package does not persist health across process restarts; startup
 * reconciliation rebuilds registration outcomes from authoritative workflows.
 *
 * Intentionally without a reader yet (convergence 0b B2): people learn of a
 * failed registration from the editor's save toast and of a failed boot
 * re-registration from the reconciliation log, and the warn-once of a lagging
 * mirror reads `recordMirrorPersistFailure`'s return. `getWorkflowTriggerHealth`
 * and `subscribeWorkflowTriggerHealth` are the feed for the host status
 * surface ADR-0250 phase 1 adds; until then nothing renders them.
 */
export interface TriggerRegistrationOutcome {
  workflowId: string
  triggerId: string
  status: "registered" | "unregistered" | "skipped" | "failed"
  error?: string
  recordedAt: number
}

export interface MirrorPersistFailure {
  runId: string
  workflowId: string
  error: string
  recordedAt: number
}

const registrations = new Map<string, TriggerRegistrationOutcome>()
const listeners = new Set<() => void>()
/** Runs whose mirror failure was already reported; bounded, oldest first out. */
const reportedMirrorRuns = new Set<string>()
export const REPORTED_MIRROR_RUNS_CAP = 1024
let lastMirrorPersistFailure: MirrorPersistFailure | null = null

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A diagnostic observer cannot change the outcome it is observing.
    }
  }
}

export function recordTriggerRegistration(
  outcome: Omit<TriggerRegistrationOutcome, "recordedAt">
): void {
  registrations.set(JSON.stringify([outcome.workflowId, outcome.triggerId]), {
    ...outcome,
    recordedAt: Date.now(),
  })
  notify()
}

export function recordMirrorPersistFailure(
  runId: string,
  workflowId: string,
  error: unknown
): boolean {
  const firstFailure = !reportedMirrorRuns.has(runId)
  reportedMirrorRuns.add(runId)
  // A host whose mirror stays down fails every run; keep the newest ids only.
  // An evicted run reports once more, which beats unbounded growth.
  while (reportedMirrorRuns.size > REPORTED_MIRROR_RUNS_CAP) {
    const oldest = reportedMirrorRuns.values().next().value
    if (oldest === undefined) break
    reportedMirrorRuns.delete(oldest)
  }
  lastMirrorPersistFailure = {
    runId,
    workflowId,
    error: error instanceof Error ? error.message : String(error),
    recordedAt: Date.now(),
  }
  notify()
  return firstFailure
}

export function getWorkflowTriggerHealth() {
  return {
    registrations: [...registrations.values()],
    lastMirrorPersistFailure,
  }
}

export function subscribeWorkflowTriggerHealth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetWorkflowTriggerHealthForTest(): void {
  reportedMirrorRuns.clear()
  registrations.clear()
  lastMirrorPersistFailure = null
  listeners.clear()
}
