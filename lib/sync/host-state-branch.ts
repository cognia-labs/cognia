/**
 * The Host side of `message.enqueue.branch` (`HostStateMessageBranch`): a
 * paired device regenerates or edits a turn with the desktop's branch
 * semantics (`lib/chat/branch-regen.ts`), so nothing it replaces is deleted.
 *
 * Pure over the session's stored rows. The HostState store checks and writes
 * the branch in its commit transaction; the dispatcher reads the same rows
 * again to arm the reply (`lib/chat/branch-arming.ts`), which survives a Host
 * restart between the two because nothing here lives in memory.
 */

import type { UIMessage } from "ai"
import type { StoredMessage } from "@cognia/agent-config-types"
import type { HostStateMessageBranch } from "@cognia/agent-config-types/host-state"
import { tagBranchSiblings, tagEditSibling } from "@/lib/chat/branch-regen"
import type { BranchReplyArm } from "@/lib/chat/branch-arming"
import { markTurnAdmission } from "@/lib/chat/turn-admission"

export interface BranchIntent {
  messageId: string
  branch: HostStateMessageBranch
}

export interface BranchRejection {
  code: string
  message: string
}

interface BranchMeta {
  branchGroupId?: unknown
  branchIndex?: unknown
}

function metaOf(row: StoredMessage): BranchMeta {
  return (row.metadata ?? {}) as BranchMeta
}

function asMessages(rows: readonly StoredMessage[]): UIMessage[] {
  return rows as unknown as UIMessage[]
}

function asRows(messages: readonly UIMessage[]): StoredMessage[] {
  return messages as unknown as StoredMessage[]
}

function lastUserIndex(rows: readonly StoredMessage[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].role === "user") return index
  }
  return -1
}

/**
 * Why the Host cannot take this branch, or `null`. `rows` are the session's
 * messages in `createdAt` order.
 */
export function hostStateBranchRejection(
  rows: readonly StoredMessage[],
  intent: BranchIntent
): BranchRejection | null {
  if (intent.branch.kind === "regenerate") {
    const anchor = rows[lastUserIndex(rows)]
    if (!anchor) {
      return { code: "host_state_message_not_found", message: "There is no turn to regenerate." }
    }
    // Another device sent a turn since, or the turn was deleted: regenerating
    // would answer a question that is no longer the last one.
    return anchor.id === intent.messageId
      ? null
      : {
          code: "host_state_regenerate_anchor_moved",
          message: "The conversation moved on since this was pressed.",
        }
  }
  const editsMessageId = intent.branch.editsMessageId
  const original = rows.find((row) => row.id === editsMessageId)
  if (!original || original.role !== "user") {
    return { code: "host_state_message_not_found", message: "The edited message was not found." }
  }
  return null
}

export interface RegenerateBranchPlan {
  /** Rows whose metadata changed: the anchor and the replies under it. */
  upserts: StoredMessage[]
  /** Rows after the anchor that are not replies, as the desktop drops them. */
  deleteIds: string[]
  groupId: string
}

/**
 * Make every reply under the anchor a sibling of the one the turn will add.
 * The anchor's failure or wait mark goes: re-running the turn is its retry.
 */
export function planRegenerateBranch(
  rows: readonly StoredMessage[],
  anchorId: string
): RegenerateBranchPlan | null {
  const anchorIndex = rows.findIndex((row) => row.id === anchorId)
  if (anchorIndex < 0 || anchorIndex !== lastUserIndex(rows)) return null
  const { merged } = tagBranchSiblings(asMessages(rows), anchorIndex, () => anchorId)
  const marked = asRows(markTurnAdmission(merged, anchorId, null))
  const kept = new Set(marked.map((row) => row.id))
  const before = new Map(rows.map((row) => [row.id, row]))
  return {
    upserts: marked.filter((row) => !sameMetadata(before.get(row.id)!, row)),
    deleteIds: rows.filter((row) => !kept.has(row.id)).map((row) => row.id),
    groupId: anchorId,
  }
}

export interface EditBranchPlan {
  /** The original, now a sibling, and the replies it keeps. */
  upserts: StoredMessage[]
  groupId: string
  /** The `branchIndex` the replacement takes. */
  index: number
}

/** Make the original a sibling of its replacement and hang its replies off it. */
export function planEditBranch(
  rows: readonly StoredMessage[],
  editsMessageId: string
): EditBranchPlan | null {
  const editedIndex = rows.findIndex((row) => row.id === editsMessageId)
  if (editedIndex < 0 || rows[editedIndex].role !== "user") return null
  const { merged, groupId, nextIndex } = tagEditSibling(asMessages(rows), editedIndex)
  const tagged = asRows(merged)
  return {
    upserts: tagged.filter((row, index) => !sameMetadata(rows[index], row)),
    groupId,
    index: nextIndex,
  }
}

function sameMetadata(left: StoredMessage, right: StoredMessage): boolean {
  return JSON.stringify(left.metadata ?? {}) === JSON.stringify(right.metadata ?? {})
}

/**
 * What the reply this turn produces must be stamped with, read from rows the
 * store already branched. A regenerate's reply takes the group's next slot; an
 * edit's replies hang off the replacement.
 */
export function hostStateBranchReplyArm(
  rows: readonly StoredMessage[],
  intent: BranchIntent
): Omit<BranchReplyArm, "turnId"> {
  if (intent.branch.kind === "edit") return { owner: intent.messageId }
  let next = 0
  for (const row of rows) {
    const meta = metaOf(row)
    if (meta.branchGroupId !== intent.messageId) continue
    const index = typeof meta.branchIndex === "number" ? meta.branchIndex : 0
    next = Math.max(next, index + 1)
  }
  return { tag: { groupId: intent.messageId, index: next } }
}
