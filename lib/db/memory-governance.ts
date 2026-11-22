import Dexie from "dexie"
import type { StoredMessage } from "@cognia/agent-config-types"
import type {
  MemoryAuditEvent,
  MemoryEvidence,
  MemoryJob,
  MemoryJobStatus,
} from "@/types/memory/governance"
import { computeBeliefInputs } from "@cognia/memory/lifecycle/belief"
import { assessClaimSupport } from "@cognia/memory/lifecycle/claim-support"
import { getDb } from "./schema"

export interface MemoryPersistenceScope {
  db: ReturnType<typeof getDb>
  assertActive(): void
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * How long a claimed memory job stays owned without a heartbeat.
 *
 * One constant rather than three literals, because the heartbeat period is
 * derived from it: a worker that renews slower than the TTL is a worker whose
 * job gets stolen mid-run.
 */
export const MEMORY_JOB_LEASE_TTL_MS = 10 * 60 * 1000

/** Statuses a job never leaves. Reopening one would undo a user's cancel. */
const TERMINAL_MEMORY_JOB_STATUSES: readonly MemoryJobStatus[] = [
  "succeeded",
  "no_output",
  "skipped",
  "failed",
  "cancelled",
]

export type MemoryEvidenceDraft = Omit<MemoryEvidence, "id" | "createdAt"> &
  Partial<Pick<MemoryEvidence, "id" | "createdAt">>

/**
 * Recompute the corroboration counters (`Memory.beliefInputs`) of each memory
 * from its evidence rows. Derived data: it never stamps `updatedAt` (the
 * content did not change) and a failure is swallowed — the next evidence
 * change recomputes from scratch.
 */
export async function refreshMemoryBeliefInputs(
  memoryIds: readonly string[],
  scope?: MemoryPersistenceScope
): Promise<void> {
  const ids = [...new Set(memoryIds.filter(Boolean))]
  if (ids.length === 0) return
  const db = scope?.db ?? getDb()
  for (const memoryId of ids) {
    try {
      scope?.assertActive()
      const evidence = await db.memoryEvidence.where("memoryId").equals(memoryId).toArray()
      scope?.assertActive()
      await db.memories.update(memoryId, { beliefInputs: computeBeliefInputs(evidence) })
    } catch {
      // Derived counters; recomputed on the next evidence change.
    }
  }
}

/**
 * Refresh belief counters once the evidence write is visible. Evidence is
 * often written inside a caller's transaction that does not include
 * `memories` (or has not committed yet), so the refresh is deferred to that
 * transaction's completion instead of running inside it.
 */
function scheduleBeliefRefresh(
  memoryIds: readonly string[],
  scope?: MemoryPersistenceScope
): Promise<void> | void {
  const ids = memoryIds.filter(Boolean)
  if (ids.length === 0) return
  const transaction = Dexie.currentTransaction
  if (transaction) {
    transaction.on("complete", () => {
      void Dexie.ignoreTransaction(() => refreshMemoryBeliefInputs(ids, scope))
    })
    return
  }
  return refreshMemoryBeliefInputs(ids, scope)
}

export async function createMemoryEvidence(draft: MemoryEvidenceDraft): Promise<MemoryEvidence> {
  const row: MemoryEvidence = {
    ...draft,
    id: draft.id ?? newId("mev"),
    createdAt: draft.createdAt ?? Date.now(),
  }
  await getDb().memoryEvidence.add(row)
  if (row.memoryId) await scheduleBeliefRefresh([row.memoryId])
  return row
}

export async function listMemoryEvidence(memoryId: string): Promise<MemoryEvidence[]> {
  return getDb().memoryEvidence.where("memoryId").equals(memoryId).sortBy("createdAt")
}

/**
 * Record a re-check verdict on one evidence row.
 *
 * Narrow by design: the sweep may write only what it learned. Widening this to
 * a general patch would let a re-check silently rewrite `sourceId`, `messageId`
 * or `excerptHash` — the very fields the NEXT re-check compares against, which
 * would make the check self-confirming.
 */
export async function recordMemoryEvidenceVerdict(
  id: string,
  verdict: {
    validationState: MemoryEvidence["validationState"]
    validatedAt?: number
    validationStrategy?: MemoryEvidence["validationStrategy"]
  }
): Promise<void> {
  const db = getDb()
  await db.memoryEvidence.update(id, {
    validationState: verdict.validationState,
    validatedAt: verdict.validatedAt ?? Date.now(),
    ...(verdict.validationStrategy ? { validationStrategy: verdict.validationStrategy } : {}),
  })
  const row = await db.memoryEvidence.get(id)
  if (row?.memoryId) await scheduleBeliefRefresh([row.memoryId])
}

/**
 * Mark every evidence row that cites one of `messageIds` as `revoked`.
 *
 * The source of truth for "which claims depended on this message" is the
 * `messageId` index — this is what it exists for. Returns the affected memory
 * ids so the caller can queue a re-check for each.
 */
/**
 * Synchronously reconcile active project claims whose evidence was just revoked
 * so the very next prompt cannot inject a claim whose sole support disappeared
 * (`N12`). Personal memories have no citation model and are untouched.
 */
async function syncRevokedProjectClaims(
  memoryIds: readonly string[],
  now: number,
  scope?: MemoryPersistenceScope
): Promise<void> {
  const ids = [...new Set(memoryIds.filter(Boolean))]
  if (ids.length === 0) return
  const db = scope?.db ?? getDb()
  for (const memoryId of ids) {
    scope?.assertActive()
    const memory = await db.memories.get(memoryId)
    scope?.assertActive()
    if (!memory || memory.projectMemoryKind === undefined || memory.status !== "active") continue
    const allEvidence = await db.memoryEvidence.where("memoryId").equals(memoryId).toArray()
    scope?.assertActive()
    const verdict = assessClaimSupport(allEvidence)
    if (verdict.invalidate) {
      await db.memories.update(memoryId, {
        status: "invalidated",
        staleness: "expired",
        invalidatedAt: now,
        validatedAt: now,
        updatedAt: now,
      })
      scope?.assertActive()
      await db.memoryAuditEvents.add({
        id: newId("mau"),
        action: "invalidated",
        memoryId,
        reason: "evidence_revoked",
        metadata: { support: verdict.support },
        createdAt: now,
      })
    } else {
      await db.memories.update(memoryId, {
        staleness: verdict.staleness,
        validatedAt: now,
      })
    }
  }
}

export async function revokeMemoryEvidenceForMessages(
  messageIds: readonly string[],
  now: number = Date.now()
): Promise<string[]> {
  if (messageIds.length === 0) return []
  const db = getDb()
  const rows = await db.memoryEvidence
    .where("messageId")
    .anyOf([...messageIds])
    .toArray()
  if (rows.length === 0) return []
  await db.memoryEvidence.bulkPut(
    rows.map((row) => ({ ...row, validationState: "revoked" as const, validatedAt: now }))
  )
  const memoryIds = [
    ...new Set(rows.map((row) => row.memoryId).filter((id): id is string => Boolean(id))),
  ]
  await scheduleBeliefRefresh(memoryIds)
  await syncRevokedProjectClaims(memoryIds, now)
  return memoryIds
}

/**
 * Mark every evidence row captured in one session as `revoked`.
 *
 * Used when a whole session goes: `sessionId` is indexed, and unlike a
 * message-id sweep this also catches rows that carry no `messageId` at all —
 * the turn-level citations `runTurnMemory` writes. Returns the affected memory
 * ids.
 */
export async function revokeMemoryEvidenceForSession(
  sessionId: string,
  now: number = Date.now(),
  scope?: MemoryPersistenceScope
): Promise<string[]> {
  if (!sessionId) return []
  scope?.assertActive()
  const db = scope?.db ?? getDb()
  const rows = await db.memoryEvidence.where("sessionId").equals(sessionId).toArray()
  scope?.assertActive()
  if (rows.length === 0) return []
  await db.memoryEvidence.bulkPut(
    rows.map((row) => ({ ...row, validationState: "revoked" as const, validatedAt: now }))
  )
  const memoryIds = [
    ...new Set(rows.map((row) => row.memoryId).filter((id): id is string => Boolean(id))),
  ]
  scope?.assertActive()
  await scheduleBeliefRefresh(memoryIds, scope)
  scope?.assertActive()
  await syncRevokedProjectClaims(memoryIds, now, scope)
  scope?.assertActive()
  return memoryIds
}

/**
 * Cancel every still-pending job for a session.
 *
 * A job whose session is gone would fail `loadJobContext` with a terminal
 * `session_unavailable` anyway, so this is about the console rather than
 * correctness: without it, deleting a busy conversation leaves a row of jobs
 * that look like real pending work and then die one by one.
 */
export async function cancelMemoryJobsForSession(
  sessionId: string,
  scope?: MemoryPersistenceScope
): Promise<number> {
  if (!sessionId) return 0
  scope?.assertActive()
  const db = scope?.db ?? getDb()
  const pending = await db.memoryJobs.where("sessionId").equals(sessionId).toArray()
  scope?.assertActive()
  let cancelled = 0
  for (const job of pending) {
    if (job.status !== "queued" && job.status !== "running" && job.status !== "retry_wait") continue
    await cancelMemoryJob(job.id, undefined, scope)
    scope?.assertActive()
    cancelled += 1
  }
  return cancelled
}

/**
 * Withdraw every still-pending mining job a backfill run queued.
 *
 * A prefix scan of the existing `dedupeKey` index, which is why the run stamps
 * its id into that key: cancelling otherwise means either a second index or a
 * full table scan, and the queue is the one table a sweep can leave thousands
 * of rows in.
 *
 * Only non-terminal rows are touched. A job that already produced claims stays
 * completed, because those claims exist and the row is their record.
 */
export async function cancelMemoryJobsForRun(runId: string): Promise<number> {
  if (!runId) return 0
  const db = getDb()
  const pending = await db.memoryJobs
    .where("dedupeKey")
    .startsWith(`project-mining:${runId}:`)
    .toArray()
  let cancelled = 0
  for (const job of pending) {
    if (job.status !== "queued" && job.status !== "running" && job.status !== "retry_wait") continue
    await cancelMemoryJob(job.id)
    cancelled += 1
  }
  return cancelled
}

/** Non-terminal mining jobs still attributable to a backfill run. */
export async function countPendingMemoryJobsForRun(runId: string): Promise<number> {
  if (!runId) return 0
  const rows = await getDb()
    .memoryJobs.where("dedupeKey")
    .startsWith(`project-mining:${runId}:`)
    .toArray()
  return rows.filter(
    (job) => job.status === "queued" || job.status === "running" || job.status === "retry_wait"
  ).length
}

export async function deleteMemoryEvidence(memoryId: string): Promise<void> {
  await getDb().memoryEvidence.where("memoryId").equals(memoryId).delete()
}

export type MemoryAuditEventDraft = Omit<MemoryAuditEvent, "id" | "createdAt"> &
  Partial<Pick<MemoryAuditEvent, "id" | "createdAt">>

export async function appendMemoryAuditEvent(
  draft: MemoryAuditEventDraft
): Promise<MemoryAuditEvent> {
  const row: MemoryAuditEvent = {
    ...draft,
    id: draft.id ?? newId("mau"),
    createdAt: draft.createdAt ?? Date.now(),
  }
  await getDb().memoryAuditEvents.add(row)
  return row
}

export async function bindMemoryGovernanceOutcome(input: {
  memoryId: string
  patch: Partial<
    Pick<
      import("@/types/memory/memory").Memory,
      "evidenceState" | "reviewStatus" | "contaminationState" | "sensitivity"
    >
  >
  evidence: MemoryEvidenceDraft
  audit: MemoryAuditEventDraft
  now?: number
}): Promise<{ evidence: MemoryEvidence; audit: MemoryAuditEvent }> {
  const db = getDb()
  const now = input.now ?? Date.now()
  return db.transaction("rw", [db.memories, db.memoryEvidence, db.memoryAuditEvents], async () => {
    if (!(await db.memories.get(input.memoryId))) throw new Error("Memory not found")
    const evidence: MemoryEvidence = {
      ...input.evidence,
      memoryId: input.memoryId,
      id: input.evidence.id ?? newId("mev"),
      createdAt: input.evidence.createdAt ?? now,
    }
    const audit: MemoryAuditEvent = {
      ...input.audit,
      memoryId: input.memoryId,
      id: input.audit.id ?? newId("mau"),
      createdAt: input.audit.createdAt ?? now,
    }
    await db.memories.update(input.memoryId, { ...input.patch, updatedAt: now })
    await db.memoryEvidence.add(evidence)
    await db.memoryAuditEvents.add(audit)
    // Inside this transaction `memories` IS in scope, so the counters commit
    // atomically with the evidence that changed them.
    const allEvidence = await db.memoryEvidence.where("memoryId").equals(input.memoryId).toArray()
    await db.memories.update(input.memoryId, { beliefInputs: computeBeliefInputs(allEvidence) })
    return { evidence, audit }
  })
}

export async function listMemoryAuditEvents(
  query: { memoryId?: string; sessionId?: string } = {}
): Promise<MemoryAuditEvent[]> {
  let collection = getDb().memoryAuditEvents.toCollection()
  if (query.memoryId) collection = collection.filter((event) => event.memoryId === query.memoryId)
  if (query.sessionId)
    collection = collection.filter((event) => event.sessionId === query.sessionId)
  return (await collection.toArray()).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Audit events newer than `cutoff`. Walks the `createdAt` index rather than
 * reading the whole (unbounded, never-pruned) table.
 */
export async function listMemoryAuditEventsSince(cutoff: number): Promise<MemoryAuditEvent[]> {
  return getDb().memoryAuditEvents.where("createdAt").above(cutoff).toArray()
}

/**
 * When decay/PII instrumentation started producing data, or `undefined` if it
 * never has. Used to decide whether a maintenance window can be reported
 * exactly or must fall back to the heuristic derived from `memories`.
 *
 * Walks the `createdAt` index in order and stops at the first match, so the
 * common case (instrumented data exists, and the earliest such event is old)
 * terminates almost immediately. The full-scan worst case is exactly the case
 * where the answer is "never instrumented" — and that scan stays on the index.
 */
export async function findEarliestInstrumentedAuditAt(
  reasons: readonly string[]
): Promise<number | undefined> {
  const match = new Set(reasons)
  const row = await getDb()
    .memoryAuditEvents.orderBy("createdAt")
    .filter((event) => match.has(event.reason))
    .first()
  return row?.createdAt
}

/** Every job row, newest-queued first. Completed rows are retained, not deleted. */
export async function listMemoryJobs(): Promise<MemoryJob[]> {
  return getDb().memoryJobs.orderBy("queuedAt").reverse().toArray()
}

export type MemoryJobDraft = Omit<MemoryJob, "id" | "status" | "queuedAt" | "retryCount"> &
  Partial<Pick<MemoryJob, "id" | "status" | "queuedAt" | "retryCount" | "attempt" | "maxAttempts">>

export async function enqueueMemoryJob(
  draft: MemoryJobDraft,
  options: { reuseCompleted?: boolean; scope?: MemoryPersistenceScope } = {}
): Promise<MemoryJob> {
  const { scope } = options
  scope?.assertActive()
  const db = scope?.db ?? getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    scope?.assertActive()
    const sameKey = await db.memoryJobs.where("dedupeKey").equals(draft.dedupeKey).toArray()
    scope?.assertActive()
    const active = sameKey.find(
      (job) => job.status === "queued" || job.status === "running" || job.status === "retry_wait"
    )
    if (active) return active
    if (options.reuseCompleted) {
      const completed = sameKey
        .filter((job) => job.status === "succeeded" || job.status === "no_output")
        .sort((a, b) => b.queuedAt - a.queuedAt)[0]
      if (completed) return completed
    }

    const row: MemoryJob = {
      ...draft,
      id: draft.id ?? newId("mjob"),
      status: draft.status ?? "queued",
      queuedAt: draft.queuedAt ?? Date.now(),
      retryCount: draft.retryCount ?? 0,
      attempt: draft.attempt ?? 0,
      maxAttempts: draft.maxAttempts ?? 4,
    }
    await db.memoryJobs.add(row)
    scope?.assertActive()
    return row
  })
}

