/**
 * Durable, conversation-scoped QQ message ID ↔ quote-index aliases.
 * Reuses the ledger's existing compound index; no table/version migration.
 * Kept apart from pure wire parsing so a database failure cannot erase input
 * or make an already delivered message look retryable.
 */
import { getDb } from "@/lib/db/schema"
import type { InboundLedgerRow } from "@/lib/db/connector-types"
import { qqReferenceIndex, type QQScene } from "./parse"

interface QQReferenceScope {
  adapterId: string
  scene: QQScene
  sceneId: string
}
interface QQReference {
  messageId: string
  referenceIndex: string
}
const NAMESPACE = "qq-reference" as const
const ROW_CAP = 10_000

function key(scope: QQReferenceScope, kind: "id" | "index", value: string): string {
  return JSON.stringify([scope.scene, scope.sceneId, kind, value])
}

/** A conflict poisons both directions instead of silently picking a parent. */
export async function recordQQReference(
  scope: QQReferenceScope,
  messageId: string,
  referenceIndex: string,
  cap = ROW_CAP
): Promise<void> {
  if (
    !scope.adapterId ||
    !scope.sceneId ||
    !qqReferenceIndex(messageId) ||
    !qqReferenceIndex(referenceIndex)
  )
    return
  const db = getDb()
  await db.transaction("rw", db.inboundLedger, async () => {
    const keys = [key(scope, "id", messageId), key(scope, "index", referenceIndex)]
    const rows = await Promise.all(
      keys.map((id) =>
        db.inboundLedger
          .where("[adapterId+namespace+platformMessageId]")
          .equals([scope.adapterId, NAMESPACE, id])
          .first()
      )
    )
    const conflict = rows.some(
      (row) =>
        row &&
        (!row.qqReference ||
          row.qqReference.messageId !== messageId ||
          row.qqReference.referenceIndex !== referenceIndex)
    )
    const invalidated = new Set(keys)
    if (conflict)
      for (const row of rows)
        if (row?.qqReference) {
          invalidated.add(key(scope, "id", row.qqReference.messageId))
          invalidated.add(key(scope, "index", row.qqReference.referenceIndex))
        }
    const now = Date.now()
    await db.inboundLedger.bulkPut(
      [...invalidated].map((id): InboundLedgerRow => ({
        id: `${scope.adapterId}:${NAMESPACE}:${id}`,
        adapterId: scope.adapterId,
        namespace: NAMESPACE,
        platformMessageId: id,
        receivedAt: now,
        qqReference: conflict ? null : { messageId, referenceIndex },
      }))
    )
    const overflow = (await db.inboundLedger.where("namespace").equals(NAMESPACE).count()) - cap
    if (overflow > 0) {
      const oldest = await db.inboundLedger
        .orderBy("receivedAt")
        .filter((row) => row.namespace === NAMESPACE)
        .limit(overflow)
        .primaryKeys()
      await db.inboundLedger.bulkDelete(oldest as string[])
    }
  })
}

/** Verify both directions: pruning or corruption fails closed. */
export async function findQQReference(
  scope: QQReferenceScope,
  target: { messageId: string } | { referenceIndex: string }
): Promise<QQReference | undefined> {
  try {
    const db = getDb()
    return await db.transaction("r", db.inboundLedger, async () => {
      const kind = "messageId" in target ? "id" : "index"
      const value = "messageId" in target ? target.messageId : target.referenceIndex
      if (!qqReferenceIndex(value)) return undefined
      const row = await db.inboundLedger
        .where("[adapterId+namespace+platformMessageId]")
        .equals([scope.adapterId, NAMESPACE, key(scope, kind, value)])
        .first()
      const reference = row?.qqReference
      if (!reference) return undefined
      const reverse = await db.inboundLedger
        .where("[adapterId+namespace+platformMessageId]")
        .equals([
          scope.adapterId,
          NAMESPACE,
          key(
            scope,
            kind === "id" ? "index" : "id",
            kind === "id" ? reference.referenceIndex : reference.messageId
          ),
        ])
        .first()
      return reverse?.qqReference?.messageId === reference.messageId &&
        reverse.qqReference.referenceIndex === reference.referenceIndex
        ? reference
        : undefined
    })
  } catch {
    // Unavailable aliases must never be guessed or used as real message IDs.
    return undefined
  }
}
