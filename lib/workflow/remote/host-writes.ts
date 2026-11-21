/**
 * A paired client's workflow writes, shipped to the Host that owns them.
 *
 * On a paired phone the editor used to save into the local Dexie mirror and
 * stop there: the Host never learned of the edit, its next sync pull put the
 * old row back, and pressing Run executed whatever the Host had. Now every
 * create and save the client makes keeps its optimistic mirror write AND goes
 * to the Host through the durable outbound queue (`workflow_create` /
 * `workflow_update`), so it survives a reload, retries with one idempotency
 * key, and is visible in the queue UI when it fails.
 *
 * Every write for one workflow rides the channel `workflow:<id>`. The queue
 * dispatches only a channel's lowest outstanding sequence, so a create always
 * reaches the Host before the saves that follow it, and a run that waits for
 * {@link awaitWorkflowHostWritesSettled} runs the last save, not an older one.
 *
 * Saves carry the whole definition, so of two saves the Host has not seen only
 * the later one says anything: an unsent earlier save is dropped when a newer
 * one is queued (the same collapse the queue applies to HostState drafts).
 */

import { getDb } from "@/lib/db/schema"
import { enqueueOnChannel } from "@/lib/db/mobile-outbound-queue"
import type { MobileOutboundJobRow, MobileOutboundStatus } from "@/lib/db/mobile-outbound-types"
import { createWorkflow, type WorkflowDraft } from "@/lib/db/workflows"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { VisualWorkflow, WorkflowRow } from "@/types/workflow/visual"

import { workflowWriteAuthority } from "./write-authority"

/** The queued commands that carry a workflow definition to the Host. */
export const WORKFLOW_HOST_WRITE_COMMANDS = ["workflow_create", "workflow_update"] as const

const WRITE_COMMANDS: ReadonlySet<string> = new Set(WORKFLOW_HOST_WRITE_COMMANDS)

/** Rows the Host may still apply. `failed` is never written, kept for old rows. */
const IN_FLIGHT: ReadonlySet<MobileOutboundStatus> = new Set(["pending", "sending", "failed"])

/** Rows the Host refused, or the queue gave up on. */
const REFUSED: ReadonlySet<MobileOutboundStatus> = new Set([
  "deadlettered",
  "rejected",
  "conflicted",
])

export function workflowHostChannel(workflowId: string): string {
  return `workflow:${workflowId}`
}

/**
 * The definition fields an editor owns. Identity, timestamps, the publication
 * projection and derivation markers are the Host's, and its writers ignore
 * them anyway.
 */
const DEFINITION_FIELDS = [
  "name",
  "description",
  "icon",
  "tags",
  "nodes",
  "edges",
  "settings",
  "credentials",
  "viewport",
  "isTemplate",
  "folderId",
  "complexity",
  "variables",
  "pinData",
  "staticData",
] as const satisfies ReadonlyArray<keyof VisualWorkflow>

/**
 * The definition as the wire carries it. A field the editor cleared is sent as
 * `null` rather than left out: JSON drops `undefined`, and a missing key in a
 * patch means "keep the Host's value", which would resurrect a cleared
 * description or pin set on the Host.
 */
export function workflowDefinitionPayload(workflow: VisualWorkflow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of DEFINITION_FIELDS) {
    const value = workflow[field]
    out[field] = value === undefined ? null : value
  }
  return out
}

/** Rows queued for the Host this client is routed to now; another target's rows are not its. */
function inActiveScope(row: MobileOutboundJobRow): boolean {
  const scope = getActiveRuntimeTargetContext()
  return !scope || (row.accountId === scope.accountId && row.targetId === scope.targetId)
}

function workflowIdOf(row: MobileOutboundJobRow): string | undefined {
  if (!WRITE_COMMANDS.has(row.command)) return undefined
  const id = (row.payload as { id?: unknown } | undefined)?.id
  return typeof id === "string" && id ? id : undefined
}

/** Queue the Host-side creation of a workflow this client just created. */
export async function queueWorkflowCreateOnHost(
  workflow: VisualWorkflow,
  label?: string
): Promise<MobileOutboundJobRow> {
  return enqueueOnChannel({
    command: "workflow_create",
    payload: { id: workflow.id, draft: workflowDefinitionPayload(workflow) },
    channel: workflowHostChannel(workflow.id),
    ...(label ? { label } : {}),
  })
}

