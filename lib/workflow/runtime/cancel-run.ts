/**
 * Cross-device workflow-run cancellation (ADR 0061 P4) — the single cancel
 * entry every remote surface shares (companion `workflow_cancel_run`,
 * remote-control `workflow.cancel`).
 *
 * Cancellation commits its fence before acknowledging or signalling:
 *  1. A live foreign lease receives `cancelRequestedAt`; its heartbeat or
 *     recovery driver honors the marker without starting more work.
 *  2. A locally owned or unleased row becomes durably cancelled, then a live
 *     local controller is aborted so the orchestrator releases its resources.
 *  3. With no live controller, notify companions of the soft-cancelled row.
 * Atomic admission and terminal outcome writes preserve either fence.
 */

import { getDb } from "@/lib/db/schema"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { requestCancelRun } from "./run-cancel-registry"
import { getExecutorId } from "./run-lease"
import { notifyCompanionsOfRunState } from "./companion-run-events"

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"])

export type CancelRunMode = "aborted" | "lease-signalled" | "soft-cancelled" | "noop"

export interface CancelRunResult {
  cancelled: boolean
  /** True when the run was aborted live in this process. */
  live: boolean
  mode: CancelRunMode
}

export async function cancelWorkflowRun(runId: string, reason: string): Promise<CancelRunResult> {
  const db = getDb()
  const now = Date.now()
  // Commit the cancellation fence before acknowledging it. Outcome writes and
  // startup admission share this table's transaction, so neither can revive it.
  const selected = await db.transaction("rw", db.workflowRuns, async () => {
    const row = await db.workflowRuns.get(runId)
    if (!row || TERMINAL_RUN_STATUSES.has(row.status)) return undefined
    const foreignLease = Boolean(
      row.lease && row.lease.expiresAt > now && row.lease.ownerId !== getExecutorId()
    )
    await db.workflowRuns.update(
      runId,
      foreignLease
        ? { cancelRequestedAt: now }
        : { cancelRequestedAt: now, status: "cancelled", completedAt: now }
    )
    return { row, foreignLease }
  })
  if (!selected) return { cancelled: false, live: false, mode: "noop" }
  const live = requestCancelRun(runId, reason)
  void trackEvent("workflow.run.cancelled", { runId })
  if (live) return { cancelled: true, live: true, mode: "aborted" }
  if (selected.foreignLease) return { cancelled: true, live: false, mode: "lease-signalled" }
  void notifyCompanionsOfRunState({
    runId,
    workflowId: selected.row.workflowId,
    status: "cancelled",
  })
  return { cancelled: true, live: false, mode: "soft-cancelled" }
}
