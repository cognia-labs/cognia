import Dexie from "dexie"
import { loggers } from "@cognia/logging"
import type { ActionReviewReceipt } from "@cognia/agent-config-types/action-review"
import { recordActionReviewReceiptInsideTransaction } from "./action-review-receipts"
import { reduceRunEvents } from "@/lib/execution/run-reducer"
import type {
  ExecutionRun,
  ExecutionRunBinding,
  ExecutionRunKind,
  ExecutionRunInterrupt,
  ExecutionRunInitiator,
  ExecutionRunStatus,
  RunEvent,
  RunEventType,
  RunEventVisibility,
  RunProjectionSnapshot,
} from "@/types/execution/run"
import { getDb, withDbReopenRetry } from "./schema"
import { redactText } from "@cognia/redact"
import { touchNotificationProjectionInTransaction } from "./notification-projection-work"
import { cachedNotificationScopeKey } from "@/lib/notifications/scope"
import { recordedRunMetadata } from "@/lib/execution/acting-authority"
import { inheritableRunAuthority } from "@/types/execution/run"

export type AppendRunEventInput = Omit<RunEvent, "id" | "runId" | "seq" | "projectId"> & {
  id?: string
}

function eventId(runId: string, input: AppendRunEventInput): string {
  if (input.id) return input.id
  if (input.sourceEventId) return `execution-event:${runId}:${input.sourceEventId}`
  return `execution-event:${crypto.randomUUID()}`
}

function redactPayloadValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value).redacted
  if (Array.isArray(value)) return value.map(redactPayloadValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        redactPayloadValue(child),
      ])
    )
  }
  return value
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactPayloadValue(payload) as Record<string, unknown>
}

/** Retry schema reopenings only within the initiating account/target database. */
function withExecutionDatabaseRetry<T>(
  operation: (db: ReturnType<typeof getDb>) => Promise<T>
): Promise<T> {
  const databaseName = getDb().name
  return withDbReopenRetry(() => {
    const database = getDb()
    if (database.name !== databaseName)
      throw new Dexie.AbortError("Execution journal database changed")
    return operation(database)
  })
}

export async function createExecutionRun(run: ExecutionRun): Promise<ExecutionRun> {
  return withExecutionDatabaseRetry(async (db) => {
    let recorded = run.authority
      ? { ...run, authority: { ...run.authority, caps: "explicit-v1" as const } }
      : run
    if (run.parentRunId) {
      const { resolveRunAuthority } = await import("@/lib/execution/run-authority")
      const inherited = await resolveRunAuthority({
        parentRunId: run.parentRunId,
        requested: run.authority,
        actingIdentity: run.actingIdentity,
      })
      const parent = await db.executionRuns.get(run.parentRunId)
      recorded = {
        ...run,
        ...recordedRunMetadata("child", { runId: run.id, parent, authority: run.authority }),
        ...(inherited.authority ? { authority: inherited.authority } : {}),
        ...(inherited.actingIdentity ? { actingIdentity: inherited.actingIdentity } : {}),
      }
    }
    await db.executionRuns.add(recorded)
    return recorded
  })
}

export async function getExecutionRun(runId: string): Promise<ExecutionRun | undefined> {
  return getDb().executionRuns.get(runId)
}

/** Waiter/engine decisions are authoritative; these rows only project them. */
export function isWaiterBackedInterrupt(row: ExecutionRunInterrupt): boolean {
  return row.type === "tool_approval" || row.type === "ask_user" || row.type === "workflow_approval"
}

export const INTERRUPT_CLAIM_MAX_AGE_MS = 3 * 60_000
const interruptClaimOwnerId = crypto.randomUUID()

function interruptDecisionTables(
  db: ReturnType<typeof getDb>,
  includeChild = false,
  includeReceipt = false
) {
  return [
    db.executionRunInterrupts,
    db.executionRuns,
    db.executionRunEvents,
    db.notificationProjectionWork,
    ...(includeChild ? [db.agentTeamChildRuns] : []),
    ...(includeReceipt ? [db.actionReviewReceipts] : []),
  ]
}

/**
 * Caller owns the transaction, including the journal and its notification outbox.
 * A successful handler may already have sealed the journal (e.g. recovery Stop).
 * Still settle the row's CAS, but skip the event on that sealed journal: appending
 * it must neither roll back the decision nor re-project a terminal run as live.
 */