/**
 * Create a workflow the user authored in this process, wherever it belongs.
 *
 * Every authoring surface that adds a workflow (the create dialog, import, a
 * template, extract-to-subworkflow) goes through here. Off a paired client it
 * is `createWorkflow`. On one, the mirror row is created first, so the editor
 * opens on it at once, and the same row, under the same id, is queued to the
 * Host. If the queue will not take it, the mirror row is removed again: a
 * workflow the Host never hears of would accept saves that all fail.
 */
export async function createAuthoredWorkflow(draft: WorkflowDraft): Promise<WorkflowRow> {
  const row = await createWorkflow(draft)
  if (workflowWriteAuthority() !== "host") return row
  try {
    await queueWorkflowCreateOnHost(row, row.name)
  } catch (error) {
    // Only this call's fresh row; nothing references it yet.
    await getDb()
      .workflows.delete(row.id)
      .catch(() => undefined)
    throw error
  }
  return row
}

/** Queue a save of the whole definition to the Host, dropping any unsent older save. */
export async function queueWorkflowSaveOnHost(
  workflow: VisualWorkflow,
  label?: string
): Promise<MobileOutboundJobRow> {
  const channel = workflowHostChannel(workflow.id)
  const db = getDb()
  // Earlier saves this one makes moot: those still waiting (a retried
  // `pending` row may already be applied, which is still fine — this save
  // carries everything it did) and those the queue gave up on, whose failure
  // this save now answers for. A `sending` row is on the wire and stays.
  const superseded = await db.mobileOutboundQueue
    .where("status")
    .anyOf(["pending", ...REFUSED])
    .filter(
      (row) => row.command === "workflow_update" && row.channel === channel && inActiveScope(row)
    )
    .primaryKeys()
  if (superseded.length > 0) await db.mobileOutboundQueue.bulkDelete(superseded as string[])
  return enqueueOnChannel({
    command: "workflow_update",
    payload: { id: workflow.id, patch: workflowDefinitionPayload(workflow) },
    channel,
    ...(label ? { label } : {}),
  })
}

/**
 * Every workflow id with a create or save the Host has not applied yet. The
 * mirror pull defers those rows (see `lib/workflow/sync/workflows.ts`) so a
 * delta that predates the write cannot undo the edit on screen.
 *
 * Never throws: a Dexie failure degrades to "nothing pending", which costs a
 * flicker, where a throw would stop the table from syncing at all.
 */
export async function pendingWorkflowHostWriteIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    const rows = await getDb()
      .mobileOutboundQueue.where("status")
      .anyOf([...IN_FLIGHT])
      .toArray()
    for (const row of rows) {
      if (!inActiveScope(row)) continue
      const id = workflowIdOf(row)
      if (id) ids.add(id)
    }
  } catch {
    // See above.
  }
  return ids
}

export type WorkflowHostWriteSettlement =
  | { outcome: "settled" }
  | { outcome: "refused"; command: string; error: string }
  | { outcome: "pending" }

/**
 * Wait until the Host has applied every queued write for `workflowId`.
 *
 * `settled` when nothing is outstanding and the newest write was delivered (or
 * there never was one: a workflow that came from the Host). `refused` when the
 * newest write was given up on — the Host's copy is not what the client shows,
 * so running it would run something else. `pending` when the Host has not
 * answered within `timeoutMs`; the writes stay queued.
 */
export async function awaitWorkflowHostWritesSettled(
  workflowId: string,
  options: { timeoutMs: number; pollMs?: number }
): Promise<WorkflowHostWriteSettlement> {
  const channel = workflowHostChannel(workflowId)
  const deadline = Date.now() + options.timeoutMs
  const pollMs = options.pollMs ?? 250
  for (;;) {
    const rows = await getDb()
      .mobileOutboundQueue.filter(
        (row) => row.channel === channel && WRITE_COMMANDS.has(row.command) && inActiveScope(row)
      )
      .toArray()
    if (!rows.some((row) => IN_FLIGHT.has(row.status))) {
      const newest = rows.sort(
        (left, right) =>
          (right.clientSeq ?? 0) - (left.clientSeq ?? 0) || right.createdAt - left.createdAt
      )[0]
      if (newest && REFUSED.has(newest.status)) {
        return {
          outcome: "refused",
          command: newest.command,
          error: newest.lastError ?? newest.rejectionCode ?? newest.status,
        }
      }
      return { outcome: "settled" }
    }
    if (Date.now() >= deadline) return { outcome: "pending" }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
