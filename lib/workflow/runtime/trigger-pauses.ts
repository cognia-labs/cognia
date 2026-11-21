/**
 * Runtime pause overrides for PUBLISHED workflow triggers (WF-07).
 *
 * The Scheduler's pause used to flip `node.data.disabled` on the DRAFT and
 * then register that draft natively. Both halves were wrong: a draft is not
 * what runs (admission pins the deployment), and the next publish or boot
 * reconcile re-registered the deployed version — whose node was still
 * enabled — so a paused schedule silently resumed.
 *
 * A pause is now an operator override, not an edit. It lives on the workflow
 * row as `triggerPauses` (trigger node id → when it was paused), outside the
 * graph: versions never carry it, editor saves keep it, and every trigger
 * projection (`projectWorkflowTriggerRegistrations`) registers a paused
 * trigger disabled. The row is synced to paired phones, so their pause /
 * resume button reads the same state.
 */

import { getDb } from "@/lib/db/schema"
import type { VisualWorkflow } from "@/types/workflow/visual"
import type { WorkflowTriggerProjectionResult } from "./reconcile-trigger-registrations"

/** Trigger ids paused on this workflow row. */
export function pausedTriggerIdsOf(
  workflow: Pick<VisualWorkflow, "triggerPauses"> | undefined
): ReadonlySet<string> {
  return new Set(Object.keys(workflow?.triggerPauses ?? {}))
}

/** Whether one trigger of this workflow is paused. */
export function isWorkflowTriggerPaused(
  workflow: Pick<VisualWorkflow, "triggerPauses"> | undefined,
  triggerId: string
): boolean {
  return Object.prototype.hasOwnProperty.call(workflow?.triggerPauses ?? {}, triggerId)
}

export class WorkflowTriggerPauseError extends Error {
  constructor(
    readonly code: "workflow-not-found",
    message: string
  ) {
    super(message)
    this.name = "WorkflowTriggerPauseError"
  }
}

/**
 * Pause or resume one trigger and re-project the workflow's registrations so
 * the native daemon follows at once. `updatedAt` moves so companion sync
 * carries the new state to paired devices; the graph is untouched, so the
 * draft and every version keep their content.
 */
export async function setWorkflowTriggerPaused(
  workflowId: string,
  triggerId: string,
  paused: boolean,
  at: number = Date.now()
): Promise<WorkflowTriggerProjectionResult> {
  const db = getDb()
  const updated = await db.transaction("rw", db.workflows, async () => {
    const row = await db.workflows.get(workflowId)
    if (!row) return undefined
    const pauses = { ...(row.triggerPauses ?? {}) }
    if (paused) pauses[triggerId] = pauses[triggerId] ?? at
    else delete pauses[triggerId]
    const next: VisualWorkflow = {
      ...row,
      triggerPauses: Object.keys(pauses).length > 0 ? pauses : undefined,
      updatedAt: Math.max(at, row.updatedAt + 1),
    }
    if (next.triggerPauses === undefined) delete next.triggerPauses
    await db.workflows.put(next)
    return next
  })
  if (!updated) {
    throw new WorkflowTriggerPauseError("workflow-not-found", `Workflow ${workflowId} not found`)
  }
  const { projectWorkflowTriggerRegistrations } = await import("./reconcile-trigger-registrations")
  return (await projectWorkflowTriggerRegistrations(updated)) ?? { ok: true }
}
