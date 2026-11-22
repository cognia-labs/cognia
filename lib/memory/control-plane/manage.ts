import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { registerPendingAccountWriteFlusher } from "@/lib/accounts/pending-write-flush"
import { captureDatabaseScope, type DatabaseScopeSnapshot } from "@/lib/db/schema"
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
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"

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
  /** Originating database partition/epoch scope, captured at command entry. */
  scope?: DatabaseScopeSnapshot
  /** Host-bound caller identity, when invoked from `manageMemoryForCaller`. */
  caller?: import("@cognia/memory/types/caller").TrustedMemoryCaller
  /** Composite `${principalId}:${operationId}` stamped on audit rows for crash recovery. */
  operationKey?: string
}

/**
 * Every command commits its canonical Dexie mutations inside `commit` when
 * supplied by `manageMemoryForCaller`, while vector sync, reply-citation
 * scrubbing, and conflict governance projection run post-commit.
 */
export async function manageMemory(
  command: ManageMemoryCommand,
  context: ManageMemoryCommitContext = {}
): Promise<ManageMemoryResult> {
  const scope = context.scope ?? captureDatabaseScope()
  scope.assertActive()
  const noteVectorDrift = () => {
    if (scope.isActive()) noteMemoryVectorFailure()
  }
  const opMeta = (extra?: Record<string, string | number | boolean>) =>
    context.operationKey
      ? { metadata: { ...extra, operationKey: context.operationKey } }
      : extra
        ? { metadata: extra }
        : {}
  const baseCommit = context.commit ?? ((apply: () => Promise<ManageMemoryResult>) => apply())
  const commit = async (apply: () => Promise<ManageMemoryResult>): Promise<ManageMemoryResult> => {
    scope.assertActive()
    let inFlight: Promise<ManageMemoryResult> | undefined
    const unregister = registerPendingAccountWriteFlusher(async () => {
      await inFlight
    })
    try {
      inFlight = baseCommit(async () => {
        scope.assertActive()
        return apply()
      })
      return await inFlight
    } finally {
      unregister()
    }
  }
  if (command.kind === "create") {
    let committedOutcome: ManageMemoryResult | undefined
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
      databaseScope: scope,
      ...(context.caller ? { caller: context.caller } : {}),
      ...(context.operationKey ? { operationKey: context.operationKey } : {}),
      ...(context.commit
        ? {
            withCanonicalCommit: async <T>(apply: () => Promise<T>) => {
              let innerValue!: T
              await commit(async () => {
                innerValue = await apply()
                return committedOutcome ?? { ok: true }
              })
              return innerValue
            },
            onCanonicalApplied: async (applied) => {
              committedOutcome = {
                ok: true,
                ...(applied.memoryId ? { memoryId: applied.memoryId } : {}),
                ...(applied.piiRedacted ? { piiRedacted: true } : {}),
              }
            },
          }
        : {}),
    })
    return result.ok
      ? (committedOutcome ?? {
          ok: true,
          memoryId: result.memoryId,
          piiRedacted: result.piiRedacted,
        })
      : result
  }

  if (command.kind === "clear") {
    // Clearing forgotten memories also drops revision snapshots (earlier
    // wordings kept for undo). Any other clear reaches snapshots through
    // their owner's delete.
    const rows = await listMemories(
      command.query?.status === "invalidated"
        ? { ...command.query, includeRevisions: true }
        : command.query
    )
    scope.assertActive()
    const selectedIds = new Set(rows.map((row) => row.id))
    const targetRows = rows.filter((row) => !(row.revisionOf && selectedIds.has(row.revisionOf)))
    const targetIds = targetRows.map((row) => row.id)
    const ownerIds = targetRows.filter((row) => row.revisionOf === undefined).map((row) => row.id)
    const vectorDocIds = [
      ...new Set(
        targetRows
          .filter((row) => row.revisionOf === undefined)
          .map((row) => row.vectorDocId ?? row.id)
      ),
    ]
    const settings = await getSettings().catch(() => undefined)
    scope.assertActive()
    const config = resolveMemoryConfig(settings?.memory)

    if (targetIds.length === 0) {
      return commit(async () => ({ ok: true, clearedCount: 0 }))
    }

    if (context.commit) {
      let clearedCount = 0
      const outcome = await commit(async () => {
        scope.assertActive()
        for (const row of targetRows) {
          await hardDeleteMemory(row.id)
          if (row.revisionOf === undefined) clearedCount += 1
        }
        if (context.operationKey) {
          await appendMemoryAuditEvent({
            action: "deleted",
            reason: "user_clear",
            metadata: { operationKey: context.operationKey, cleared: true, clearedCount },
          })
        }
        return { ok: true, clearedCount }
      })
      if (!outcome.ok) return outcome
      if (vectorDocIds.length > 0) {
        try {
          const sink = await tryBuildMemoryVectorSink({
            ...config,
            enabled: true,
            temporary: false,
          })
          await sink?.delete(vectorDocIds)
          if (!sink && targetRows.some((row) => Boolean(row.vectorDocId))) noteVectorDrift()
        } catch {
          noteVectorDrift()
        }
      }
      if (ownerIds.length > 0 && scope.isActive()) {
        const { scrubDeletedMemorySourcesFromMessages } = await import("@/lib/db/messages")
        await scrubDeletedMemorySourcesFromMessages(ownerIds).catch(() => undefined)
      }
      return outcome
    }

    let sink: Awaited<ReturnType<typeof tryBuildMemoryVectorSink>>
    try {
      sink = await tryBuildMemoryVectorSink({ ...config, enabled: true, temporary: false })
    } catch {
      noteVectorDrift()
    }
    let clearedCount = 0
    const failedIds: string[] = []
    const deletedOwnerIds: string[] = []
    for (const row of targetRows) {
      try {
        scope.assertActive()
        await hardDeleteMemory(row.id)
        if (row.revisionOf === undefined) {
          clearedCount += 1
          deletedOwnerIds.push(row.id)
        }
      } catch {
        failedIds.push(row.id)
        continue
      }
      if (row.revisionOf === undefined) {
        const docId = row.vectorDocId ?? row.id
        if (sink) {
          await sink.delete([docId]).catch(() => {
            noteVectorDrift()
          })
        } else if (row.vectorDocId) {
          noteVectorDrift()
        }
      }
    }
    if (deletedOwnerIds.length > 0 && scope.isActive()) {
      const { scrubDeletedMemorySourcesFromMessages } = await import("@/lib/db/messages")
      await scrubDeletedMemorySourcesFromMessages(deletedOwnerIds).catch(() => undefined)
    }
    if (failedIds.length > 0) {
      return { ok: false, reason: "partial_failure", clearedCount, failedIds }
    }
    return { ok: true, clearedCount }
  }

  if (command.kind === "resolve-conflict") {
    const [keep, drop] = await Promise.all([getMemory(command.keepId), getMemory(command.dropId)])
    scope.assertActive()
    // Revision snapshots are history and never a side of a live conflict.
    if (!keep || !drop || keep.revisionOf !== undefined || drop.revisionOf !== undefined) {
      return { ok: false, reason: "not_found" }
    }
    if (
      context.caller?.pairedReader === "member" &&
      (keep.type === "procedural" || drop.type === "procedural")
    ) {
      return { ok: false, reason: "policy_denied" }
    }
    const settings = await getSettings().catch(() => undefined)
    scope.assertActive()
    const config = resolveMemoryConfig(settings?.memory)

    let piiRedacted = false
    let redactedMergeText: string | undefined
    if (command.mode === "merge") {
      const raw = command.mergedText?.trim()
      if (!raw) throw new Error("resolve-conflict merge requires non-empty mergedText")
      redactedMergeText = redactText(raw).redacted
      if (!hasNoLeakingPii(redactedMergeText)) return { ok: false, reason: "pii_blocked" }
      piiRedacted = redactedMergeText !== raw
    }

    let resolutionEvidence: { id: string; sourceId: string; createdAt: number } | undefined
    let result = keep
    const outcome = await commit(async () => {
      const [liveKeep, liveDrop] = await Promise.all([
        getMemory(command.keepId),
        getMemory(command.dropId),
      ])
      if (
        !liveKeep ||
        !liveDrop ||
        liveKeep.revisionOf !== undefined ||
        liveDrop.revisionOf !== undefined
      ) {
        return { ok: false, reason: "not_found" }
      }
      if (command.mode === "merge" && redactedMergeText !== undefined) {
        await updateMemory(command.keepId, {
          text: redactedMergeText,
          bumpVersion: true,
          revisionReason: "conflict-merge",
          reviewStatus: "verified",
          conflictWithIds: (liveKeep.conflictWithIds ?? []).filter((id) => id !== command.dropId),
          evidenceState: "supported",
          contaminationState: "clean",
        })
        scope.assertActive()
        resolutionEvidence = await createMemoryEvidence({
          memoryId: command.keepId,
          kind: "manual",
          sourceId: `conflict-merge:${command.keepId}:${command.dropId}`,
          contaminationState: "clean",
          reviewed: true,
        })
        scope.assertActive()
        await appendMemoryAuditEvent({
          action: "revised",
          memoryId: command.keepId,
          reason: "conflict_merge",
          ...opMeta(piiRedacted ? { piiRedacted: true } : undefined),
        })
        scope.assertActive()
        const updated = await getMemory(command.keepId)
        if (!updated) throw new Error(`Resolved memory disappeared: ${command.keepId}`)
        result = updated
      } else {
        result = liveKeep
        await updateMemory(command.keepId, {
          reviewStatus: "verified",
          conflictWithIds: (liveKeep.conflictWithIds ?? []).filter((id) => id !== command.dropId),
        })
        scope.assertActive()
        await appendMemoryAuditEvent({
          action: "promoted",
          memoryId: command.keepId,
          reason: "conflict_resolved",
          ...opMeta(),
        })
      }

      scope.assertActive()
      if (command.mode === "keep-both") {
        await updateMemory(command.dropId, {
          reviewStatus: "verified",
          conflictWithIds: (liveDrop.conflictWithIds ?? []).filter((id) => id !== command.keepId),
        })
        scope.assertActive()
        await appendMemoryAuditEvent({
          action: "promoted",
          memoryId: command.dropId,
          reason: "conflict_resolved",
        })
      } else {
        await invalidateMemory(command.dropId, command.keepId)
        scope.assertActive()
        await appendMemoryAuditEvent({
          action: "invalidated",
          memoryId: command.dropId,
          reason: "conflict_resolved",
        })
      }
      return { ok: true, memoryId: command.keepId, ...(piiRedacted ? { piiRedacted } : {}) }
    })
    if (!outcome.ok) return outcome

    if (command.mode === "merge" && redactedMergeText !== undefined) {
      try {
        const sink = await tryBuildMemoryVectorSink(config)
        if (sink) {
          const docId = keep.vectorDocId ?? keep.id
          await sink.upsert(docId, redactedMergeText)
          if (scope.isActive()) {
            await updateMemory(keep.id, {
              vectorDocId: docId,
              vectorTextHash: hashContent(redactedMergeText),
            })
          }
        }
      } catch {
        // Canonical update remains BM25-searchable.
        noteVectorDrift()
      }
    }
    if (command.mode !== "keep-both" && drop.vectorDocId) {
      try {
        const sink = await tryBuildMemoryVectorSink(config)
        await sink?.delete([drop.vectorDocId])
      } catch {
        // Canonical invalidation is authoritative; vector cleanup is best-effort.
        noteVectorDrift()
      }
    }
    if (!scope.isActive()) return outcome
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
      if (scope.isActive()) {
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
    }
    return outcome
  }

  const existing = await getMemory(command.id)
  scope.assertActive()
  if (!existing) return { ok: false, reason: "not_found" }
  // A revision snapshot is history: it can be deleted, never edited, pinned or
  // reviewed on its own. Restoring goes through its owner's id.
  if (existing.revisionOf !== undefined && command.kind !== "delete") {
    return { ok: false, reason: "not_found" }
  }

  if (command.kind === "pin") {
    return commit(async () => {
      await setMemoryPinned(command.id, command.pinned)
      scope.assertActive()
      await appendMemoryAuditEvent({
        action: command.pinned ? "pinned" : "unpinned",
        memoryId: command.id,
        reason: "user",
      })
      return { ok: true, memoryId: command.id }
    })
  }

  if (command.kind === "review") {
    if (
      context.caller?.pairedReader === "member" &&
      existing.type === "procedural" &&
      command.status === "verified"
    ) {
      return { ok: false, reason: "policy_denied" }
    }
    return commit(async () => {
      await updateMemory(command.id, { reviewStatus: command.status })
      scope.assertActive()
      await appendMemoryAuditEvent({
        action: command.status === "verified" ? "promoted" : "conflict",
        memoryId: command.id,
        reason: "user_review",
        ...opMeta(),
      })
      return { ok: true, memoryId: command.id }
    })
  }

  if (command.kind === "retrieval-feedback") {
    return commit(async () => {
      const written = await recordRetrievalFeedback(command.id, command.verdict)
      if (!written) return { ok: false, reason: "not_found" }
      scope.assertActive()
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
  scope.assertActive()
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
      if (!sink && existing.vectorDocId) noteVectorDrift()
    } catch {
      // Canonical deletion still proceeds; reconciliation removes stale vectors later.
      noteVectorDrift()
    }
    scope.assertActive()
    const outcome = await commit(async () => {
      scope.assertActive()
      await hardDeleteMemory(command.id)
      // The canonical transaction owns evidence/history/tombstones and audit.
      return { ok: true, memoryId: command.id }
    })
    if (outcome.ok && scope.isActive()) {
      const { scrubDeletedMemorySourcesFromMessages } = await import("@/lib/db/messages")
      await scrubDeletedMemorySourcesFromMessages([command.id]).catch(() => undefined)
    }
    return outcome
  }

  if (command.kind === "restore-revision") {
    if (config.temporary) return { ok: false, reason: "temporary" }
    let restored: Awaited<ReturnType<typeof restoreMemoryRevision>> | undefined
    const outcome = await commit(async () => {
      restored = await restoreMemoryRevision(command.id, command.revisionId)
      if (!restored.ok && restored.reason !== "unchanged") return { ok: false, reason: "not_found" }
      if (restored.ok) {
        scope.assertActive()
        await createMemoryEvidence({
          memoryId: command.id,
          kind: "manual",
          sourceId: `restore:${command.id}:${command.revisionId}`,
          contaminationState: "clean",
          reviewed: true,
        })
        scope.assertActive()
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
        if (sink) {
          const docId = existing.vectorDocId ?? existing.id
          await sink.upsert(docId, restored.memory.text)
          if (scope.isActive()) {
            await updateMemory(existing.id, {
              vectorDocId: docId,
              vectorTextHash: hashContent(restored.memory.text),
            })
          }
        }
      } else if (existing.vectorDocId) {
        // Never embed it — and drop the vector of the text it replaced, which
        // would otherwise keep matching.
        await sink?.delete([existing.vectorDocId])
      }
    } catch {
      // Canonical restore remains BM25-searchable.
      noteVectorDrift()
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
      if (restored.ok) {
        scope.assertActive()
        await appendMemoryAuditEvent({ action: "restored", memoryId: command.id, reason: "user" })
      }
      return { ok: true, memoryId: command.id }
    })
    if (!outcome.ok || !restored?.ok) return outcome
    // `invalidate` dropped the vector doc; put it back so semantic recall finds
    // the row again. Its text was gated when written, but the embedder is an
    // outbound call, so it is checked again rather than trusted.
    if (hasNoLeakingPii(restored.memory.text)) {
      try {
        const sink = await tryBuildMemoryVectorSink(config)
        if (sink) {
          const docId = existing.vectorDocId ?? existing.id
          await sink.upsert(docId, restored.memory.text)
          if (scope.isActive()) {
            await updateMemory(existing.id, {
              vectorDocId: docId,
              vectorTextHash: hashContent(restored.memory.text),
            })
          }
        }
      } catch {
        // Canonical restore remains BM25-searchable.
        noteVectorDrift()
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
      scope.assertActive()
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
      scope.assertActive()
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
        if (!sink) noteVectorDrift()
      } catch {
        // Canonical invalidation is authoritative; vector cleanup is best-effort.
        noteVectorDrift()
      }
    }
    return outcome
  }

  if (config.temporary) return { ok: false, reason: "temporary" }
  const rawText = command.patch.text?.trim()
  if (rawText === "") throw new Error("memory update requires non-empty text")
  const redactedText = rawText ? redactText(rawText).redacted : undefined
  if (redactedText && !hasNoLeakingPii(redactedText)) return { ok: false, reason: "pii_blocked" }

  const nonOwnerProceduralEdit =
    context.caller?.pairedReader === "member" &&
    existing.type === "procedural" &&
    ((redactedText !== undefined && redactedText !== existing.text) ||
      (command.patch.key !== undefined && command.patch.key !== existing.key))
  const outcome = await commit(async () => {
    await updateMemory(command.id, {
      ...command.patch,
      ...(redactedText !== undefined ? { text: redactedText, bumpVersion: true } : {}),
      evidenceState: "supported",
      reviewStatus: nonOwnerProceduralEdit ? "pending_instruction" : "verified",
      contaminationState: "clean",
    })
    scope.assertActive()
    await createMemoryEvidence({
      memoryId: command.id,
      kind: "manual",
      sourceId: `manual:${command.id}:v${existing.version + 1}`,
      contaminationState: "clean",
      reviewed: !nonOwnerProceduralEdit,
    })
    scope.assertActive()
    await appendMemoryAuditEvent({
      action: "revised",
      memoryId: command.id,
      reason: nonOwnerProceduralEdit ? "external_procedural_edit_requires_review" : "user",
      ...opMeta(
        rawText !== undefined && rawText !== redactedText ? { piiRedacted: true } : undefined
      ),
    })
    return {
      ok: true,
      memoryId: command.id,
      piiRedacted: rawText !== undefined && rawText !== redactedText,
    }
  })
  if (redactedText !== undefined) {
    try {
      const sink = await tryBuildMemoryVectorSink(config)
      if (sink) {
        const docId = existing.vectorDocId ?? existing.id
        await sink.upsert(docId, redactedText)
        if (scope.isActive()) {
          await updateMemory(existing.id, {
            vectorDocId: docId,
            vectorTextHash: hashContent(redactedText),
          })
        }
      }
    } catch {
      // Canonical update remains BM25-searchable.
      noteVectorDrift()
    }
  }
  return outcome
}