export async function getMemoryJob(id: string): Promise<MemoryJob | undefined> {
  return getDb().memoryJobs.get(id)
}

export class MemoryJobWriteError extends Error {
  constructor(readonly code: "job_claim_lost" | "source_deleted" | "source_changed") {
    super(code)
    this.name = "MemoryJobWriteError"
  }
}

export interface MemoryJobWriteGuardOptions {
  /** Expected hash per source message id at the time the worker read the window. */
  expectedSourceHashes?: ReadonlyMap<string, string>
  /** Deterministic synchronous hash projection of a stored message row. */
  projectMessage?: (row: StoredMessage) => string
  /** Expected session `projectId` at job start. */
  projectId?: string
  /** Expected session `characterId` at job start. */
  characterId?: string
  /** Associated `projectMiningRuns` id, if queued by workspace backfill. */
  runId?: string | null
}

/** Check whether a claimed job still owns its active, uncancelled epoch. */
export async function isMemoryJobClaimActive(claimed: MemoryJob): Promise<boolean> {
  if (!claimed.leaseOwner) return true
  const current = await getDb().memoryJobs.get(claimed.id)
  return Boolean(
    current &&
    current.status === "running" &&
    current.leaseOwner === claimed.leaseOwner &&
    current.fencingEpoch === claimed.fencingEpoch &&
    current.cancellationRequestedAt === undefined
  )
}