async function finishInterruptInsideTransaction(
  db: ReturnType<typeof getDb>,
  row: ExecutionRunInterrupt,
  resolution: "approve" | "deny" | "expired",
  now: number,
  actor?: ExecutionRunInitiator
): Promise<void> {
  await db.executionRunInterrupts.update(row.id, {
    status: resolution === "expired" ? "expired" : resolution === "approve" ? "approved" : "denied",
    decidingClaim: undefined,
    resolvedAt: now,
    ...(resolution === "expired" ? { decision: undefined } : {}),
    ...(actor ? { resolvedBy: actor } : {}),
  })
  const run = await db.executionRuns.get(row.runId)
  if (run && ["completed", "failed", "cancelled"].includes(run.status)) return
  await appendRunEventInsideTransaction(
    db,
    row.runId,
    semanticRunEvent(
      resolution === "expired" ? "interrupt.expired" : "interrupt.resolved",
      { interruptId: row.id, ...(resolution === "expired" ? {} : { resolution }) },
      {
        ts: now,
        sourceEventId: `interrupt:${row.id}:${resolution === "expired" ? "expired" : "resolved"}`,
      }
    )
  )
}

export type InterruptClaimRefusal =
  "interrupt_not_found" | "interrupt_resolved" | "interrupt_expired" | "interrupt_stale"

/** Cross-process CAS: reserve before running any persisted decision's effect. */
export async function claimExecutionRunInterrupt(
  runId: string,
  interruptId: string,
  claim: NonNullable<ExecutionRunInterrupt["decidingClaim"]>
): Promise<{ interrupt: ExecutionRunInterrupt } | { reason: InterruptClaimRefusal }> {
  const db = getDb()
  return db.transaction("rw", interruptDecisionTables(db, true), async () => {
    const row = await db.executionRunInterrupts.get(interruptId)
    if (!row || row.runId !== runId) return { reason: "interrupt_not_found" as const }
    if (
      row.status !== "pending" ||
      (row.decidingClaim &&
        (row.decidingClaim.renewedAt ?? row.decidingClaim.at) >
          claim.at - INTERRUPT_CLAIM_MAX_AGE_MS)
    )
      return { reason: "interrupt_resolved" as const }
    const child =
      row.childRunId && row.dispatchEpoch !== undefined
        ? await db.agentTeamChildRuns.get(row.childRunId)
        : undefined
    const stale =
      row.childRunId !== undefined &&
      row.dispatchEpoch !== undefined &&
      (!child || (child.dispatchEpoch ?? 0) !== row.dispatchEpoch)
    if (stale || row.expiresAt <= claim.at) {
      await finishInterruptInsideTransaction(db, row, "expired", claim.at)
      return { reason: stale ? ("interrupt_stale" as const) : ("interrupt_expired" as const) }
    }
    const ownedClaim = { ...claim, ownerId: interruptClaimOwnerId, renewedAt: claim.at }
    await db.executionRunInterrupts.update(row.id, { decidingClaim: ownedClaim })
    return { interrupt: { ...row, decidingClaim: ownedClaim } }
  })
}

/** A failed handler releases only its own claim, never another decider's. */
export async function releaseExecutionRunInterruptClaim(
  interruptId: string,
  token: string,
  staleBefore?: number
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.executionRunInterrupts, async () => {
    const row = await db.executionRunInterrupts.get(interruptId)
    if (
      row?.status === "pending" &&
      row.decidingClaim?.token === token &&
      (staleBefore === undefined ||
        (row.decidingClaim.renewedAt ?? row.decidingClaim.at) <= staleBefore)
    )
      await db.executionRunInterrupts.update(interruptId, { decidingClaim: undefined })
  })
}

/** Heartbeat CAS: a superseded owner cannot renew another decision's claim. */
export async function renewExecutionRunInterruptClaim(
  interruptId: string,
  token: string
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.executionRunInterrupts, async () => {
    const row = await db.executionRunInterrupts.get(interruptId)
    if (
      row?.status === "pending" &&
      row.decidingClaim?.token === token &&
      row.decidingClaim.ownerId === interruptClaimOwnerId
    )
      await db.executionRunInterrupts.update(interruptId, {
        decidingClaim: { ...row.decidingClaim, renewedAt: Date.now() },
      })
  })
}

