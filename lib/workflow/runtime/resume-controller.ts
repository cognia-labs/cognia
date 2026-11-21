/**
 * Boot-time resume controller.
 *
 * On app start, continues every run a dead process left unfinished. Two
 * sources name them: the Rust mirror (`workflow_reload_in_flight_runs`), and —
 * on a Host that executes runs — the durable `workflowRuns` table itself,
 * because an admission records its `pending` run (and hands out its run id)
 * before the first mirror write, so a crash in between leaves a run only
 * Dexie knows about.
 *
 * The Dexie row is the source of truth for WHAT to continue: its frozen
 * snapshot, its original trigger (kind, node, payload, binding, origin time),
 * its formal binding and invocation, its origin and its draft bounds. A
 * formal run continues through its invocation (`resumeAdmittedRun`), so the
 * invocation settles with the run; a draft run re-enters the orchestrator,
 * which inherits the rest from the row. The IdempotencyCache (hydrated from
 * the durable event log) replays completed steps with the routes they chose.
 *
 * Replays are dispatched concurrently and this function returns once they
 * are under way — a resumed run that waits hours on an approval must not hold
 * up the others, nor the boot sequence that called this. A run whose lease
 * is still held by another executor (a fast restart leaves the dead process's
 * lease live for up to its TTL) is re-checked when that lease expires, and
 * keeps being followed while a live executor renews it.
 *
 * Runs another runtime synthesized go through that runtime, which registers a
 * {@link RunRecoveryOwner}. One that recovers its runs itself (Agent Team runs,
 * `__team__:` workflow ids) has them left alone: replaying a team run here
 * would execute team nodes without the team run context they need
 * (ADR-0217). One that gives a `resume` (plan runs, `__plan__:` ids) has its
 * runs found, checked and dispatched here like any other, and continues each
 * itself, so the run context comes back and the owner settles with the run.
 */

import { getDb } from "@/lib/db/schema"
import { runWorkflow } from "./orchestrator"
import { resumeAdmittedRun } from "./execution-authority"
import { ackRunCompleted, hasNativeWorkflowPlane, reloadInFlightRuns } from "./tauri-bridge"
import { getExecutorId } from "./run-lease"
import { isRunLive } from "./run-cancel-registry"
import type {
  InFlightRunRow,
  RunStatus,
  TriggerEvent,
  WorkflowRunRow,
} from "@/types/workflow/visual"

/** Statuses a dead process can leave behind that the boot scan continues. */
const RESUMABLE_STATUSES: readonly RunStatus[] = ["pending", "running"]
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"])

/** Slack after a lease's expiry before it is re-checked. */
const LEASE_RECHECK_SLACK_MS = 250

export interface ResumeSettlement {
  succeeded: number
  failed: number
  /** Ended up waiting on a human (approval, input). */
  waiting: number
  /** Another executor claimed the run first; it is driving it. */
  elsewhere: number
}

export interface ResumeResult {
  /** Distinct runs the mirror and the run table named. */
  attempted: number
  /** Replays dispatched now. */
  started: number
  /** Held by another executor's live lease; re-checked when it expires. */
  deferred: number
  /** Nothing to continue: no durable row, no snapshot, or already finished. */
  skipped: number
  /** Rows a registered recovery owner recovers itself; not replayed here. */
  delegated: number
  /** Settles once every replay dispatched NOW has returned. */
  settled: Promise<ResumeSettlement>
}

export interface ResumeOptions {
  /**
   * Aborting stops the deferred lease re-checks (the runtime is shutting
   * down). It never cancels a replay already under way: a resumed run belongs
   * to the Host, not to the component lifecycle that started the scan.
   */
  signal?: AbortSignal
}

/** A runtime that owns the recovery of the workflow runs it synthesized. */
export interface RunRecoveryOwner {
  id: string
  owns(row: InFlightRunRow): boolean
  /**
   * Continue an owned run the scan found resumable, not live here and not
   * leased elsewhere. Absent: the owner recovers its runs on its own, and the
   * scan leaves them alone (`delegated`).
   */
  resume?(row: WorkflowRunRow): Promise<RunStatus>
}

const recoveryOwners = new Map<string, RunRecoveryOwner>()

/** Register (or replace, by id) a recovery owner. Returns its unregister. */
export function registerRunRecoveryOwner(owner: RunRecoveryOwner): () => void {
  recoveryOwners.set(owner.id, owner)
  return () => {
    if (recoveryOwners.get(owner.id) === owner) recoveryOwners.delete(owner.id)
  }
}

function recoveryOwnerOf(row: InFlightRunRow): RunRecoveryOwner | undefined {
  for (const owner of recoveryOwners.values()) if (owner.owns(row)) return owner
  return undefined
}

function inFlightViewOf(row: WorkflowRunRow): InFlightRunRow {
  return {
    runId: row.id,
    workflowId: row.workflowId,
    ...(row.lastCompletedStepId ? { lastStepId: row.lastCompletedStepId } : {}),
    snapshot: row.workflowSnapshot,
    startedAt: row.startedAt,
  }
}

/** The trigger the run was admitted with, exactly as its row recorded it. */
export function originalTriggerOf(row: WorkflowRunRow): TriggerEvent {
  return {
    workflowId: row.workflowId,
    kind: row.triggerKind,
    ...(row.triggerId ? { triggerId: row.triggerId } : {}),
    ...(row.triggerBinding ? { binding: row.triggerBinding } : {}),
    payload: row.triggerPayload,
    originAt: row.triggerOriginAt ?? row.startedAt,
  }
}