/**
 * Fence a canonical mutation AFTER model work, in the transaction that writes
 * it. Source deletion/edit/cancellation and a newer claim cannot interleave
 * between this check and the write. Never run a provider/vector call in this
 * callback: the returned promise resolves only after the root transaction
 * commits. Lease expiry alone does not revoke an epoch (the same rule as
 * completion).
 */
export async function withMemoryJobWrite<T>(
  claimed: MemoryJob,
  sourceMessageIds: readonly string[],
  write: () => Promise<T>,
  options?: MemoryJobWriteGuardOptions
): Promise<T> {
  const db = getDb()
  return db.transaction(
    "rw",
    [
      db.memoryJobs,
      db.sessions,
      db.messages,
      db.memories,
      db.memoryEvidence,
      db.memoryAuditEvents,
      db.projectMiningRuns,
    ],
    async () => {
      const current = await db.memoryJobs.get(claimed.id)
      if (
        !current ||
        current.status !== "running" ||
        !claimed.leaseOwner ||
        current.leaseOwner !== claimed.leaseOwner ||
        current.fencingEpoch !== claimed.fencingEpoch ||
        current.cancellationRequestedAt !== undefined
      ) {
        throw new MemoryJobWriteError("job_claim_lost")
      }
      const runId = options?.runId ?? current.runId
      if (runId) {
        const run = await db.projectMiningRuns.get(runId)
        if (!run || (run.status !== "running" && run.status !== "queued")) {
          throw new MemoryJobWriteError("job_claim_lost")
        }
      }
      const session = claimed.sessionId ? await db.sessions.get(claimed.sessionId) : undefined
      if (!session) {
        throw new MemoryJobWriteError("source_deleted")
      }
      if (
        session.memoryLearn === false ||
        (options?.projectId !== undefined && session.projectId !== options.projectId) ||
        (options?.characterId !== undefined && session.characterId !== options.characterId)
      ) {
        throw new MemoryJobWriteError("source_changed")
      }
      const sources = await db.messages.bulkGet([...new Set(sourceMessageIds)])
      if (sources.some((source) => !source || source.sessionId !== claimed.sessionId)) {
        throw new MemoryJobWriteError("source_deleted")
      }
      if (options?.expectedSourceHashes && options.projectMessage) {
        for (const source of sources) {
          if (!source) continue
          const expected = options.expectedSourceHashes.get(source.id)
          if (expected !== undefined && options.projectMessage(source) !== expected) {
            throw new MemoryJobWriteError("source_changed")
          }
        }
      }
      return write()
    }
  )
}

