/**
 * CRUD layer for the `connectorDrafts` Dexie table (schema v18).
 *
 * Outbound message drafts awaiting human approval (manual connector mode).
 * Drafts start as "pending", and are transitioned to "approved", "rejected",
 * or "expired" (via a sweep of past-`expiresAt` rows).
 */

import type { ConnectorDraftRow } from "./connector-types"
import type { MessageSegment } from "@/types/connectors/segment"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { getDb } from "./schema"
import { resolveSessionProjectId } from "./project-scope"
import { publishSyncInvalidate } from "@/lib/sync/host-invalidate"

/**
 * Companion fan-out (ADR-0131): drafts are mirrored in full to thin clients,
 * so every status write here bumps the indexed `updatedAt` (v173 sync
 * cursor) and asks paired clients to re-pull. Coalesced + best-effort.
 */
function invalidate(conversationKey?: string): void {
  publishSyncInvalidate("connectorDrafts", conversationKey)
}

function newId(): string {
  return "cdr_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export interface CreateDraftInput {
  /** Host execution that produced this content; approval never declassifies it. */
  personalExecutionRunId?: string
  conversationKey: string
  sessionId: string
  segments: MessageSegment[]
  sourceMessageId?: string
  expiresAt?: number
  outboundPreview?: OutboundRequest
}

/**
 * Build the row {@link createDraft} would write, without writing it. For a
 * caller that adds the draft inside its own transaction (the outbound runner
 * holds a job and writes its draft atomically); the project lookup reads the
 * session table, so it runs here, before that transaction.
 */
export async function prepareDraftRow(input: CreateDraftInput): Promise<ConnectorDraftRow> {
  return {
    id: newId(),
    conversationKey: input.conversationKey,
    sessionId: input.sessionId,
    // Workspace isolation (Dexie v86): a draft inherits its session's workspace.
    projectId: await resolveSessionProjectId(input.sessionId),
    segments: input.segments,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: input.expiresAt,
    sourceMessageId: input.sourceMessageId,
    outboundPreview: input.outboundPreview,
    personalExecutionRunId: input.personalExecutionRunId,
  }
}

export async function createDraft(input: CreateDraftInput): Promise<ConnectorDraftRow> {
  const row = await prepareDraftRow(input)
  await getDb().connectorDrafts.add(row)
  invalidate(input.conversationKey)
  return row
}

/**
 * List pending drafts for a conversation, ordered by createdAt ascending (FIFO).
 */
export async function listPendingForConversation(
  conversationKey: string
): Promise<ConnectorDraftRow[]> {
  return getDb()
    .connectorDrafts.where("[conversationKey+createdAt]")
    .between([conversationKey, -Infinity], [conversationKey, Infinity])
    .filter((r) => r.status === "pending")
    .toArray()
}

/**
 * List every pending draft across all conversations, newest-first. Used by
 * the mobile draft-approval panel so the user sees one global queue.
 */
export async function listAllPendingDrafts(): Promise<ConnectorDraftRow[]> {
  const rows = await getDb().connectorDrafts.where("status").equals("pending").toArray()
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

/** Read one draft by id (undefined when absent). */
export async function getDraft(id: string): Promise<ConnectorDraftRow | undefined> {
  return getDb().connectorDrafts.get(id)
}

async function transition(
  id: string,
  status: Exclude<ConnectorDraftRow["status"], "pending">,
  patch?: Pick<ConnectorDraftRow, "approvedJobId">
): Promise<boolean> {
  const db = getDb()
  let conversationKey: string | undefined
  const transitioned = await db.transaction("rw", db.connectorDrafts, async () => {
    const row = await db.connectorDrafts.get(id)
    if (!row || row.status !== "pending") return false
    conversationKey = row.conversationKey
    await db.connectorDrafts.update(id, {
      status,
      ...(patch?.approvedJobId ? { approvedJobId: patch.approvedJobId } : {}),
      updatedAt: Date.now(),
    })
    return true
  })
  if (transitioned) invalidate(conversationKey)
  return transitioned
}

/** Approve a pending draft — transitions status to "approved" iff still pending. */
export async function approveDraft(
  id: string,
  patch?: { approvedJobId?: string }
): Promise<boolean> {
  return transition(id, "approved", patch)
}

/** Reject a pending draft — transitions status to "rejected" iff still pending. */
export async function rejectDraft(id: string): Promise<boolean> {
  return transition(id, "rejected")
}

/**
 * Sweep pending drafts whose `expiresAt < now`, set their status to "expired".
 * Runs inside one transaction and re-verifies each row is still `pending` so a
 * concurrent approval or rejection is never overwritten by a stale snapshot.
 */
export async function sweepExpired(now = Date.now()): Promise<number> {
  const db = getDb()
  const swept = await db.transaction("rw", db.connectorDrafts, async () => {
    const expired = await db.connectorDrafts
      .where("status")
      .equals("pending")
      .filter((r) => r.expiresAt !== undefined && r.expiresAt < now)
      .toArray()
    let count = 0
    for (const row of expired) {
      const fresh = await db.connectorDrafts.get(row.id)
      if (!fresh || fresh.status !== "pending") continue
      if (fresh.expiresAt === undefined || fresh.expiresAt >= now) continue
      await db.connectorDrafts.update(row.id, { status: "expired", updatedAt: now })
      count += 1
    }
    return count
  })
  if (swept > 0) invalidate()
  return swept
}
