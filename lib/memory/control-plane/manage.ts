import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { getSettings } from "@/lib/db/settings"
import {
  getMemory,
  hardDeleteMemory,
  invalidateMemory,
  listMemories,
  moveMemoryToNamespace,
  recordRetrievalFeedback,
  restoreArchivedMemory,
  restoreMemoryRevision,
  setMemoryPinned,
  updateMemory,
  type ListMemoriesQuery,
  type MemoryNamespaceTarget,
} from "@/lib/db/memories"
import type { RetrievalFeedbackVerdict } from "@cognia/memory/lifecycle/retrieval-feedback"
import { appendMemoryAuditEvent, createMemoryEvidence } from "@/lib/db/memory-governance"
import { noteMemoryVectorFailure } from "@/lib/memory/lifecycle/enqueue-reconcile"
import { tryBuildMemoryVectorSink } from "@/lib/memory/runtime/build-deps"
import { storeMemoryCore } from "@/lib/memory/api/store-memory"
import { resolveMemoryConfig, type MemoryScope, type MemoryType } from "@/types/memory/memory"
import { recordMemoryConflictGovernance } from "@/lib/governance/producers/memory"
import { reportGovernanceProjectionFailure } from "@/lib/db/governance-ledger"

export type ManageMemoryCommand =
  | {
      kind: "create"
      text: string
      type: MemoryType
      importance: number
      tags: string[]
      scope?: MemoryScope
      characterId?: string
      projectId?: string
      agentId?: string
      branch?: string
      pathPattern?: string
    }
  | {
      kind: "update"
      id: string
      patch: { text?: string; tags?: string[]; importance?: number; key?: string }
    }
  | { kind: "pin"; id: string; pinned: boolean }
  | { kind: "review"; id: string; status: "verified" | "conflict" }
  /**
   * A verdict on a memory the user just saw recalled. Ranking only — see
   * `applyRetrievalFeedback` for why `wrong` deliberately does NOT become
   * `reviewStatus: "conflict"`.
   */
  | { kind: "retrieval-feedback"; id: string; verdict: RetrievalFeedbackVerdict }
  | { kind: "delete"; id: string }
  /**
   * Put an earlier text of `id` back (`revisionId` is one of its revision
   * snapshots). The text being replaced is preserved as a revision too, so a
   * restore is undoable the same way.
   */
  | { kind: "restore-revision"; id: string; revisionId: string }
  /**
   * Soft-delete (chat-chip 撤销 and conflict resolution): status →
   * `invalidated`, history preserved; mirrors `forgetExternalMemory`.
   */
  | { kind: "invalidate"; id: string; supersededById?: string }
  /**
   * Undo an archive: the row is recallable again. The inverse of `invalidate`,
   * which the bulk archive confirmation has always promised ("can be
   * restored") without anything implementing it.
   */
  | { kind: "restore"; id: string }
  /**
   * Move a memory into another namespace — who can recall it changes, so this
   * is its own command rather than a field on `update`.
   */
  | { kind: "relocate"; id: string; target: MemoryNamespaceTarget }
  /**
   * One-shot conflict disposition from the comparison card. `keep` verifies
   * `keepId` and soft-invalidates `dropId` (superseded link); `keep-both`
   * verifies both and clears the conflict edges; `merge` writes `mergedText`
   * onto `keepId` (PII-gated) and soft-invalidates `dropId`.
   */
  | {
      kind: "resolve-conflict"
      keepId: string
      dropId: string
      mode: "keep" | "keep-both" | "merge"
      mergedText?: string
      /** Stable producer identity for replay-safe governance projection. */
      commandId?: string
      actorId?: string
      rationale?: string
    }
  /**
   * Hard-delete every memory matching `query` (each row still goes through the
   * `delete` path, so vectors/evidence/audit are cleaned per row). Omitting
   * `query` clears everything — active *and* invalidated, since `listMemories`
   * returns both when `status` is unset.
   */
  | { kind: "clear"; query?: ListMemoriesQuery }