/** Both explicit claims and lease recovery share the same claim budget. */
async function settleExhaustedMemoryJob(job: MemoryJob, now: number): Promise<void> {
  await getDb().memoryJobs.update(job.id, {
    status: "failed",
    completedAt: now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    heartbeatAt: undefined,
    nextAttemptAt: undefined,
    errorCode: job.status === "running" ? "lease_expired_max_attempts" : "max_attempts_exhausted",
    resultCode: "retry_exhausted",
  })
}

export async function claimMemoryJob(
  id: string,
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = MEMORY_JOB_LEASE_TTL_MS
): Promise<MemoryJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const job = await db.memoryJobs.get(id)
    const claimable =
      job &&
      ((job.status === "queued" && (job.nextAttemptAt ?? 0) <= now) ||
        (job.status === "retry_wait" && (job.nextAttemptAt ?? Number.POSITIVE_INFINITY) <= now) ||
        (job.status === "running" && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now))
    if (!job || !claimable) return undefined
    if ((job.attempt ?? 0) >= (job.maxAttempts ?? 4)) {
      await settleExhaustedMemoryJob(job, now)
      return undefined
    }
    const claimed: MemoryJob = {
      ...job,
      status: "running",
      startedAt: job.startedAt ?? now,
      heartbeatAt: now,
      attempt: (job.attempt ?? 0) + 1,
      // A NEW CLAIM IS A NEW EPOCH. `leaseOwner` alone cannot fence a stale
      // worker when the SAME worker id reclaims its own expired lease — owner
      // matches, so only the epoch separates the old claim from the new one.
      fencingEpoch: (job.fencingEpoch ?? 0) + 1,
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseTtlMs,
      nextAttemptAt: undefined,
      errorCode: undefined,
    }
    await db.memoryJobs.put(claimed)
    return claimed
  })
}