/**
 * Resolve and journal exactly once. Ordinary expiry cannot steal a live claim;
 * a waiting Squad gate may enforce its deadline, and revocation invalidates it.
 */
export async function finishExecutionRunInterrupt(
  runId: string,
  interruptId: string,
  resolution: "approve" | "deny" | "expired",
  now: number,
  options: {
    token?: string
    actor?: ExecutionRunInitiator
    sourceWinner?: boolean
    decision?: ExecutionRunInterrupt["decision"]
    receipt?: ActionReviewReceipt
    /** A waiting Squad lifecycle owns its deadline, even over a pending claim. */
    expireAtDeadline?: boolean
    checkBinding?: boolean
    revokeChild?: { id: string; epoch: number }
  } = {}
): Promise<boolean> {
  const db = getDb()
  let receiptFailed = false
  const settle = (withReceipt: boolean) =>
    db.transaction(
      "rw",
      interruptDecisionTables(
        db,
        options.revokeChild !== undefined || options.checkBinding === true,
        withReceipt && options.receipt !== undefined
      ),
      async () => {
        const row = await db.executionRunInterrupts.get(interruptId)
        if (!row || row.runId !== runId || row.status !== "pending") return false
        if (options.revokeChild) {
          const child = await db.agentTeamChildRuns.get(options.revokeChild.id)
          const recoveryEpochs =
            row.type === "team_recovery"
              ? (row.subject?.uncertainChildEpochs as Record<string, number> | undefined)
              : undefined
          const bound =
            (row.childRunId === child?.id && row.dispatchEpoch === options.revokeChild.epoch) ||
            recoveryEpochs?.[options.revokeChild.id] === options.revokeChild.epoch
          if (!child || (child.dispatchEpoch ?? 0) !== options.revokeChild.epoch || !bound)
            return false
        } else if (options.expireAtDeadline && resolution === "expired") {
          if (row.expiresAt > now) return false
        } else if (options.token) {
          if (row.decidingClaim?.token !== options.token) return false
        } else if (row.decidingClaim && !(options.sourceWinner && isWaiterBackedInterrupt(row))) {
          return false
        }
        if (options.checkBinding && row.childRunId && row.dispatchEpoch !== undefined) {
          const child = await db.agentTeamChildRuns.get(row.childRunId)
          if (!child || (child.dispatchEpoch ?? 0) !== row.dispatchEpoch) {
            await finishInterruptInsideTransaction(db, row, "expired", now)
            return false
          }
        }
        // A source for a persisted decision has no waiter winner to project after
        // the deadline. A claimed handler, however, was admitted before expiry.
        if (
          !options.token &&
          !isWaiterBackedInterrupt(row) &&
          resolution !== "expired" &&
          row.expiresAt <= now
        ) {
          await finishInterruptInsideTransaction(db, row, "expired", now)
          return false
        }
        if (options.decision)
          await db.executionRunInterrupts.update(row.id, { decision: options.decision })
        await finishInterruptInsideTransaction(db, row, resolution, now, options.actor)
        if (withReceipt && options.receipt) {
          try {
            await recordActionReviewReceiptInsideTransaction(db, options.receipt)
          } catch (error) {
            receiptFailed = true
            throw error
          }
        }
        return true
      }
    )
  try {
    return await settle(true)
  } catch (error) {
    if (!receiptFailed || !options.receipt) throw error
    // The decision's effect may already have run (a recovery stop, a
    // replacement): an audit write must never roll back its resolution.
    // Settle without the receipt, then record it on its own.
    const settled = await settle(false)
    if (settled) {
      const { recordActionReviewReceipt } = await import("./action-review-receipts")
      await recordActionReviewReceipt(options.receipt).catch((receiptError: unknown) =>
        loggers.store.warn("Interrupt resolved but its approval receipt was not recorded", {
          interruptId,
          error: receiptError instanceof Error ? receiptError.message : String(receiptError),
        })
      )
    }
    return settled
  }
}

/** Job owners include these tables in the same transaction as every terminal write. */
export function jobExecutionTables(db: ReturnType<typeof getDb>) {
  return [db.executionRuns, db.executionRunEvents, db.notificationProjectionWork]
}

