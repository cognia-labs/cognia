/**
 * Cross-database effects of the fusion ledger (ADR-0188 D39).
 *
 * The fusion database cannot share a transaction with the account database, so
 * anything the ledger must also make visible there — a usage row, a milestone
 * on the execution run — is written into `fusionOutbox` INSIDE the ledger
 * transaction that caused it, and applied afterwards. Every effect id is
 * derived from what it is about, and every applier is idempotent, so replaying
 * the outbox after a crash in any window yields each effect exactly once.
 *
 * Failures back off through the shared retry policy, then become inspectable
 * dead letters at its attempt cap. Unknown kinds go straight to dead letter.
 * One due wake per database retries pending effects without waiting for a new
 * write; a later drain replaces it and closing the database cancels it.
 * Every drain and applier call checks the injected target guard: a different
 * active account leaves the remaining rows untouched and stops the wake chain.
 * Session messages wait behind older pending messages for the same session,
 * inheriting their due time without spending an attempt. Dead letters do not
 * block: the dead-letter diagnostic lists the later messages of that session
 * that will apply without it.
 */

import Dexie from "dexie"

import { decideNextAttempt } from "@/lib/queue/retry-policy"

import type { FusionDB } from "./fusion-db"
import type { FusionOutboxKind, FusionOutboxRow } from "./types"

export type OutboxApplyResult = "applied" | "skipped"

/**
 * What an applier may read besides its row. Outbox rows carry ids only; an
 * effect that writes content (a session message) reads it back from the run's
 * encrypted artifacts through the store that queued it.
 */
export interface OutboxContext {
  readArtifact: (artifactId: string) => Promise<string | null>
}

export type OutboxApplier = (
  row: FusionOutboxRow,
  context: OutboxContext
) => Promise<OutboxApplyResult>
export type OutboxAppliers = Record<FusionOutboxKind, OutboxApplier>

/** A drain that was given no store cannot read content; an effect that needs it stays pending. */
const NO_ARTIFACT_READER = new Error(
  "this outbox drain has no artifact reader; the effect waits for one that has"
)
const NO_ARTIFACTS: OutboxContext = {
  readArtifact: async () => {
    throw NO_ARTIFACT_READER
  },
}

export interface DrainResult {
  applied: number
  skipped: number
  failed: number
}

interface OutboxWake {
  cancel: () => void
  appliers: OutboxAppliers
  waitingForReader: Set<string>
}

const draining = new WeakMap<FusionDB, Promise<DrainResult>>()
const wakes = new WeakMap<FusionDB, OutboxWake>()

export const FUSION_OUTBOX_RETRY_POLICY = {
  baseDelayMs: 15_000,
  maxDelayMs: 15 * 60_000,
} as const

export interface DrainOptions {
  limit?: number
  now?: () => number
  random?: () => number
  readArtifact?: OutboxContext["readArtifact"]
  /** Whether this fusion DB still pairs with the account DB the appliers write to. */
  targetMatches?: () => boolean
  scheduleWake?: (delayMs: number, fire: () => void) => () => void
}

/** Cancel even an already-queued callback; a later drain may schedule a new wake. */
export function cancelFusionOutboxWake(db: FusionDB): void {
  const wake = wakes.get(db)
  wakes.delete(db)
  wake?.cancel()
}

/**
 * Creation order, strict even within one millisecond: a run's input and its
 * answer can share a `createdAt`, and the input must still come first. A
 * session's next run cannot start while its previous transcript effect is
 * pending (`pendingTranscriptRun`), so ties only occur inside one run.
 */
function compareCreation(a: FusionOutboxRow, b: FusionOutboxRow): number {
  const phaseRank = (row: FusionOutboxRow) => (row.payload.phase === "input" ? 0 : 1)
  return (
    a.createdAt - b.createdAt ||
    phaseRank(a) - phaseRank(b) ||
    (a.effectId < b.effectId ? -1 : a.effectId > b.effectId ? 1 : 0)
  )
}

const scheduleWake: NonNullable<DrainOptions["scheduleWake"]> = (delayMs, fire) => {
  const timer = setTimeout(fire, delayMs)
  if (typeof timer === "object") timer.unref?.()
  return () => clearTimeout(timer)
}

export function drainFusionOutbox(
  db: FusionDB,
  appliers: OutboxAppliers,
  options: DrainOptions = {}
): Promise<DrainResult> {
  if (options.targetMatches?.() === false) {
    cancelFusionOutboxWake(db)
    return Promise.resolve({ applied: 0, skipped: 0, failed: 0 })
  }
  // One drain per database at a time: a second caller joins the running one
  // instead of applying the same effects concurrently.
  const inFlight = draining.get(db)
  if (inFlight) return inFlight
  const wake = wakes.get(db)
  const waitingForReader =
    !options.readArtifact && wake?.appliers === appliers ? wake.waitingForReader : new Set<string>()
  cancelFusionOutboxWake(db)
  const run = drainOnce(db, appliers, options, waitingForReader).finally(() => draining.delete(db))
  draining.set(db, run)
  return run
}

/**
 * Pending session messages of `row`'s session created after it, in creation
 * order: the turns that apply without `row` once it dead-letters. Some may
 * still wait behind another pending row. Diagnostic only, so a read failure
 * yields an empty list rather than escaping the drain.
 */
async function laterSessionMessages(db: FusionDB, row: FusionOutboxRow): Promise<string[]> {
  if (row.kind !== "session_message" || typeof row.payload.sessionId !== "string") return []
  try {
    const later = await db.fusionOutbox
      .where("[status+nextAttemptAt]")
      .between(["pending", Dexie.minKey], ["pending", Dexie.maxKey], true, true)
      .filter(
        (other) =>
          other.kind === "session_message" &&
          other.payload.sessionId === row.payload.sessionId &&
          compareCreation(row, other) < 0
      )
      .toArray()
    return later.sort(compareCreation).map((other) => other.effectId)
  } catch {
    return []
  }
}