export async function claimNextMemoryJob(
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = MEMORY_JOB_LEASE_TTL_MS
): Promise<MemoryJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    // `[status+queuedAt]` keeps the scan ordered by claim priority. `first()`
    // stops as soon as it reaches an eligible row, rather than materializing
    // every queued/running job and sorting both arrays in renderer memory.
    const [queued, retryWait, expiredLease] = await Promise.all([
      db.memoryJobs
        .where("[status+queuedAt]")
        .between(["queued", 0], ["queued", Number.MAX_SAFE_INTEGER])
        .filter((job) => (job.nextAttemptAt ?? 0) <= now)
        .first(),
      db.memoryJobs
        .where("[status+queuedAt]")
        .between(["retry_wait", 0], ["retry_wait", Number.MAX_SAFE_INTEGER])
        .filter((job) => (job.nextAttemptAt ?? Number.POSITIVE_INFINITY) <= now)
        .first(),
      db.memoryJobs
        .where("[status+queuedAt]")
        .between(["running", 0], ["running", Number.MAX_SAFE_INTEGER])
        .filter((job) => job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now)
        .first(),
    ])
    const next = [queued, retryWait, expiredLease]
      .filter((job): job is MemoryJob => job !== undefined)
      .sort((left, right) => left.queuedAt - right.queuedAt)[0]
    if (!next) return undefined

    // Fresh claims, scheduled retries, and expired-lease recovery all consume
    // the same attempt budget. Legacy retry rows may already be exhausted.
    if ((next.attempt ?? 0) >= (next.maxAttempts ?? 4)) {
      await settleExhaustedMemoryJob(next, now)
      return undefined
    }

    const claimed: MemoryJob = {
      ...next,
      status: "running",
      startedAt: next.startedAt ?? now,
      heartbeatAt: now,
      attempt: (next.attempt ?? 0) + 1,
      fencingEpoch: (next.fencingEpoch ?? 0) + 1,
      leaseOwner: workerId,
      leaseExpiresAt: now + leaseTtlMs,
      nextAttemptAt: undefined,
      errorCode: undefined,
    }
    await db.memoryJobs.put(claimed)
    return claimed
  })
}

