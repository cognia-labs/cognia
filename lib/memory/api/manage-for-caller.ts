/**
 * Host side of `memory_mutate`: a `/memory` console command sent by a paired
 * device, run against this host's store.
 *
 * The local console calls `manageMemory` directly; a paired device used to run
 * the same console against its synced mirror, so a pin, an edit or a delete on
 * a phone or on a browser paired to a headless host never reached the host and
 * was undone by the next pull. Routing the console here instead keeps one
 * implementation of every command (`manageMemory`) and adds only what a remote
 * principal needs on top of it:
 *
 *   - **Namespace authority.** The verified device's `principalGrants` may
 *     narrow which namespaces it can touch. Every row the command reads or
 *     writes — both sides of a conflict, the destination of a move, the
 *     namespace of a new row — must fall inside them. `clear` is narrowed to
 *     the rows the device may see instead of being refused, so "clear what I
 *     am looking at" means the same thing on every device.
 *   - **Idempotency.** The outbound queue retries a row until the host answers,
 *     so a command can arrive twice. An `operationId` reserves the
 *     `(principal, operation)` pair in the memory operation ledger; a replay of
 *     an applied command answers its first result instead of creating a second
 *     memory or deleting twice.
 *   - **Attribution.** A conflict resolution records the device as its actor.
 */

import type { TrustedMemoryCaller } from "@cognia/memory/types/caller"
import { memoryRowWithinNamespaces } from "@cognia/memory/types/caller"
import type { Memory } from "@/types/memory/memory"
import type {
  ManageMemoryCommand,
  ManageMemoryResult,
  ManageMemoryCommitContext,
} from "@/lib/memory/control-plane/manage"
import { captureDatabaseScope } from "@/lib/db/schema"
import { resolveMemoryCaller } from "./caller"
import { MemoryPreWriteError } from "./store-memory"

export interface ManageMemoryForCallerContext {
  /** Host-bound identity — `companionCaller(callerDeviceId)` for RPC. */
  caller: TrustedMemoryCaller
  /** Idempotency key, unique per principal (the queue row's operation id). */
  operationId?: string
}

/** `manageMemory`'s result — its failure set already names both remote refusals. */
export type ManageMemoryForCallerResult = ManageMemoryResult

export class MemoryReceiptCommitError extends Error {
  readonly code = "memory_receipt_commit_failed"
  constructor(cause: unknown, surface = "memory_mutate") {
    super(`${surface}: command applied but receipt commit failed; operation remains pending`, {
      cause,
    })
    this.name = "MemoryReceiptCommitError"
  }
}

/** Commands whose canonical Dexie work accepts the atomic receipt envelope. */
function hasAtomicReceipt(command: ManageMemoryCommand): boolean {
  return (
    command.kind !== "create" && command.kind !== "clear" && command.kind !== "resolve-conflict"
  )
}

type NamespaceRow = Pick<Memory, "scope" | "projectId" | "characterId" | "agentId">

/** The namespace a command would write a NEW row into, if it creates one. */
function createdNamespace(command: ManageMemoryCommand): NamespaceRow | undefined {
  if (command.kind === "create") {
    return {
      scope: command.scope ?? "global",
      projectId: command.projectId,
      characterId: command.characterId,
      agentId: command.agentId,
    }
  }
  if (command.kind === "relocate") {
    const target = command.target
    return {
      scope: target.scope,
      projectId: target.scope === "workspace" ? target.projectId : undefined,
      characterId: target.scope === "character" ? target.characterId : undefined,
      agentId: target.scope === "agent" ? target.agentId : undefined,
    }
  }
  return undefined
}

/** Ids of the existing rows a command reads or writes. */
function touchedIds(command: ManageMemoryCommand): string[] {
  switch (command.kind) {
    case "create":
    case "clear":
      return []
    case "resolve-conflict":
      return [command.keepId, command.dropId]
    case "invalidate":
      return command.supersededById ? [command.id, command.supersededById] : [command.id]
    default:
      return [command.id]
  }
}

