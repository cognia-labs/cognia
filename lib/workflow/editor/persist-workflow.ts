/**
 * Persist the current editor store through the canonical Dexie write path,
 * then mark the store saved and re-validate. `replaceWorkflow` owns trigger
 * projection for every writer, so this helper must not register twice.
 *
 * Returns validation and publication outcomes so callers can surface their
 * own toast. Saves are never blocked on validation — a dirty draft is allowed
 * on disk.
 *
 * The write carries the snapshot taken here, not whatever the editor holds
 * when it lands. The store's `editRevision` is captured with that snapshot, so
 * an edit made while the write is in flight keeps the editor dirty
 * (`editedDuringSave`) instead of being reported as saved.
 *
 * The issue count is computed synchronously from the exact snapshot being
 * written, never read from `validationByStepId`. That map is the Inspector's
 * debounced per-field cache: an edit made inside its window (or whose queued
 * revalidation was lost) left it describing params the node no longer had,
 * and a save toast built from it reported "1 unresolved issue" for a workflow
 * whose required field had just been filled in.
 */

import type { WorkflowTriggerProjectionResult } from "@/lib/workflow/runtime/reconcile-trigger-registrations"
import { replaceWorkflow } from "@/lib/db/workflows"
import type { EditorStore } from "@/lib/workflow/editor/store"
import { queueWorkflowSaveOnHost } from "@/lib/workflow/remote/host-writes"
import { workflowWriteAuthority } from "@/lib/workflow/remote/write-authority"
import { validateAllNodes } from "@/lib/workflow/nodes/validate-params"

export interface PersistEditorWorkflowResult {
  /** Nodes with at least one param error in the workflow that was written. */
  issueCount: number
  triggerRegistration?: WorkflowTriggerProjectionResult
  publicationInvalidated: boolean
  /**
   * An edit landed while the write was in flight: the editor holds content the
   * saved row does not have, and it is still dirty. Callers that need the
   * saved row to equal the editor (publish) must not proceed.
   */
  editedDuringSave: boolean
  /**
   * The save was also queued to the paired Host that owns this workflow
   * (`lib/workflow/remote/host-writes.ts`). The Host applies it when the
   * queue delivers it; a run of the saved copy waits for that.
   */
  hostWrite: boolean
}

export async function persistEditorWorkflow(
  store: EditorStore
): Promise<PersistEditorWorkflowResult> {
  // Fold any keystroke still inside the Inspector's revalidation window into
  // the live cache before snapshotting, so badges and the toast converge.
  store.getState().flushPendingRevalidation()
  const revision = store.getState().editRevision
  const wf = store.getState().toWorkflow()
  const savedIssues = validateAllNodes(
    wf.nodes.map((node) => ({
      id: node.id,
      data: {
        kind: node.type,
        typeVersion: node.typeVersion,
        params: (node.data?.params as Record<string, unknown> | undefined) ?? {},
      },
    }))
  )
  const persisted = await replaceWorkflow(wf)
  // On a paired client the row just written is a mirror; the Host owns the
  // workflow. Queue the same definition to it before reporting the save, so
  // a queue failure leaves the editor dirty instead of "saved" on the phone
  // only. The queue carries it across reloads and retries (WF-10).
  const hostWrite = workflowWriteAuthority() === "host"
  if (hostWrite) await queueWorkflowSaveOnHost(persisted.workflow, persisted.workflow.name)
  store.getState().markSaved(persisted.workflow, { revision })
  // Re-sync the live caches with CURRENT data — the user may have kept typing
  // while the write was in flight, so this can differ from `savedIssues`.
  store.getState().revalidateAll()
  store.getState().recomputeDiagnostics()
  return {
    issueCount: Object.keys(savedIssues).length,
    ...(persisted.triggerRegistration
      ? { triggerRegistration: persisted.triggerRegistration }
      : {}),
    publicationInvalidated: persisted.publicationInvalidated,
    editedDuringSave: store.getState().editRevision !== revision,
    hostWrite,
  }
}