/**
 * Whether a completion actually landed.
 *
 * `"lost"` means the caller no longer owned the job: its lease expired and
 * another worker claimed it, or a user cancelled it while it ran. Either way
 * the row must not be overwritten, which is what makes cancellation terminal.
 */
export type MemoryJobCompletion = "finished" | "lost"

export async function finishMemoryJob(
  id: string,
  status: "succeeded" | "no_output" | "skipped" | "failed" | "cancelled",
  resultCode: string,
  now: number = Date.now(),
  options: { workerId?: string; fencingEpoch?: number } = {}
): Promise<MemoryJobCompletion> {
  const db = getDb()
  const patch = {
    status,
    completedAt: now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    heartbeatAt: undefined,
    errorCode: undefined,
    resultCode,
  }
  // Callers that pass no `workerId` keep the old unconditional behavior, so
  // existing surfaces (the console, migrations) are unaffected.
  if (!options.workerId) {
    await db.memoryJobs.update(id, patch)
    return "finished"
  }
  return db.transaction("rw", db.memoryJobs, async () => {
    const job = await db.memoryJobs.get(id)
    if (!job || job.status !== "running" || job.leaseOwner !== options.workerId) return "lost"
    // Fencing: when the caller presents the epoch it claimed under, a row now
    // owned by a LATER claim refuses the completion — covering the case where
    // the same worker id legitimately reclaimed its own expired lease.
    if (options.fencingEpoch !== undefined && job.fencingEpoch !== options.fencingEpoch) {
      return "lost"
    }
    await db.memoryJobs.update(id, patch)
    return "finished"
  })
}

