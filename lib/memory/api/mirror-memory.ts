/**
 * The local half of a memory command a paired client sends to its host.
 *
 * A paired client (phone, a browser on a headless host, a desktop driving a
 * remote host) is queue-first: the `/memory` console command enters the
 * durable outbound queue as `memory_mutate`, the host applies the
 * authoritative write through `manageMemory` (policy, PII, evidence, vectors,
 * tombstones), and this module moves the local mirror the same way so the
 * console does not sit on stale rows until the next sync pull.
 *
 * What it deliberately does NOT do is repeat the host's work. A mirror has no
 * vector sink and writes no tombstone — a deletion is the host's claim to make,
 * and a local tombstone would be a second, competing one. Commands whose
 * outcome only the host can compute (a new row's id, a revision restore, a
 * table-wide clear's tombstones, retrieval counters) are left to the pull that
 * follows the host's answer. What it DOES own is the part a mirror may: field
 * validation, the version bump, and one audit row saying the mirror moved.
 *
 * If the host refuses the command, the caller rewinds the `memories` cursor and
 * re-pulls, which overwrites whatever this module did.
 */

import {
  invalidateMemory,
  listMemories,
  moveMemoryToNamespace,
  restoreArchivedMemory,
  setMemoryPinned,
  updateMemory,
  getMemory,
} from "@/lib/db/memories"
import { appendMemoryAuditEvent } from "@/lib/db/memory-governance"
import { captureDatabaseScope, getDb, type DatabaseScopeSnapshot } from "@/lib/db/schema"
import type { MemoryAuditAction } from "@/types/memory/governance"
import type { ManageMemoryCommand } from "@/lib/memory/control-plane/manage"

export interface MirroredMemoryResult {
  ok: boolean
  /** `deferred` = nothing to mirror; the host's answer arrives with the next pull. */
  reason?: "deferred" | "failed"
}

/**
 * Apply one queued console command to the local mirror.
 *
 * Never throws: the authoritative write is already queued, so a mirror failure
 * must not surface as a failed user action. The next `syncMemories` pull
 * reconciles whatever the mirror got wrong.
 */
export async function applyMirroredMemoryCommand(
  command: ManageMemoryCommand,
  scope: DatabaseScopeSnapshot = captureDatabaseScope()
): Promise<MirroredMemoryResult> {
  try {
    scope.assertActive()
    switch (command.kind) {
      case "pin":
        await setMemoryPinned(command.id, command.pinned)
        if (scope.isActive()) await auditMirror(command.id, command.pinned ? "pinned" : "unpinned")
        return { ok: true }
      case "update": {
        const text = command.patch.text?.trim()
        await updateMemory(command.id, {
          ...command.patch,
          ...(text ? { text, bumpVersion: true } : {}),
          // No local revision: the host keeps it and syncs it down.
          skipRevision: true,
          evidenceState: "supported",
          reviewStatus: "verified",
          contaminationState: "clean",
        })
        if (scope.isActive()) await auditMirror(command.id, "revised")
        return { ok: true }
      }
      case "review":
        await updateMemory(command.id, { reviewStatus: command.status })
        if (scope.isActive())
          await auditMirror(command.id, command.status === "verified" ? "promoted" : "conflict")
        return { ok: true }
      case "invalidate":
        await invalidateMemory(command.id, command.supersededById)
        if (scope.isActive()) await auditMirror(command.id, "invalidated")
        return { ok: true }
      case "restore": {
        // No local revision: the host keeps the archive-interval snapshot.
        const restored = await restoreArchivedMemory(command.id, { skipRevision: true })
        if (restored.ok && scope.isActive()) await auditMirror(command.id, "restored")
        return { ok: true }
      }
      case "relocate": {
        const moved = await moveMemoryToNamespace(command.id, command.target)
        if (moved && scope.isActive()) await auditMirror(command.id, "relocated")
        return { ok: true }
      }
      case "delete":
        await dropFromMirror([command.id], scope)
        return { ok: true }
      case "resolve-conflict":
        await mirrorConflictResolution(command, scope)
        return { ok: true }
      case "clear": {
        const rows = await listMemories(
          command.query?.status === "invalidated"
            ? { ...command.query, includeRevisions: true }
            : command.query
        )
        scope.assertActive()
        await dropFromMirror(
          rows.map((row) => row.id),
          scope
        )
        return { ok: true }
      }
      case "create":
      case "restore-revision":
      case "retrieval-feedback":
        return { ok: true, reason: "deferred" }
    }
  } catch {
    return { ok: false, reason: "failed" }
  }
}

async function mirrorConflictResolution(
  command: Extract<ManageMemoryCommand, { kind: "resolve-conflict" }>,
  scope: DatabaseScopeSnapshot
): Promise<void> {
  const [keep, drop] = await Promise.all([getMemory(command.keepId), getMemory(command.dropId)])
  scope.assertActive()
  if (!keep || !drop) return
  await updateMemory(command.keepId, {
    reviewStatus: "verified",
    conflictWithIds: (keep.conflictWithIds ?? []).filter((id) => id !== command.dropId),
    ...(command.mode === "merge" && command.mergedText
      ? { text: command.mergedText.trim(), bumpVersion: true, skipRevision: true }
      : {}),
  })
  if (scope.isActive())
    await auditMirror(command.keepId, command.mode === "merge" ? "revised" : "promoted")
  scope.assertActive()
  if (command.mode === "keep-both") {
    await updateMemory(command.dropId, {
      reviewStatus: "verified",
      conflictWithIds: (drop.conflictWithIds ?? []).filter((id) => id !== command.keepId),
    })
    if (scope.isActive()) await auditMirror(command.dropId, "promoted")
  } else {
    await invalidateMemory(command.dropId, command.keepId)
    if (scope.isActive()) await auditMirror(command.dropId, "invalidated")
  }
}

/**
 * Remove rows (and their revision snapshots) from the mirror only. No
 * tombstone and no `deleted` audit: the host's delete produces both, and they
 * reach this device through the next pull.
 */
async function dropFromMirror(ids: readonly string[], scope: DatabaseScopeSnapshot): Promise<void> {
  if (ids.length === 0) return
  scope.assertActive()
  const db = getDb()
  scope.assertActive()
  await db.transaction("rw", db.memories, async () => {
    scope.assertActive()
    const owners = new Set(ids)
    const snapshots = await db.memories
      .filter((row) => row.revisionOf !== undefined && owners.has(row.revisionOf))
      .primaryKeys()
    await db.memories.bulkDelete([...ids, ...snapshots])
  })
}

async function auditMirror(memoryId: string, action: MemoryAuditAction): Promise<void> {
  await appendMemoryAuditEvent({ action, memoryId, reason: "mirror" }).catch(() => undefined)
}
