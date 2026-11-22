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

/** Every command supports the atomic canonical+receipt Dexie envelope. */
function hasAtomicReceipt(_command: ManageMemoryCommand): boolean {
  return true
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
    if (row && caller.pairedReader !== undefined) {
      const { filterPairedMemories } = await import("@/lib/memory/runtime/build-deps")
      scope.assertActive()
      if ((await filterPairedMemories([row], caller.pairedReader)).length === 0) {
        return { ok: false, reason: "policy_denied" }
      }
    }
  }
  if (caller.pairedReader === "member") {
    if (
      (command.kind === "create" && command.type === "procedural") ||
      (command.kind === "review" &&
        command.status === "verified" &&
        touched.get(command.id)?.type === "procedural") ||
      (command.kind === "resolve-conflict" &&
        (touched.get(command.keepId)?.type === "procedural" ||
          touched.get(command.dropId)?.type === "procedural"))
    ) {
      return { ok: false, reason: "policy_denied" }
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
  const operationKey = `${caller.principalId}:${context.operationId}`
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
    if (settled) {
      reservation = { state: "replay", receipt: settled }
    } else {
      const reconciled = await ledger.reconcilePendingMemoryOperation(binding)
      scope.assertActive()
      if (reconciled.state === "conflict") return { ok: false, reason: "idempotency_key_reused" }
      if (reconciled.state === "recovered") {
        reservation = { state: "replay", receipt: reconciled.receipt }
      } else {
        reservation = await ledger.reserveMemoryOperation(binding, {
          allowReclaim: reconciled.state === "unapplied",
        })
        scope.assertActive()
      }
    }
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
    // The first attempt is still applying (or its receipt storage is still down).
    // Answering with a retryable failure lets the queue try again cleanly.
    throw new Error("memory_mutate: operation still in flight")
  }

  const releaseInFlight = ledger.markMemoryOperationInFlight(operationKey)
  let receiptCommitted = false
  let commitEntered = false
  const buildReceipt = (result: Extract<ManageMemoryResult, { ok: true }>) => ({
    id: operationKey,
    ...binding,
    memoryId: result.memoryId ?? "",
    resultCode: "ok" as const,
    resultPayload: ledger.memoryOperationResultPayload(result),
    createdAt: Date.now(),
  })
  const writeReceipt = async (result: Extract<ManageMemoryResult, { ok: true }>) => {
    scope.assertActive()
    await ledger.recordMemoryOperation(buildReceipt(result))
  }
  const commit: ManageMemoryCommitContext["commit"] = async (apply) => {
    commitEntered = true
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
    result = await runCommand(effective, atomic ? commit : undefined, operationKey)
  } catch (error) {
    releaseInFlight()
    // An atomic envelope that actually ran rolled back its Dexie transaction,
    // and the store core explicitly identifies pre-write failures. Other throws
    // (such as an injected/mocked command that never entered `commit`) keep
    // their pending lease until expiry + reconciliation.
    if (scope.isActive() && ((atomic && commitEntered) || error instanceof MemoryPreWriteError))
      await ledger.releaseMemoryOperation(
        binding.principalId,
        binding.operationId,
        binding.requestHash
      )
    throw error
  } finally {
    releaseInFlight()
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
    // Fallback for mocked or non-transactional callers: retry only the receipt,
    // stage the applied result in memory on exhaustion so a later retry after
    // storage recovers reconciles deterministically without re-executing.
    let receiptError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writeReceipt(result)
        ledger.clearStagedMemoryOperation(operationKey)
        return result
      } catch (error) {
        receiptError = error
        if (!scope.isActive()) break
      }
    }
    ledger.stageAppliedMemoryOperation(buildReceipt(result))
    throw new MemoryReceiptCommitError(receiptError)
  }
  ledger.clearStagedMemoryOperation(operationKey)
  return result

  async function runCommand(
    next: ManageMemoryCommand,
    commitEnvelope?: ManageMemoryCommitContext["commit"],
    opKey?: string
  ): Promise<ManageMemoryForCallerResult> {
    if (next.kind !== "clear" || (!namespaces && caller.pairedReader === undefined)) {
      try {
        scope.assertActive()
        const needsContext =
          Boolean(commitEnvelope) ||
          Boolean(opKey) ||
          caller.pairedReader !== undefined ||
          next.kind === "create"
        return await (needsContext
          ? manageMemory(next, {
              ...(commitEnvelope ? { commit: commitEnvelope } : {}),
              ...(opKey ? { operationKey: opKey } : {}),
              scope,
              caller,
            })
          : manageMemory(next))
      } catch (error) {
        // clear catches every per-row write failure as partial_failure. Its
        // only escaping failure is the initial list, before any delete.
        if (next.kind === "clear" && !commitEntered) throw new MemoryPreWriteError(error)
        throw error
      }
    }
    // A restricted or member device clears only what it may see.
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
    let allowed = rows.filter((row) => memoryRowWithinNamespaces(row, namespaces))
    if (caller.pairedReader !== undefined && allowed.length > 0) {
      const { filterPairedMemories } = await import("@/lib/memory/runtime/build-deps")
      scope.assertActive()
      allowed = await filterPairedMemories(allowed, caller.pairedReader)
    }
    const allowedIds = new Set(allowed.map((row) => row.id))
    const targetRows = allowed.filter((row) => !(row.revisionOf && allowedIds.has(row.revisionOf)))
    if (commitEnvelope) {
      const targetIds = targetRows.map((row) => row.id)
      const ownerIds = targetRows.filter((row) => row.revisionOf === undefined).map((row) => row.id)
      const vectorDocIds = [
        ...new Set(
          targetRows
            .filter((row) => row.revisionOf === undefined)
            .map((row) => row.vectorDocId ?? row.id)
        ),
      ]
      let clearedCount = 0
      const outcome = await commitEnvelope(async () => {
        scope.assertActive()
        clearedCount = targetIds.length > 0 ? await memDb.hardDeleteMemories(targetIds) : 0
        if (opKey) {
          const { appendMemoryAuditEvent } = await import("@/lib/db/memory-governance")
          await appendMemoryAuditEvent({
            action: "deleted",
            reason: "user_clear",
            metadata: { operationKey: opKey, cleared: true, clearedCount },
          })
        }
        return { ok: true, clearedCount }
      })
      if (!outcome.ok) return outcome
      if (vectorDocIds.length > 0 && scope.isActive()) {
        try {
          const { tryBuildMemoryVectorSink } = await import("@/lib/memory/runtime/build-deps")
          const sink = await tryBuildMemoryVectorSink({
            ...config,
            enabled: true,
            temporary: false,
          })
          await sink?.delete(vectorDocIds)
          if (!sink && targetRows.some((row) => Boolean(row.vectorDocId))) {
            const { noteMemoryVectorFailure } =
              await import("@/lib/memory/lifecycle/enqueue-reconcile")
            noteMemoryVectorFailure()
          }
        } catch {
          if (scope.isActive()) {
            const { noteMemoryVectorFailure } =
              await import("@/lib/memory/lifecycle/enqueue-reconcile")
            noteMemoryVectorFailure()
          }
        }
      }
      if (ownerIds.length > 0 && scope.isActive()) {
        const { scrubDeletedMemorySourcesFromMessages } = await import("@/lib/db/messages")
        await scrubDeletedMemorySourcesFromMessages(ownerIds).catch(() => undefined)
      }
      return outcome
    }
    let clearedCount = 0
    const failedIds: string[] = []
    for (const row of targetRows) {
      scope.assertActive()
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