export async function heartbeatMemoryJob(
  id: string,
  workerId: string,
  now: number = Date.now(),
  leaseTtlMs = MEMORY_JOB_LEASE_TTL_MS,
  fencingEpoch?: number
): Promise<MemoryJob | undefined> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const job = await db.memoryJobs.get(id)
    if (
      !job ||
      job.status !== "running" ||
      job.leaseOwner !== workerId ||
      (job.leaseExpiresAt ?? 0) < now ||
      // Epoch fencing: a worker renewing under an epoch a later claim replaced
      // must see `undefined` — otherwise the SAME worker id re-claiming its
      // expired lease would keep the stale loop alive forever.
      (fencingEpoch !== undefined && job.fencingEpoch !== fencingEpoch)
    ) {
      return undefined
    }
    const heartbeat = { ...job, heartbeatAt: now, leaseExpiresAt: now + leaseTtlMs }
    await db.memoryJobs.put(heartbeat)
    return heartbeat
  })
}

export async function cancelMemoryJob(
  id: string,
  now: number = Date.now(),
  scope?: MemoryPersistenceScope
): Promise<MemoryJob | undefined> {
  scope?.assertActive()
  const db = scope?.db ?? getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    scope?.assertActive()
    const job = await db.memoryJobs.get(id)
    scope?.assertActive()
    if (!job || TERMINAL_MEMORY_JOB_STATUSES.includes(job.status)) return job
    const cancelled: MemoryJob = {
      ...job,
      status: "cancelled",
      cancellationRequestedAt: now,
      completedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      resultCode: "cancelled_by_user",
    }
    await db.memoryJobs.put(cancelled)
    scope?.assertActive()
    return cancelled
  })
}

/**
 * Re-queue a terminal job as a NEW row.
 *
 * The source row is never reopened: it stays terminal so the audit trail keeps
 * saying what happened to it, and the new row links back through
 * `retryOfJobId`. Mirrors `retryStoredRetrievalJob` in the retrieval control
 * plane, which solved the same problem the same way.
 *
 * `skipped` is deliberately not retryable. It is a terminal policy refusal, not
 * a transient failure, so re-running it would just refuse again.
 */
export async function retryMemoryJob(
  id: string,
  now: number = Date.now()
): Promise<MemoryJob | undefined> {
  const source = await getDb().memoryJobs.get(id)
  if (!source) return undefined
  if (source.status !== "failed" && source.status !== "cancelled") return undefined

  const retried = await enqueueMemoryJob({
    // The key MUST differ. `reuseCompleted` would otherwise hand back the very
    // row we are retrying and the retry would silently do nothing.
    dedupeKey: `${source.dedupeKey}:manual-retry:${now}`,
    kind: source.kind,
    scope: source.scope,
    provenance: source.provenance,
    evidenceIds: source.evidenceIds,
    queuedAt: now,
    retryOfJobId: source.id,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(source.projectId ? { projectId: source.projectId } : {}),
    ...(source.characterId ? { characterId: source.characterId } : {}),
    ...(source.agentId ? { agentId: source.agentId } : {}),
    ...(source.checkpoint ? { checkpoint: source.checkpoint } : {}),
    ...(source.memoryId ? { memoryId: source.memoryId } : {}),
    ...(source.maxAttempts !== undefined ? { maxAttempts: source.maxAttempts } : {}),
  })

  await appendMemoryAuditEvent({
    action: "learn-allowed",
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    // `MemoryAuditAction` has no `retry` member, and adding one would touch the
    // package type and every consumer switching on it. The reason carries it.
    reason: "job_retry",
    metadata: { sourceJobId: source.id, newJobId: retried.id, kind: source.kind },
  }).catch(() => undefined)

  return retried
}