async function drainOnce(
  db: FusionDB,
  appliers: OutboxAppliers,
  options: DrainOptions,
  waitingForReader: Set<string>
): Promise<DrainResult> {
  const now = options.now ?? (() => Date.now())
  const context: OutboxContext = options.readArtifact
    ? { readArtifact: options.readArtifact }
    : NO_ARTIFACTS
  const due = db.fusionOutbox
    .where("[status+nextAttemptAt]")
    .between(["pending", Dexie.minKey], ["pending", now()], true, true)
  const dueRows = await (
    waitingForReader.size ? due.filter((row) => !waitingForReader.has(row.effectId)) : due
  ).toArray()
  // Equal-due messages must reach the batch in creation order, even when its
  // limit would otherwise pick an answer's primary key ahead of its input.
  const batch = dueRows
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || compareCreation(a, b))
    .slice(0, options.limit ?? 500)
  const result: DrainResult = { applied: 0, skipped: 0, failed: 0 }
  for (const row of batch) {
    if (options.targetMatches?.() === false) return result
    if (row.kind === "session_message" && typeof row.payload.sessionId === "string") {
      // Scan the pending range only: applied rows stay in the table until
      // their run is reaped, and a createdAt range would walk all of them.
      const blocker = await db.fusionOutbox
        .where("[status+nextAttemptAt]")
        .between(["pending", Dexie.minKey], ["pending", Dexie.maxKey], true, true)
        .filter(
          (older) =>
            older.kind === "session_message" &&
            compareCreation(older, row) < 0 &&
            older.payload.sessionId === row.payload.sessionId
        )
        .first()
      if (options.targetMatches?.() === false) return result
      if (blocker) {
        await db.fusionOutbox.update(row.effectId, { nextAttemptAt: blocker.nextAttemptAt })
        // A readerless predecessor cannot progress on this wake chain either.
        if (waitingForReader.has(blocker.effectId)) waitingForReader.add(row.effectId)
        continue
      }
    }
    const applier = Object.hasOwn(appliers, row.kind) ? appliers[row.kind] : undefined
    try {
      if (!applier) throw new Error(`No outbox applier for ${row.kind}`)
      if (options.targetMatches?.() === false) return result
      const outcome = await applier(row, context)
      // The appliers write through the active account database. A switch
      // while one was awaiting may have sent its write to the new account; the
      // effect stays pending so its own account still gets it (appliers are
      // idempotent per database), and the drain stops.
      if (options.targetMatches?.() === false) {
        console.warn("[router-fusion] account changed while an outbox effect was applied", {
          effectId: row.effectId,
          runId: row.runId,
          kind: row.kind,
        })
        return result
      }
      await db.fusionOutbox.update(row.effectId, {
        status: outcome,
        attempts: row.attempts + 1,
        lastError: null,
        appliedAt: now(),
      })
      result[outcome] += 1
    } catch (error) {
      result.failed += 1
      if (error === NO_ARTIFACT_READER) {
        waitingForReader.add(row.effectId)
        await db.fusionOutbox.update(row.effectId, { lastError: NO_ARTIFACT_READER.message })
        continue
      }
      const failedAt = now()
      const decision = decideNextAttempt({
        attempts: row.attempts,
        error,
        nowMs: failedAt,
        random: options.random,
        policy: FUSION_OUTBOX_RETRY_POLICY,
        forceRetryable: true,
      })
      const deadlettered = !applier || decision.status === "deadlettered"
      await db.fusionOutbox.update(row.effectId, {
        status: deadlettered ? "deadletter" : "pending",
        attempts: decision.attempts,
        nextAttemptAt: deadlettered ? failedAt : decision.nextAttemptAt,
        lastError: decision.lastError,
        deadletteredAt: deadlettered ? failedAt : null,
      })
      if (deadlettered) {
        // A dead letter stops holding up its session (it never applies, and
        // waiting on it forever would stall the transcript), so the session's
        // later messages now apply without it. Name them: the transcript has
        // a gap where this one was, and these are the turns that follow it.
        const proceeding = await laterSessionMessages(db, row)
        console.warn("[router-fusion] outbox effect dead-lettered", {
          effectId: row.effectId,
          runId: row.runId,
          kind: row.kind,
          attempts: decision.attempts,
          lastError: decision.lastError,
          ...(proceeding.length > 0 ? { sessionMessagesProceedingWithoutIt: proceeding } : {}),
        })
      }
    }
  }
  const pending = db.fusionOutbox
    .where("[status+nextAttemptAt]")
    .between(["pending", Dexie.minKey], ["pending", Dexie.maxKey], true, true)
  // The same readerless context cannot make these rows runnable. Keep their
  // due times intact, but skip them through this wake chain until a reader arrives.
  const next = await (
    waitingForReader.size ? pending.filter((row) => !waitingForReader.has(row.effectId)) : pending
  ).first()
  if (next && db.isOpen() && options.targetMatches?.() !== false) {
    const wake: OutboxWake = {
      appliers,
      waitingForReader,
      cancel: (options.scheduleWake ?? scheduleWake)(
        Math.max(0, next.nextAttemptAt - now()),
        () => {
          // A cancelled timer may already be queued when a later drain replaces it.
          if (wakes.get(db) !== wake) return
          void drainFusionOutbox(db, appliers, options).catch((error) => {
            console.warn("[router-fusion] outbox wake failed", error)
          })
        }
      ),
    }
    wakes.set(db, wake)
  }
  return result
}