/** Never leave a terminal/deleted job's execution live, even if its runner stops. */
export async function settleJobExecutionInsideTransaction(
  db: ReturnType<typeof getDb>,
  jobKey: string,
  status: "completed" | "failed" | "cancelled"
): Promise<void> {
  const id = `execution:job:${jobKey}`
  const run = await db.executionRuns.get(id)
  if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return
  // Paired clients sync summaries, never these private journal events. A
  // missing local job row must not cancel a mirrored Host execution.
  const entry = await db.executionRunEvents.get(`execution-event:${id}:tool-entry:${id}`)
  if (entry?.type !== "run.started") return
  await appendRunEventInsideTransaction(
    db,
    id,
    semanticRunEvent(`run.${status}`, {}, { sourceEventId: `job-terminal:${id}` })
  )
}

export interface ExecutionRunQuery {
  kinds?: readonly ExecutionRunKind[]
  statuses?: readonly ExecutionRunStatus[]
  projectId?: string
  sessionId?: string
  limit?: number
}

/** Canonical query used by Agent Runs, monitoring, and remote-safe projections. */
export async function listExecutionRuns(query: ExecutionRunQuery = {}): Promise<ExecutionRun[]> {
  const kinds = query.kinds ? new Set(query.kinds) : undefined
  const statuses = query.statuses ? new Set(query.statuses) : undefined
  const limit = Math.max(1, query.limit ?? 50)
  const table = getDb().executionRuns
  // Preserve the global timestamp order (including primary-key ties), but
  // constrain session reads before materializing rows for residual filters.
  const ordered = query.sessionId
    ? table
        .where("[sessionId+updatedAt]")
        .between([query.sessionId, Dexie.minKey], [query.sessionId, Dexie.maxKey], true, true)
    : table.orderBy("updatedAt")
  return ordered
    .reverse()
    .filter(
      (run) =>
        (!kinds || kinds.has(run.kind)) &&
        (!statuses || statuses.has(run.status)) &&
        (!query.projectId || run.projectId === query.projectId) &&
        (!query.sessionId || run.sessionId === query.sessionId)
    )
    .limit(limit)
    .toArray()
}

/**
 * Every run of `kind` whose source id starts with `prefix`, newest first. Reads
 * the `[kind+sourceId]` index, so it costs the matching rows only.
 */