export async function failMemoryJob(
  id: string,
  errorCode: string,
  now: number = Date.now(),
  options: {
    maxRetries?: number
    baseDelayMs?: number
    workerId?: string
    fencingEpoch?: number
  } = {}
): Promise<MemoryJobStatus> {
  const db = getDb()
  return db.transaction("rw", db.memoryJobs, async () => {
    const job = await db.memoryJobs.get(id)
    if (!job) return "failed"
    // A terminal job is never reopened. Without this a job cancelled while it
    // ran came back as `retry_wait` on the losing worker's error path, so the
    // cancel silently did nothing.
    if (TERMINAL_MEMORY_JOB_STATUSES.includes(job.status)) return job.status
    if (options.workerId && job.leaseOwner !== options.workerId) return job.status
    // Epoch fencing — see `finishMemoryJob`. A stale claim's error path must
    // not schedule a retry on a row a newer claim owns.
    if (options.fencingEpoch !== undefined && job.fencingEpoch !== options.fencingEpoch) {
      return job.status
    }

    const retryCount = job.retryCount + 1
    // The compatibility option may lower the claim budget, but processing
    // errors and lease recovery consume the very same `attempt` counter.
    const maxAttempts = Math.min(
      job.maxAttempts ?? 4,
      options.maxRetries === undefined ? Number.POSITIVE_INFINITY : options.maxRetries + 1
    )
    if ((job.attempt ?? 0) < maxAttempts) {
      const baseDelayMs = options.baseDelayMs ?? 1_000
      await db.memoryJobs.update(id, {
        status: "retry_wait",
        retryCount,
        nextAttemptAt: now + baseDelayMs * 2 ** (retryCount - 1),
        errorCode,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        heartbeatAt: undefined,
        resultCode: "retry_scheduled",
      })
      return "retry_wait"
    }

    await db.memoryJobs.update(id, {
      status: "failed",
      retryCount,
      completedAt: now,
      nextAttemptAt: undefined,
      errorCode,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      resultCode: "retry_exhausted",
    })
    return "failed"
  })
}

export async function pruneMemoryGovernanceData(
  now: number = Date.now(),
  cap = 20_000
): Promise<{
  jobsDeleted: number
  auditsDeleted: number
  orphanEvidenceDeleted: number
  operationsDeleted: number
}> {
  const db = getDb()
  const dayMs = 24 * 60 * 60 * 1000
  return db.transaction(
    "rw",
    [db.memoryJobs, db.memoryAuditEvents, db.memoryEvidence, db.memoryOperations],
    async () => {
      const jobs = await db.memoryJobs.toArray()
      const jobsToDelete = new Set(
        jobs
          .filter((job) => {
            const terminalAt = job.completedAt ?? job.queuedAt
            const shortRetention = job.status === "succeeded" || job.status === "no_output"
            return terminalAt < now - (shortRetention ? 30 : 90) * dayMs
          })
          .map((job) => job.id)
      )
      const successful = jobs
        .filter(
          (job) =>
            (job.status === "succeeded" || job.status === "no_output") && !jobsToDelete.has(job.id)
        )
        .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
      for (const job of successful.slice(cap)) jobsToDelete.add(job.id)
      const auditIds = (await db.memoryAuditEvents
        .where("createdAt")
        .below(now - 180 * dayMs)
        .primaryKeys()) as string[]
      // Evidence that never got attached to a memory. The turn path used to write
      // two of these per turn BEFORE the job existed, and `deleteMemoryEvidence`
      // keys on `memoryId`, so nothing could ever reach them. The write is gone,
      // but shipped databases still hold the leak.
      const orphanEvidence = (await db.memoryEvidence.toArray())
        .filter((row) => !row.memoryId && row.createdAt < now - 30 * dayMs)
        .map((row) => row.id)
      // Operation receipts only deduplicate retries — a replay past the
      // succeeded-job window re-executes harmlessly, so 30 days bounds the
      // ledger. This also frees `pending` reservations whose writer died
      // mid-apply: a stale marker must not pin an operation id forever.
      const operationIds = (await db.memoryOperations
        .where("createdAt")
        .below(now - 30 * dayMs)
        .primaryKeys()) as string[]

      await db.memoryJobs.bulkDelete([...jobsToDelete])
      await db.memoryAuditEvents.bulkDelete(auditIds)
      await db.memoryEvidence.bulkDelete(orphanEvidence)
      await db.memoryOperations.bulkDelete(operationIds)
      return {
        jobsDeleted: jobsToDelete.size,
        auditsDeleted: auditIds.length,
        orphanEvidenceDeleted: orphanEvidence.length,
        operationsDeleted: operationIds.length,
      }
    }
  )
}
