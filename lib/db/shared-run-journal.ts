import type { StoredMessage } from "@cognia/agent-config-types"

import { stableHash } from "@/lib/notifications/result/materiality"

import { getDb, type CogniaDB } from "./schema"

export interface SharedRunJournal {
  runId: string
  leaseId: string
  token: string
  deviceId: string
  queueItemId?: string
  baselineMessageIds: string[]
  terminalStatus?: "completed" | "failed" | "cancelled"
}

/**
 * Replay proof for a host-owned operation, atomic with its transcript reply.
 * Unlike paired lease credentials, it follows the transcript database's
 * encryption policy and contains no credentials. Deletion keeps only a
 * content-free tombstone; the request fingerprint is a SHA-256 digest.
 */
export interface AgentTurnOperationCompletion {
  version: 1
  operationId: string
  requestFingerprint: string
  sessionId: string
  /** Present from first admission, before any engine dispatch or reply. */
  userMessageId?: string
  /** Rows this operation's reply wrote; deleting any of them voids the replay. */
  replyMessageIds?: string[]
  /** {@link operationTranscriptDigest} of the prompt and reply rows as committed. */
  transcriptDigest?: string
  deleted?: true
  result?: import("@cognia/plugin-sdk/api/agent-turn").PluginAgentTurnResult
  executionRunId?: string
  approvalRunId?: string | null
  usageBooking?: {
    booking: { operationId: string; sessionId: string; runId?: string; projectId?: string }
    costAuthority: boolean
    sendOptions: Pick<
      import("@cognia/agent-config-types").SendOptions,
      "model" | "provider" | "turnId"
    >
    usage?: import("@/lib/claude/adapter").UsageInfo
  }
}

export interface SharedRunJournalRow {
  id: string
  journal?: SharedRunJournal
  send?: SharedSendJournal
  agentTurnOperation?: AgentTurnOperationCompletion
}

export interface SharedSendJournal {
  attachmentIds?: string[]
  messageId: string
  parts: unknown[]
  createdAt: number
  /**
   * `metadata.mentions` / `metadata.promptPreamble` to publish with the row.
   * Kept in the journal so a retried send carries the same citations the
   * first attempt computed.
   */
  metadata?: Record<string, unknown>
}

/**
 * Must participate in the transaction that removes the transcript. Without
 * `removedMessageIds` (a clear or cascade) every operation of the sessions is
 * voided; with it, only operations whose prompt or reply rows were removed.
 */
export async function tombstoneAgentTurnOperations(
  sessionIds: ReadonlySet<string>,
  db = getDb(),
  removedMessageIds?: ReadonlySet<string>
): Promise<void> {
  await db.sharedRunJournals
    .filter((row) =>
      Boolean(
        row.agentTurnOperation &&
        sessionIds.has(row.agentTurnOperation.sessionId) &&
        (!removedMessageIds ||
          !row.agentTurnOperation.userMessageId ||
          removedMessageIds.has(row.agentTurnOperation.userMessageId) ||
          row.agentTurnOperation.replyMessageIds?.some((id) => removedMessageIds.has(id)))
      )
    )
    .modify((row) => {
      const completion = row.agentTurnOperation!
      row.agentTurnOperation = {
        version: 1,
        operationId: completion.operationId,
        requestFingerprint: completion.requestFingerprint,
        sessionId: completion.sessionId,
        deleted: true,
      }
    })
}

/**
 * Synchronous digest of an operation's prompt and reply rows, so it can run
 * inside the commit transaction. Replay is refused unless every row is still
 * present, live, in the session and unchanged; that holds for every writer,
 * including plugin repository and raw-table mutations that never tombstone.
 */
export function operationTranscriptDigest(
  rows: readonly (StoredMessage | undefined)[],
  sessionId: string
): string | undefined {
  if (
    rows.length === 0 ||
    rows.some((row) => !row || row.sessionId !== sessionId || row.metadata?.deletedAt !== undefined)
  )
    return undefined
  // Plain JSON: stored rows can come from another realm (structured clone),
  // which a prototype-checking stable stringify would collapse to a constant.
  return stableHash(JSON.stringify(rows.map((row) => [row!.id, row!.role, row!.parts])))
}

function encryptedDatabase(db: CogniaDB): CogniaDB {
  if (!db.name.startsWith("cognia-account-")) {
    throw new Error("Shared execution recovery requires an encrypted account database")
  }
  return db
}

// Existing message/session tables are portable; lease credentials must remain
// on their issuing device. A separate governed table owns this recovery data.
export async function putSharedRunJournal(
  id: string,
  journal: SharedRunJournal,
  db = getDb()
): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.put({ id, journal })
}

export async function getSharedRunJournal(
  id: string,
  db = getDb()
): Promise<SharedRunJournal | undefined> {
  return (await encryptedDatabase(db).sharedRunJournals.get(id))?.journal
}

export async function deleteSharedRunJournal(id: string, db = getDb()): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.delete(id)
}

export async function putSharedSendJournal(
  id: string,
  send: SharedSendJournal,
  db = getDb()
): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.put({ id: `send:${id}`, send })
}

export async function getSharedSendJournal(
  id: string,
  db = getDb()
): Promise<SharedSendJournal | undefined> {
  return (await encryptedDatabase(db).sharedRunJournals.get(`send:${id}`))?.send
}

export async function deleteSharedSendJournal(id: string, db = getDb()): Promise<void> {
  await encryptedDatabase(db).sharedRunJournals.delete(`send:${id}`)
}