export async function listExecutionRunsBySourcePrefix(
  kind: ExecutionRun["kind"],
  prefix: string
): Promise<ExecutionRun[]> {
  const rows = await getDb()
    .executionRuns.where("[kind+sourceId]")
    .between([kind, prefix], [kind, `${prefix}\uffff`], true, true)
    .toArray()
  return rows.sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * Every run that belongs to `parentRunId`, newest first.
 *
 * Indexed since v176. Before that the column existed but the question cost a
 * full scan, so nothing asked it — which is why a delegation could not roll its
 * children onto one card and `retry` could not link a replacement run.
 */
export async function listChildExecutionRuns(
  parentRunId: string,
  options: { statuses?: readonly ExecutionRunStatus[] } = {}
): Promise<ExecutionRun[]> {
  const statuses = options.statuses ? new Set(options.statuses) : undefined
  const rows = await getDb().executionRuns.where("parentRunId").equals(parentRunId).toArray()
  return rows
    .filter((run) => !statuses || statuses.has(run.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/**
 * Adopt an already-created run into a parent.
 *
 * The delegation path cannot always create the child itself: an agent turn is
 * minted by the runtime before anyone knows the turn will be promoted to
 * background work. Adoption is how a run that started inline joins the
 * delegation that later took it over, instead of the delegation having to
 * pre-empt a decision it does not yet have the evidence for.
 */
export async function adoptExecutionRun(runId: string, parentRunId: string): Promise<boolean> {
  if (runId === parentRunId) return false
  const { resolveRunAuthority, RunAuthorityError } = await import("@/lib/execution/run-authority")
  const { canonicalJson } = await import("@cognia/agent")
  return withExecutionDatabaseRetry((db) =>
    db.transaction("rw", db.executionRuns, db.executionRunEvents, async () => {
      const run = await db.executionRuns.get(runId)
      if (!run || run.parentRunId === parentRunId) return false
      const resolved = await resolveRunAuthority({
        parentRunId,
        forbiddenAncestorRunId: runId,
        requested: inheritableRunAuthority(run.authority),
        actingIdentity: run.actingIdentity,
      })
      // A running engine cannot retroactively acquire a stricter policy by
      // changing its journal row. Its owner must stop/relaunch it first.
      if (
        run.status === "running" &&
        canonicalJson({ schemaVersion: 1, ...resolved.authority, caps: undefined }) !==
          canonicalJson({
            schemaVersion: 1,
            ...inheritableRunAuthority(run.authority),
            caps: undefined,
          })
      )
        throw new RunAuthorityError("unsupported_authority", "running adoption requires relaunch")
      const parent = await db.executionRuns.get(parentRunId)
      const inherited = parent
        ? recordedRunMetadata("child", {
            runId: run.id,
            parent,
            authority: inheritableRunAuthority(run.authority),
          })
        : undefined
      if (run.authority && run.authority.caps !== "explicit-v1")
        await appendRunObservation(
          run.id,
          {
            operation: "legacy_authority_observed",
            inheritedFields: run.authority.pools ? ["pools"] : [],
          },
          { throttleMs: Number.MAX_SAFE_INTEGER }
        )
      await db.executionRuns.update(runId, {
        parentRunId,
        // Adoption happens after creation: never replace an established fixed
        // identity or discard requesters/revisions already absorbed by this run.
        ...(!run.actingIdentity && parent?.actingIdentity ? inherited : {}),
        ...(resolved.authority ? { authority: resolved.authority } : {}),
      })
      return true
    })
  )
}

export async function createExecutionRunBinding(
  binding: ExecutionRunBinding
): Promise<ExecutionRunBinding> {
  await getDb().executionRunBindings.add(binding)
  return binding
}

export async function putExecutionRunBinding(
  binding: ExecutionRunBinding
): Promise<ExecutionRunBinding> {
  await withExecutionDatabaseRetry((db) =>
    db.executionRunBindings.put(binding).then(() => undefined)
  )
  return binding
}

export async function getExecutionRunBinding(
  bindingId: string
): Promise<ExecutionRunBinding | undefined> {
  return getDb().executionRunBindings.get(bindingId)
}

export async function listExecutionRunBindings(runId: string): Promise<ExecutionRunBinding[]> {
  return getDb().executionRunBindings.where("runId").equals(runId).toArray()
}

export async function updateExecutionRunBinding(
  bindingId: string,
  patch: Partial<ExecutionRunBinding>
): Promise<void> {
  // `updatedAt` is the companion-sync cursor for this table
  // (`readExecutionRunBindingsDelta`); a patch that leaves it alone would
  // change the row without ever re-sending it.
  await getDb().executionRunBindings.update(bindingId, {
    ...patch,
    updatedAt: patch.updatedAt ?? Date.now(),
  })
}

export async function listExecutionRunEvents(runId: string): Promise<RunEvent[]> {
  return getDb()
    .executionRunEvents.where("[runId+seq]")
    .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
    .toArray()
}

/**
 * Observation-only records live outside the executable journal sequence.
 * Canonical events start at 1; reducers already exclude seq <= 0. Recording
 * at 0 preserves the raw audit without advancing control revisions, touching
 * notification work, republishing IM cards, or changing a terminal run.
 */
export async function appendRunObservation(
  runId: string,
  payload: Record<string, unknown>,
  options?: { throttleMs: number }
): Promise<RunEvent | undefined> {
  return withExecutionDatabaseRetry((db) =>
    db.transaction("rw", db.executionRuns, db.executionRunEvents, async () => {
      const run = await db.executionRuns.get(runId)
      const now = Date.now()
      const redacted = redactPayload(payload)
      if (options) {
        const recent = await db.executionRunEvents
          .where("[runId+seq]")
          .equals([runId, 0])
          .filter(
            (event) =>
              event.ts > now - options.throttleMs &&
              event.payload.operation === redacted.operation &&
              event.payload.path === redacted.path
          )
          .first()
        if (recent) return undefined
      }
      const event: RunEvent = {
        id: `execution-observation:${crypto.randomUUID()}`,
        runId,
        seq: 0,
        ts: now,
        type: "authority.observed",
        visibility: "private",
        payload: redacted,
        ...(run?.projectId ? { projectId: run.projectId } : {}),
      }
      await db.executionRunEvents.add(event)
      return event
    })
  )
}

export async function listVisibleExecutionRunEvents(
  runId: string,
  includePrivate = false
): Promise<RunEvent[]> {
  const events = await listExecutionRunEvents(runId)
  return includePrivate ? events : events.filter((event) => event.visibility !== "private")
}

export async function getExecutionRunSnapshot(
  runId: string
): Promise<RunProjectionSnapshot | undefined> {
  return (await getExecutionRun(runId))?.latestSnapshot
}

/**
 * Append a run event using the caller's already-open transaction.
 *
 * {@link runEventJournal.append} cannot be used from inside another
 * transaction: it wraps itself in `withDbReopenRetry` + a fresh
 * `db.transaction(...)`, and the retry wrapper breaks out of Dexie's
 * transaction zone. Callers that must journal atomically alongside other
 * writes — the work-submission acceptance transaction, for one — take this
 * entry point instead and supply the `db` bound to their transaction.
 *
 * The caller's transaction scope must already include `executionRuns`,
 * `executionRunEvents`, AND `notificationProjectionWork` (Dexie v227 — the
 * commit-time notification touch writes the dirty marker into the same
 * transaction). Callers on older scopes get a "table not in transaction"
 * error, which is the intended loud signal to widen their scope.
 */
export function appendRunEventInsideTransaction(
  db: ReturnType<typeof getDb>,
  runId: string,
  input: AppendRunEventInput
): Promise<RunEvent> {
  return appendInsideTransaction(db, runId, input)
}

/** Batch variant for an existing transaction, retaining one replay cache per batch. */
export function appendRunEventsInsideTransaction(
  db: ReturnType<typeof getDb>,
  runId: string,
  inputs: readonly AppendRunEventInput[]
): Promise<RunEvent[]> {
  // A cache belongs to one transaction attempt, never to an aborted retry.
  const batchHistory: { events?: RunEvent[] } = {}
  const initial = db.executionRuns.get(runId).then(() => [] as RunEvent[])
  return inputs.reduce<Promise<RunEvent[]>>(
    (pending, input) =>
      pending.then((out) =>
        appendInsideTransaction(db, runId, input, batchHistory).then((event) => {
          out.push(event)
          return out
        })
      ),
    initial
  )
}

function appendInsideTransaction(
  db: ReturnType<typeof getDb>,
  runId: string,
  input: AppendRunEventInput,
  batchHistory?: { events?: RunEvent[] }
): Promise<RunEvent> {
  const id = eventId(runId, input)
  return db.executionRuns.get(runId).then((run) => {
    if (!run) throw new Error(`Execution run not found: ${runId}`)
    return db.executionRunEvents.get(id).then((duplicate) => {
      if (duplicate) return duplicate
      // Like authority observations, provenance is private audit data outside
      // the executable sequence. It must not republish a card or move even a
      // completed ancestor in the UI while its background child reads.
      if (input.type === "personal.marked") {
        const event: RunEvent = {
          id,
          runId,
          seq: 0,
          ts: input.ts,
          type: input.type,
          visibility: "private",
          payload: redactPayload(input.payload),
          ...(run.projectId ? { projectId: run.projectId } : {}),
          ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
        }
        return db.executionRunEvents.add(event).then(() => event)
      }
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        throw new Error(`Execution run is terminal: ${runId}`)
      }

      const event: RunEvent = {
        id,
        runId,
        seq: run.currentRevision + 1,
        ts: input.ts,
        type: input.type,
        visibility: input.visibility,
        payload: redactPayload(input.payload),
        ...(run.projectId ? { projectId: run.projectId } : {}),
        ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
      }
      return db.executionRunEvents
        .add(event)
        .then(() => {
          const events = batchHistory?.events
          if (events && Number.isFinite(event.seq) && event.seq > (events.at(-1)?.seq ?? -1)) {
            // Read back the stored row so encryption/serialization has exactly
            // the same semantics as a full replay. The transaction excludes
            // competing writers; only this batch can extend its history.
            return db.executionRunEvents.get(event.id).then((stored) => {
              if (stored) events.push(stored)
              return events
            })
          }
          // Legacy gaps or conflicting sequences retain the index's canonical
          // seq/primary-key ordering instead of assuming append-only order.
          return db.executionRunEvents
            .where("[runId+seq]")
            .between([runId, 0], [runId, Number.POSITIVE_INFINITY])
            .toArray()
            .then((rows) => {
              if (batchHistory) batchHistory.events = rows
              return rows
            })
        })
        .then((events) => {
          const snapshot = reduceRunEvents({ ...run, currentRevision: 0 }, events)
          return db.executionRuns
            .update(runId, {
              status: snapshot.status,
              currentRevision: snapshot.revision,
              latestSnapshot: snapshot,
              updatedAt: snapshot.updatedAt,
              ...(snapshot.endedAt !== undefined ? { endedAt: snapshot.endedAt } : {}),
            })
            .then(() =>
              // V2 (Dexie v227): mark notification projection work dirty in
              // the SAME commit as the event. The projector consumes the row;
              // a missed wake is recovered by the reconciler sweep. The
              // scopeKey derives from the run's workspace via the primed
              // identity cache — synchronous, so it never abandons this
              // transaction. Callers whose outer transaction predates v227
              // must include `notificationProjectionWork` in its scope.
              touchNotificationProjectionInTransaction(db, {
                runId,
                scopeKey: cachedNotificationScopeKey(run.projectId),
                desiredRunSeq: event.seq,
              }).then(() => event)
            )
        })
    })
  })
}

export interface RunEventJournal {
  append(runId: string, input: AppendRunEventInput): Promise<RunEvent>
  appendBatch(runId: string, inputs: readonly AppendRunEventInput[]): Promise<RunEvent[]>
  replay(runId: string): Promise<RunEvent[]>
  getSnapshot(runId: string): Promise<RunProjectionSnapshot | undefined>
  subscribe(
    runId: string,
    listener: (snapshot: RunProjectionSnapshot | undefined) => void
  ): () => void
}

export const runEventJournal: RunEventJournal = {
  async append(runId, input) {
    const idempotentInput = input.id ? input : { ...input, id: eventId(runId, input) }
    return withExecutionDatabaseRetry((db) => {
      return db.transaction(
        "rw",
        db.executionRuns,
        db.executionRunEvents,
        db.notificationProjectionWork,
        () => appendInsideTransaction(db, runId, idempotentInput)
      )
    })
  },

  async appendBatch(runId, inputs) {
    const idempotentInputs = inputs.map((input) =>
      input.id ? input : { ...input, id: eventId(runId, input) }
    )
    return withExecutionDatabaseRetry((db) => {
      return db.transaction(
        "rw",
        db.executionRuns,
        db.executionRunEvents,
        db.notificationProjectionWork,
        () => appendRunEventsInsideTransaction(db, runId, idempotentInputs)
      )
    })
  },

  replay: listExecutionRunEvents,
  getSnapshot: getExecutionRunSnapshot,

  subscribe(runId, listener) {
    // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
    // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
    // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
    const subscription = Dexie.liveQuery(() => getExecutionRunSnapshot(runId)).subscribe({
      next: listener,
      error: () => listener(undefined),
    })
    return () => subscription.unsubscribe()
  },
}

export const EXECUTION_RUN_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export async function sweepExecutionRunEventRetention(now: number = Date.now()): Promise<number> {
  const cutoff = now - EXECUTION_RUN_EVENT_RETENTION_MS
  const terminalRuns = await getDb()
    .executionRuns.where("status")
    .anyOf("completed", "failed", "cancelled")
    .toArray()
  const expiredRunIds = terminalRuns
    .filter((run) => run.endedAt !== undefined && run.endedAt < cutoff)
    .map((run) => run.id)
  let deleted = 0
  await getDb().transaction("rw", getDb().executionRunEvents, async () => {
    for (const runId of expiredRunIds) {
      deleted += await getDb().executionRunEvents.where("runId").equals(runId).delete()
    }
  })
  return deleted
}

/** Convenience constructor for source mappers that already have semantic payloads. */
export function semanticRunEvent(
  type: RunEventType,
  payload: Record<string, unknown>,
  options: {
    ts?: number
    visibility?: RunEventVisibility
    sourceEventId?: string
  } = {}
): AppendRunEventInput {
  return {
    type,
    payload,
    ts: options.ts ?? Date.now(),
    visibility: options.visibility ?? "summary",
    ...(options.sourceEventId ? { sourceEventId: options.sourceEventId } : {}),
  }
}