export type ManageMemoryResult =
  /** `clearedCount` is only set by `clear` — how many rows the query matched. */
  | { ok: true; memoryId?: string; piiRedacted?: boolean; clearedCount?: number }
  | {
      ok: false
      clearedCount?: number
      failedIds?: string[]
      reason:
        | "partial_failure"
        | "not_found"
        | "disabled"
        | "temporary"
        | "pii_blocked"
        | "policy_denied"
        | "scope_denied"
        // The store path's wider failure surface passes through unchanged —
        // `manage` never produces these, but a type-level remap would lie.
        | "idempotency_key_reused"
        | "unauthorized_namespace"
    }

export interface ManageMemoryCommitContext {
  /** Host receipt envelope: Dexie-only work, canonical write + receipt commit together. */
  commit?: (apply: () => Promise<ManageMemoryResult>) => Promise<ManageMemoryResult>
}

/**
 * Receipt paths by command kind:
 * - update, pin, review, retrieval-feedback, delete, restore-revision, invalidate,
 *   restore, relocate: `commit` encloses canonical Dexie work and the receipt.
 *   Vector I/O remains outside; its failure cannot undo an applied command.
 * - create: consolidation spans judge/vector calls and multiple writes.
 * - clear: multiple per-row deletes with partial-failure reporting.
 * - resolve-conflict: multiple canonical writes interleaved with vector and
 *   governance projection I/O. These three use bounded receipt retries in
 *   manageMemoryForCaller and retain pending keys on uncertain completion.
 */
