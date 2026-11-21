/**
 * The companion pull of the workflow definitions a paired client mirrors, a
 * `syncHandlers` contribution of the workflow module (ADR-0250 §14): the
 * hold below needs this module's queued Host writes, which the sync kernel
 * may not import.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { SyncCursor, SyncOutcome } from "@/lib/sync/types"
import { runSyncHandler, type SyncApplyHold } from "@/lib/sync/handlers/base"
import type { WorkflowRow } from "@/types/workflow/visual"

import { pendingWorkflowHostWriteIds } from "../remote/host-writes"

/**
 * Write pulled workflow rows, deferring any the client is still sending.
 *
 * A paired client saves into its mirror at once and ships the save to the
 * Host through the durable queue (`lib/workflow/remote/host-writes.ts`). Until
 * the Host has applied it, a delta still carries the Host's older row, and
 * writing that would put the old graph back in the editor and lose the edit
 * outright if the save then failed. Such a row is not written: the pull
 * reports it deferred, the cursor stays below it, and the first pull after
 * the write settles brings the Host's row (now the saved one) whole.
 */
export async function applyWorkflowRows(
  rows: WorkflowRow[],
  assertCurrent: () => void = () => {}
): Promise<SyncApplyHold | undefined> {
  if (rows.length === 0) return undefined
  const pending = await pendingWorkflowHostWriteIds()
  assertCurrent()
  const deferred = rows.filter((row) => pending.has(row.id))
  const writable = deferred.length === 0 ? rows : rows.filter((row) => !pending.has(row.id))
  if (writable.length > 0) await getDb().workflows.bulkPut(writable)
  if (deferred.length === 0) return undefined
  // `updatedAt` is this table's cursor watermark on the Host (`readWorkflowsDelta`).
  return {
    deferred: deferred.length,
    deferredFrom: Math.min(...deferred.map((row) => row.updatedAt)),
  }
}

/**
 * Pull visual-workflow definition upserts + tombstones from the desktop.
 *
 * Built-in workflows ship with the app on every device, so we filter them
 * out client-side as a defensive measure mirroring `syncCharacters`.
 */
export function syncWorkflows(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<WorkflowRow>(
    {
      table: "workflows",
      getTable: () => getDb().workflows,
      rowFilter: (row) => !row.isBuiltIn,
      applyRows: applyWorkflowRows,
    },
    transport,
    cursor
  )
}