function heldElsewhere(row: WorkflowRunRow, now = Date.now()): boolean {
  return Boolean(row.lease && row.lease.expiresAt > now && row.lease.ownerId !== getExecutorId())
}

/**
 * Continue every run a dead process left unfinished. Returns a summary as
 * soon as the replays are dispatched; `settled` resolves when they return.
 */
export async function resumeInFlightRuns(options: ResumeOptions = {}): Promise<ResumeResult> {
  const mirrorRows = await reloadInFlightRuns()
  const db = getDb()
  const candidates = new Map<string, InFlightRunRow | undefined>()
  for (const row of mirrorRows) candidates.set(row.runId, row)
  // Only a Host that executes runs scans its own table: a paired client's
  // `workflowRuns` are synced copies of runs another Host is driving.
  if (hasNativeWorkflowPlane()) {
    const durable = await db.workflowRuns
      .where("status")
      .anyOf(RESUMABLE_STATUSES as RunStatus[])
      .primaryKeys()
    for (const runId of durable) if (!candidates.has(runId)) candidates.set(runId, undefined)
  }

  const replays: Promise<RunStatus>[] = []
  const result: Omit<ResumeResult, "settled"> = {
    attempted: candidates.size,
    started: 0,
    deferred: 0,
    skipped: 0,
    delegated: 0,
  }
  for (const [runId, mirrorRow] of candidates) {
    const row = await db.workflowRuns.get(runId)
    const view = row ? inFlightViewOf(row) : mirrorRow
    const owner = view ? recoveryOwnerOf(view) : undefined
    if (owner && !owner.resume) {
      result.delegated += 1
      continue
    }
    // Without its durable row there is nothing faithful to continue: the
    // trigger, binding and event log live there. A mirror row whose run row is
    // gone belongs to data this account no longer holds; it is left as is.
    if (!row || !row.workflowSnapshot?.id) {
      if (!row)
        console.warn(`workflow resume controller: run ${runId} has no durable row; skipping`)
      result.skipped += 1
      continue
    }
    if (TERMINAL_STATUSES.has(row.status) || !RESUMABLE_STATUSES.includes(row.status)) {
      if (TERMINAL_STATUSES.has(row.status)) await ackRunCompleted(runId)
      result.skipped += 1
      continue
    }
    if (isRunLive(runId)) {
      // Already driven by this process (admitted while the scan ran).
      result.skipped += 1
      continue
    }
    if (heldElsewhere(row)) {
      result.deferred += 1
      followLease(runId, row.lease!.expiresAt, options.signal)
      continue
    }
    result.started += 1
    replays.push(replay(row))
  }

  return { ...result, settled: settle(replays) }
}

async function settle(replays: Promise<RunStatus>[]): Promise<ResumeSettlement> {
  const settlement: ResumeSettlement = { succeeded: 0, failed: 0, waiting: 0, elsewhere: 0 }
  for (const outcome of await Promise.allSettled(replays)) {
    if (outcome.status === "rejected") settlement.failed += 1
    else if (outcome.value === "succeeded") settlement.succeeded += 1
    else if (outcome.value === "waiting" || outcome.value === "paused") settlement.waiting += 1
    else if (outcome.value === "running" || outcome.value === "pending") settlement.elsewhere += 1
    else settlement.failed += 1
  }
  return settlement
}

async function replay(row: WorkflowRunRow): Promise<RunStatus> {
  try {
    const owner = recoveryOwnerOf(inFlightViewOf(row))
    if (owner) {
      // Registered between the scan and a lease re-check without a `resume`:
      // the owner recovers it, so this process does not touch it.
      if (!owner.resume) return row.status
      return await owner.resume(row)
    }
    const formal = await resumeAdmittedRun(row.id)
    if (formal) return formal.result.status
    const result = await runWorkflow({
      workflow: row.workflowSnapshot,
      trigger: originalTriggerOf(row),
      runId: row.id,
    })
    return result.status
  } catch (err) {
    console.error("workflow resume controller: replay threw", {
      runId: row.id,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/**
 * Re-check a run whose lease another executor held at boot, once that lease
 * expires. A dead process stops renewing, so its lease lapses and the run is
 * continued here; a live executor keeps renewing, and the run is followed to
 * its next expiry until it finishes or is taken over.
 */
function followLease(runId: string, expiresAt: number, signal?: AbortSignal): void {
  if (signal?.aborted) return
  const timer = setTimeout(
    () => {
      signal?.removeEventListener("abort", stop)
      void (async () => {
        const row = await getDb().workflowRuns.get(runId)
        if (!row || !RESUMABLE_STATUSES.includes(row.status) || isRunLive(runId)) return
        if (heldElsewhere(row)) {
          followLease(runId, row.lease!.expiresAt, signal)
          return
        }
        await replay(row).catch(() => undefined)
      })().catch((err) => {
        console.warn("workflow resume controller: lease re-check failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    },
    Math.max(0, expiresAt - Date.now()) + LEASE_RECHECK_SLACK_MS
  )
  const stop = () => clearTimeout(timer)
  signal?.addEventListener("abort", stop, { once: true })
}
