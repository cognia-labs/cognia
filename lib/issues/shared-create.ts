/**
 * Following a shared-organization issue create to the record it becomes.
 *
 * A create in a shared workspace is queued (`enqueueCollabMutation`) before
 * the collaboration server has answered, so the surface that filed it has no
 * id to open. When the row is delivered the queue keeps the server's id on it
 * (`createdEntityId`); this watches that one row and reports the outcome
 * once: delivered with its id, or ended without one (refused, conflicted,
 * deadlettered, or gone).
 */

import Dexie from "dexie"

import { getOutboundJob } from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

export type QueuedCreateOutcome =
  | { kind: "delivered"; entityId: string }
  | { kind: "ended"; status: MobileOutboundJobRow["status"] | "gone" }

/**
 * Statuses a row stops in without having been delivered. `failed` is not one:
 * the runner retries it.
 */
const ENDED: ReadonlySet<MobileOutboundJobRow["status"]> = new Set([
  "deadlettered",
  "conflicted",
  "rejected",
])

/** What a row says about its create, or null while it is still on its way. */
export function queuedCreateOutcome(
  row: MobileOutboundJobRow | undefined
): QueuedCreateOutcome | null {
  if (!row) return { kind: "ended", status: "gone" }
  if (row.status === "sent") {
    return row.createdEntityId
      ? { kind: "delivered", entityId: row.createdEntityId }
      : { kind: "ended", status: "sent" }
  }
  return ENDED.has(row.status) ? { kind: "ended", status: row.status } : null
}

/** Watch one queued create until it settles. Returns the disposer. */
export function followQueuedCreate(
  operationId: string,
  onSettled: (outcome: QueuedCreateOutcome) => void
): () => void {
  let done = false
  // `Dexie.liveQuery`, not the named import: see `lib/issues/notify.ts`.
  const subscription = Dexie.liveQuery(() => getOutboundJob(operationId)).subscribe({
    next: (row) => {
      if (done) return
      const outcome = queuedCreateOutcome(row)
      if (!outcome) return
      done = true
      subscription.unsubscribe()
      onSettled(outcome)
    },
    error: () => {
      if (done) return
      done = true
      onSettled({ kind: "ended", status: "gone" })
    },
  })
  return () => {
    done = true
    subscription.unsubscribe()
  }
}