export async function manageMemoryForCaller(
  command: ManageMemoryCommand,
  context: ManageMemoryForCallerContext
): Promise<ManageMemoryForCallerResult> {
  const scope = captureDatabaseScope()
  const [{ getSettings }, { resolveMemoryConfig }, memDb, { manageMemory }] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/types/memory/memory"),
    import("@/lib/db/memories"),
    import("@/lib/memory/control-plane/manage"),
  ])
  scope.assertActive()
  const settings = await getSettings().catch(() => undefined)
  scope.assertActive()
  const config = resolveMemoryConfig(settings?.memory)
  const caller = resolveMemoryCaller(context.caller, config)
  const namespaces = caller.namespaces
  const touched = new Map<string, Memory>()

  // An unknown id is `not_found` from `manageMemory`, exactly as it is locally;
  // only rows that exist can be outside the caller's namespaces.
  for (const rowId of touchedIds(command)) {
    const row = await memDb.getMemory(rowId)
    scope.assertActive()
    if (row) touched.set(rowId, row)
    if (row && !memoryRowWithinNamespaces(row, namespaces)) {
      return { ok: false, reason: "unauthorized_namespace" }
    }
  }
  const destination = createdNamespace(command)
  if (destination && !memoryRowWithinNamespaces(destination, namespaces)) {
    return { ok: false, reason: "unauthorized_namespace" }
  }
  // This is the conflict command's only validation throw. Reject it before
  // reserving, preserving the control plane's not-found precedence.
  if (
    command.kind === "resolve-conflict" &&
    command.mode === "merge" &&
    !command.mergedText?.trim() &&
    [command.keepId, command.dropId].every((id) => {
      const row = touched.get(id)
      return row && row.revisionOf === undefined
    })
  )
    throw new MemoryPreWriteError(new Error("resolve-conflict merge requires non-empty mergedText"))

  const effective: ManageMemoryCommand =
    command.kind === "resolve-conflict" ? { ...command, actorId: caller.principalId } : command

  if (!context.operationId) return runCommand(effective)

  const ledger = await import("@/lib/db/memory-operations")
  scope.assertActive()
  const binding = {
    principalId: caller.principalId,
    operationId: context.operationId,
    requestHash: await ledger.memoryOperationRequestHash("manage", command),
    kind: "manage" as const,
  }
  scope.assertActive()
  let reservation = await ledger.reserveMemoryOperation(binding)
  scope.assertActive()
  if (reservation.state === "in_flight") {
    const settled = await ledger.awaitMemoryOperation(binding.principalId, binding.operationId)
    scope.assertActive()
    reservation = settled
      ? { state: "replay", receipt: settled }
      : await ledger.reserveMemoryOperation(binding)
    scope.assertActive()
  }
  if (reservation.state === "conflict") return { ok: false, reason: "idempotency_key_reused" }
  if (reservation.state === "replay") {
    return (
      reservation.receipt.resultPayload ?? {
        ok: true,
        ...(reservation.receipt.memoryId ? { memoryId: reservation.receipt.memoryId } : {}),
      }
    )
  }
  if (reservation.state === "in_flight") {
    // The first attempt is still applying (or died holding the key). Answering
    // with a retryable failure lets the queue try again instead of applying a
    // second copy of the same command.
    throw new Error("memory_mutate: operation still in flight")
  }

  let receiptCommitted = false
  const writeReceipt = async (result: Extract<ManageMemoryResult, { ok: true }>) => {
    scope.assertActive()
    await ledger.recordMemoryOperation({
      id: `${binding.principalId}:${binding.operationId}`,
      ...binding,
      memoryId: result.memoryId ?? "",
      resultCode: "ok",
      resultPayload: ledger.memoryOperationResultPayload(result),
      createdAt: Date.now(),
    })
  }
  const commit: ManageMemoryCommitContext["commit"] = async (apply) => {
    const { getDb } = await import("@/lib/db/schema")
    scope.assertActive()
    const db = getDb()
    scope.assertActive()
    const result = await db.transaction(
      "rw",
      [
        db.memories,
        db.memoryEvidence,
        db.memoryAuditEvents,
        db.memoryOperations,
        db.retrievalEncryptedContent,
        db.retrievalTombstones,
        db.syncTombstones,
      ],
      async () => {
        scope.assertActive()
        const outcome = await apply()
        if (outcome.ok) await writeReceipt(outcome)
        return outcome
      }
    )
    if (result.ok) receiptCommitted = true
    return result
  }
  const atomic = hasAtomicReceipt(effective)
  let result: ManageMemoryForCallerResult
  try {
    result = await runCommand(effective, atomic ? commit : undefined)
  } catch (error) {
    // An atomic envelope rolled back, and the store core explicitly identifies
    // pre-write failures. Other multi-step failures keep their key fenced.
    // Never release into a different database if the active partition moved.
    if (scope.isActive() && (atomic || error instanceof MemoryPreWriteError))
      await ledger.releaseMemoryOperation(
        binding.principalId,
        binding.operationId,
        binding.requestHash
      )
    throw error
  }
  if (!result.ok) {
    // A refused command changed nothing, so its key must free up for a
    // corrected retry (the same rule `runMemoryMutation` applies).
    if (result.reason !== "partial_failure" && scope.isActive())
      await ledger.releaseMemoryOperation(
        binding.principalId,
        binding.operationId,
        binding.requestHash
      )
    return result
  }
  if (!receiptCommitted) {
    // Non-atomic command kinds have already applied. Retry only the receipt,
    // never the command, and never free the key after a successful command.
    let receiptError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writeReceipt(result)
        return result
      } catch (error) {
        receiptError = error
        if (!scope.isActive()) break
      }
    }
    throw new MemoryReceiptCommitError(receiptError)
  }
  return result

  async function runCommand(
    next: ManageMemoryCommand,
    commit?: ManageMemoryCommitContext["commit"]
  ): Promise<ManageMemoryForCallerResult> {
    if (next.kind !== "clear" || !namespaces) {
      try {
        scope.assertActive()
        return await (commit ? manageMemory(next, { commit, scope }) : manageMemory(next))
      } catch (error) {
        // clear catches every per-row write failure as partial_failure. Its
        // only escaping failure is the initial list, before any delete.
        if (next.kind === "clear") throw new MemoryPreWriteError(error)
        throw error
      }
    }
    // A restricted device clears only what it may see: one governed delete per
    // row, never the unscoped table-wide clear.
    const rows = await memDb
      .listMemories(
        next.query?.status === "invalidated"
          ? { ...next.query, includeRevisions: true }
          : next.query
      )
      .catch((error) => {
        throw new MemoryPreWriteError(error)
      })
    scope.assertActive()
    const allowed = rows.filter((row) => memoryRowWithinNamespaces(row, namespaces))
    const allowedIds = new Set(allowed.map((row) => row.id))
    let clearedCount = 0
    const failedIds: string[] = []
    for (const row of allowed) {
      scope.assertActive()
      if (row.revisionOf && allowedIds.has(row.revisionOf)) continue
      try {
        scope.assertActive()
        const deleted = await manageMemory({ kind: "delete", id: row.id })
        if (deleted.ok) clearedCount += 1
        else if (deleted.reason !== "not_found") failedIds.push(row.id)
      } catch (error) {
        if (!scope.isActive()) throw error
        failedIds.push(row.id)
      }
    }
    return failedIds.length
      ? { ok: false, reason: "partial_failure", clearedCount, failedIds }
      : { ok: true, clearedCount }
  }
}