export async function manageMemory(
  command: ManageMemoryCommand,
  context: ManageMemoryCommitContext = {}
): Promise<ManageMemoryResult> {
  const commit = context.commit ?? ((apply: () => Promise<ManageMemoryResult>) => apply())
  if (command.kind === "create") {
    const result = await storeMemoryCore({
      text: command.text,
      type: command.type,
      importance: command.importance,
      tags: command.tags,
      scope: command.scope,
      characterId: command.characterId,
      projectId: command.projectId,
      agentId: command.agentId,
      branch: command.branch,
      pathPattern: command.pathPattern,
      provenance: "explicit",
      piiGate: "redact",
    })
    return result.ok
      ? { ok: true, memoryId: result.memoryId, piiRedacted: result.piiRedacted }
      : result
  }

  if (command.kind === "clear") {
    // Clearing forgotten memories also drops revision snapshots (earlier
    // wordings kept for undo) — the same rule as `clearMemories`. Any other
    // clear reaches snapshots through their owner's delete.
    const rows = await listMemories(
      command.query?.status === "invalidated"
        ? { ...command.query, includeRevisions: true }
        : command.query
    )
    const selectedIds = new Set(rows.map((row) => row.id))
    let clearedCount = 0
    const failedIds: string[] = []
    for (const row of rows) {
      // The owner's delete also deletes its revision snapshots.
      if (row.revisionOf && selectedIds.has(row.revisionOf)) continue
      try {
        const result = await manageMemory({ kind: "delete", id: row.id })
        if (result.ok) clearedCount += 1
        else if (result.reason !== "not_found") failedIds.push(row.id)
      } catch {
        failedIds.push(row.id)
      }
    }
    return failedIds.length
      ? { ok: false, reason: "partial_failure", clearedCount, failedIds }
      : { ok: true, clearedCount }
  }

  if (command.kind === "resolve-conflict") {
    const [keep, drop] = await Promise.all([getMemory(command.keepId), getMemory(command.dropId)])
    // Revision snapshots are history and never a side of a live conflict.
    if (!keep || !drop || keep.revisionOf !== undefined || drop.revisionOf !== undefined) {
      return { ok: false, reason: "not_found" }
    }
    const settings = await getSettings().catch(() => undefined)
    const config = resolveMemoryConfig(settings?.memory)

    let piiRedacted = false
    let resolutionEvidence: { id: string; sourceId: string; createdAt: number } | undefined
    let result = keep
    if (command.mode === "merge") {
      const raw = command.mergedText?.trim()
      if (!raw) throw new Error("resolve-conflict merge requires non-empty mergedText")
      const redacted = redactText(raw).redacted
      if (!hasNoLeakingPii(redacted)) return { ok: false, reason: "pii_blocked" }
      piiRedacted = redacted !== raw
      await updateMemory(command.keepId, {
        text: redacted,
        bumpVersion: true,
        revisionReason: "conflict-merge",
        reviewStatus: "verified",
        conflictWithIds: (keep.conflictWithIds ?? []).filter((id) => id !== command.dropId),
        evidenceState: "supported",
        contaminationState: "clean",
      })
      try {
        const sink = await tryBuildMemoryVectorSink(config)
        await sink?.upsert(keep.vectorDocId ?? keep.id, redacted)
      } catch {
        // Canonical update remains BM25-searchable.
        noteMemoryVectorFailure()
      }
      resolutionEvidence = await createMemoryEvidence({
        memoryId: command.keepId,
        kind: "manual",
        sourceId: `conflict-merge:${command.keepId}:${command.dropId}`,
        contaminationState: "clean",
        reviewed: true,
      })
      await appendMemoryAuditEvent({
        action: "revised",
        memoryId: command.keepId,
        reason: "conflict_merge",
      })
      const updated = await getMemory(command.keepId)
      if (!updated) throw new Error(`Resolved memory disappeared: ${command.keepId}`)
      result = updated
    } else {
      await updateMemory(command.keepId, {
        reviewStatus: "verified",
        conflictWithIds: (keep.conflictWithIds ?? []).filter((id) => id !== command.dropId),
      })
      await appendMemoryAuditEvent({
        action: "promoted",
        memoryId: command.keepId,
        reason: "conflict_resolved",
      })
    }

    if (command.mode === "keep-both") {
      await updateMemory(command.dropId, {
        reviewStatus: "verified",
        conflictWithIds: (drop.conflictWithIds ?? []).filter((id) => id !== command.keepId),
      })
      await appendMemoryAuditEvent({
        action: "promoted",
        memoryId: command.dropId,
        reason: "conflict_resolved",
      })
    } else {
      await invalidateMemory(command.dropId, command.keepId)
      if (drop.vectorDocId) {
        try {
          const sink = await tryBuildMemoryVectorSink(config)
          await sink?.delete([drop.vectorDocId])
        } catch {
          // Canonical invalidation is authoritative; vector cleanup is best-effort.
          noteMemoryVectorFailure()
        }
      }
      await appendMemoryAuditEvent({
        action: "invalidated",
        memoryId: command.dropId,
        reason: "conflict_resolved",
      })
    }
    const resolvedAt = Date.now()
    const governanceInput = {
      commandId:
        command.commandId ??
        `${command.keepId}:${command.dropId}:v${keep.version}:v${drop.version}:${command.mode}`,
      keep,
      drop,
      result,
      ...(resolutionEvidence ? { resolutionEvidence } : {}),
      mode: command.mode,
      actorId: command.actorId ?? "local-user",
      rationale: command.rationale,
      resolvedAt,
    }
    try {
      await recordMemoryConflictGovernance(governanceInput)
    } catch (error) {
      await reportGovernanceProjectionFailure(
        {
          producer: "memory-conflict",
          operation: "resolve",
          subjectRef: {
            namespace: "cognia",
            type: "memory-conflict",
            id: [command.keepId, command.dropId].sort().join(":"),
          },
          occurredAt: resolvedAt,
          correlation: { requestId: governanceInput.commandId },
        },
        error
      )
    }
    return { ok: true, memoryId: command.keepId, ...(piiRedacted ? { piiRedacted } : {}) }
  }

  const existing = await getMemory(command.id)
  if (!existing) return { ok: false, reason: "not_found" }
  // A revision snapshot is history: it can be deleted, never edited, pinned or
  // reviewed on its own. Restoring goes through its owner's id.
  if (existing.revisionOf !== undefined && command.kind !== "delete") {
    return { ok: false, reason: "not_found" }
  }

  if (command.kind === "pin") {
    return commit(async () => {
      await setMemoryPinned(command.id, command.pinned)
      await appendMemoryAuditEvent({
        action: command.pinned ? "pinned" : "unpinned",
        memoryId: command.id,
        reason: "user",
      })
      return { ok: true, memoryId: command.id }
    })
  }

  if (command.kind === "review") {
    return commit(async () => {
      await updateMemory(command.id, { reviewStatus: command.status })
      await appendMemoryAuditEvent({
        action: command.status === "verified" ? "promoted" : "conflict",
        memoryId: command.id,
        reason: "user_review",
      })
      return { ok: true, memoryId: command.id }
    })
  }

  if (command.kind === "retrieval-feedback") {
    return commit(async () => {
      const written = await recordRetrievalFeedback(command.id, command.verdict)
      if (!written) return { ok: false, reason: "not_found" }
      const audit = () =>
        appendMemoryAuditEvent({
          action: "feedback",
          memoryId: command.id,
          reason: `retrieval_${command.verdict}`,
        })
      if (context.commit) {
        // Audit and receipt failures roll back the feedback in the Host envelope.
        await audit()
      } else {
        // Local callers have already committed feedback. Never present an audit
        // projection failure as permission to increment the counter again.
        try {
          await audit()
        } catch {
          console.warn("Memory feedback audit append failed")
        }
      }
      return { ok: true, memoryId: command.id }
    })
  }

  const settings = await getSettings().catch(() => undefined)
  const config = resolveMemoryConfig(settings?.memory)
  // Removing a row from recall and moving it between namespaces embed nothing,
  // so the learning switch must not strand the user's cleanup.
  if (
    !config.enabled &&
    command.kind !== "delete" &&
    command.kind !== "invalidate" &&
    command.kind !== "relocate"
  ) {
    return { ok: false, reason: "disabled" }
  }

  if (command.kind === "delete") {
    try {
      // Deletion never embeds text; the learning switch must not disable cleanup.
      const sink = await tryBuildMemoryVectorSink({ ...config, enabled: true, temporary: false })
      await sink?.delete([existing.vectorDocId ?? existing.id])
      if (!sink && existing.vectorDocId) noteMemoryVectorFailure()
    } catch {
      // Canonical deletion still proceeds; reconciliation removes stale vectors later.
      noteMemoryVectorFailure()
    }
    return commit(async () => {
      await hardDeleteMemory(command.id)
      // The canonical transaction owns evidence/history/tombstones and audit.
      return { ok: true, memoryId: command.id }
    })
  }

  if (command.kind === "restore-revision") {
    if (config.temporary) return { ok: false, reason: "temporary" }
    let restored: Awaited<ReturnType<typeof restoreMemoryRevision>> | undefined
    const outcome = await commit(async () => {
      restored = await restoreMemoryRevision(command.id, command.revisionId)
      if (!restored.ok && restored.reason !== "unchanged") return { ok: false, reason: "not_found" }
      if (restored.ok) {
        await createMemoryEvidence({
          memoryId: command.id,
          kind: "manual",
          sourceId: `restore:${command.id}:${command.revisionId}`,
          contaminationState: "clean",
          reviewed: true,
        })
        await appendMemoryAuditEvent({
          action: "revised",
          memoryId: command.id,
          reason: "restored",
          metadata: { revisionId: command.revisionId, version: restored.memory.version },
        })
      }
      return { ok: true, memoryId: command.id }
    })
    if (!outcome.ok || !restored?.ok) return outcome
    // Restored text was PII-gated when it was first written; re-check anyway,
    // because the vector sink sends it to the embedder.
    try {
      const sink = await tryBuildMemoryVectorSink(config)
      if (hasNoLeakingPii(restored.memory.text)) {
        await sink?.upsert(existing.vectorDocId ?? existing.id, restored.memory.text)
      } else if (existing.vectorDocId) {
        // Never embed it — and drop the vector of the text it replaced, which
        // would otherwise keep matching.
        await sink?.delete([existing.vectorDocId])
      }
    } catch {
      // Canonical restore remains BM25-searchable.
      noteMemoryVectorFailure()
    }
    return outcome
  }

  if (command.kind === "restore") {
    if (config.temporary) return { ok: false, reason: "temporary" }
    let restored: Awaited<ReturnType<typeof restoreArchivedMemory>> | undefined
    const outcome = await commit(async () => {
      restored = await restoreArchivedMemory(command.id)
      if (!restored.ok && restored.reason !== "already_active")
        return { ok: false, reason: "not_found" }
      if (restored.ok)
        await appendMemoryAuditEvent({ action: "restored", memoryId: command.id, reason: "user" })
      return { ok: true, memoryId: command.id }
    })
    if (!outcome.ok || !restored?.ok) return outcome
    // `invalidate` dropped the vector doc; put it back so semantic recall finds
    // the row again. Its text was gated when written, but the embedder is an
    // outbound call, so it is checked again rather than trusted.
    if (hasNoLeakingPii(restored.memory.text)) {
      try {
        const sink = await tryBuildMemoryVectorSink(config)
        await sink?.upsert(existing.vectorDocId ?? existing.id, restored.memory.text)
      } catch {
        // Canonical restore remains BM25-searchable.
        noteMemoryVectorFailure()
      }
    }
    return outcome
  }

  if (command.kind === "relocate") {
    const target = command.target
    const namespaceId =
      target.scope === "workspace"
        ? target.projectId
        : target.scope === "character"
          ? target.characterId
          : target.scope === "agent"
            ? target.agentId
            : "global"
    if (!namespaceId?.trim()) return { ok: false, reason: "scope_denied" }
    return commit(async () => {
      const moved = await moveMemoryToNamespace(command.id, target)
      if (!moved) return { ok: false, reason: "not_found" }
      await appendMemoryAuditEvent({
        action: "relocated",
        memoryId: command.id,
        reason: "user",
        metadata: { from: existing.scope, to: target.scope },
      })
      return { ok: true, memoryId: command.id }
    })
  }

  if (command.kind === "invalidate") {
    const outcome = await commit(async () => {
      await invalidateMemory(command.id, command.supersededById)
      await appendMemoryAuditEvent({
        action: "invalidated",
        memoryId: command.id,
        reason: "user_undo",
      })
      return { ok: true, memoryId: command.id }
    })
    if (existing.vectorDocId) {
      try {
        const sink = await tryBuildMemoryVectorSink({ ...config, enabled: true, temporary: false })
        await sink?.delete([existing.vectorDocId])
        if (!sink) noteMemoryVectorFailure()
      } catch {
        // Canonical invalidation is authoritative; vector cleanup is best-effort.
        noteMemoryVectorFailure()
      }
    }
    return outcome
  }

  if (config.temporary) return { ok: false, reason: "temporary" }
  const rawText = command.patch.text?.trim()
  if (rawText === "") throw new Error("memory update requires non-empty text")
  const redactedText = rawText ? redactText(rawText).redacted : undefined
  if (redactedText && !hasNoLeakingPii(redactedText)) return { ok: false, reason: "pii_blocked" }

  const outcome = await commit(async () => {
    await updateMemory(command.id, {
      ...command.patch,
      ...(redactedText !== undefined ? { text: redactedText, bumpVersion: true } : {}),
      evidenceState: "supported",
      reviewStatus: "verified",
      contaminationState: "clean",
    })
    await createMemoryEvidence({
      memoryId: command.id,
      kind: "manual",
      sourceId: `manual:${command.id}:v${existing.version + 1}`,
      contaminationState: "clean",
      reviewed: true,
    })
    await appendMemoryAuditEvent({ action: "revised", memoryId: command.id, reason: "user" })
    return {
      ok: true,
      memoryId: command.id,
      piiRedacted: rawText !== undefined && rawText !== redactedText,
    }
  })
  if (redactedText !== undefined) {
    try {
      const sink = await tryBuildMemoryVectorSink(config)
      await sink?.upsert(existing.vectorDocId ?? existing.id, redactedText)
    } catch {
      // Canonical update remains BM25-searchable.
      noteMemoryVectorFailure()
    }
  }
  return outcome
}
