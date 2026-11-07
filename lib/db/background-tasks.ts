import type {
  BackgroundTaskJournal,
  BackgroundTaskJournalPatch,
  BackgroundTaskJournalRecord,
  BackgroundTaskStatus,
  BackgroundDispatchRecovery,
  BackgroundTaskJournalWriter,
} from "@/lib/background-tasks/registry-core"
import { interruptRunningTasks } from "@/lib/background-tasks/registry-core"
import { isJobOutboxKind, JOB_RECONCILE_WINDOW_MS } from "@/lib/background-tasks/job-settlement"
// The contract package, not the kernel's `types/execution` (foundation).
import { isTerminalRunStatus, type ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import { getDb } from "./schema"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"

/*
 * The renderer's `backgroundTasks` table is a delivery outbox (ADR-0252 §2):
 * an entry holds what a parent session is owed — the result, its delivery
 * batch and state, the replay proof — and the outbox's own two facts, whether
 * the result has been recorded (`settledAt`) and whether its host stopped
 * before it was (`interruptedAt`). It stores no run status: the launcher's
 * `execution:job:<runId>` row is the run, and the read functions below join
 * it back as `status`. CLI-host entries keep storing `status` (the CLI journal
 * has no execution runs, ADR-0252 D13), and so do `shell-job` and `monitor`
 * entries, which are not runs at all (ADR-0249): they are written once, settled,
 * by `upsertBackgroundJobSettlement`.
 */

export const BACKGROUND_TASK_LEASE_TTL_MS = 60_000
const DEFAULT_OWNER_ID = crypto.randomUUID()
type OwnerLease = NonNullable<BackgroundTaskJournalRow["ownerLease"]>
type LeaseOptions = { ownerId?: string; now?: () => number }

/** Whether the entry keeps its own status instead of reading its run's. */
function storesOwnStatus(row: Pick<BackgroundTaskJournalRow, "host" | "kind">): boolean {
  return row.host !== "renderer" || isJobOutboxKind(row.kind)
}

/**
 * The result is not recorded yet: for the outbox, the entry is still open. A
 * CLI entry's stored status says so.
 */
function isUnsettled(row: BackgroundTaskJournalRow): boolean {
  if (!storesOwnStatus(row)) return row.settledAt === undefined
  return row.status === "running" || (row.status === undefined && row.settledAt === undefined)
}

/**
 * Its host stopped before the result arrived. A CLI entry, and a renderer
 * entry written before the outbox, say so with their stored status.
 */
function isInterrupted(row: BackgroundTaskJournalRow): boolean {
  return row.interruptedAt !== undefined || (storesOwnStatus(row) && row.status === "interrupted")
}

/** A renderer run's entry never stores the run's status; a CLI or job entry does. */
function storedRow<T extends Partial<BackgroundTaskJournalRecord>>(
  owner: Pick<BackgroundTaskJournalRow, "host" | "kind">,
  row: T
): Omit<T, "status"> | T {
  if (storesOwnStatus(owner)) return row
  const { status: _status, ...rest } = row
  return rest
}

/**
 * An update to a stored entry. On a renderer entry it also clears a status
 * written before the outbox (Dexie deletes a key updated to `undefined`), so
 * no stale copy of the run's status survives on the row.
 */
function storedPatch<T extends Partial<BackgroundTaskJournalRecord>>(
  owner: Pick<BackgroundTaskJournalRow, "host" | "kind">,
  patch: T
): Omit<T, "status"> | T {
  return storesOwnStatus(owner) ? patch : { ...storedRow(owner, patch), status: undefined }
}

function executionRowId(runId: string): string {
  return `execution:job:${runId}`
}

/**
 * The status an entry reads with. A renderer entry's is its run's, gated by
 * the outbox: until the result is recorded the entry is still `running` (a
 * collect must never read an ended run whose result has not landed), and an
 * entry whose host stopped first is `interrupted` whatever the run row says.
 * An entry with no run row (its launch was refused) reads from its result.
 */
export function backgroundTaskStatus(
  row: BackgroundTaskJournalRow,
  run: Pick<ExecutionRun, "status"> | undefined
): BackgroundTaskStatus {
  if (storesOwnStatus(row))
    return row.status ?? (isUnsettled(row) ? "running" : row.error ? "error" : "done")
  if (isInterrupted(row)) return "interrupted"
  if (isUnsettled(row) || (run && !isTerminalRunStatus(run.status))) return "running"
  if (run) return run.status === "completed" ? "done" : "error"
  return row.error ? "error" : "done"
}

/** Outbox facts only, for decisions made inside a `backgroundTasks` transaction. */
function outboxRecord(row: BackgroundTaskJournalRow): BackgroundTaskJournalRecord {
  return {
    ...row,
    status:
      storesOwnStatus(row) && row.status
        ? row.status
        : isInterrupted(row)
          ? "interrupted"
          : isUnsettled(row)
            ? "running"
            : row.error
              ? "error"
              : "done",
  }
}

async function withRunStatus(
  rows: BackgroundTaskJournalRow[]
): Promise<BackgroundTaskJournalRecord[]> {
  const renderer = rows.filter((row) => !storesOwnStatus(row))
  const runs = renderer.length
    ? await getDb().executionRuns.bulkGet(renderer.map((row) => executionRowId(row.runId)))
    : []
  const byId = new Map<string, ExecutionRun>()
  for (const run of runs) if (run) byId.set(run.id, run)
  return rows.map((row) => ({
    ...row,
    status: backgroundTaskStatus(row, byId.get(executionRowId(row.runId))),
  }))
}

function ownsRunningTask(
  row: BackgroundTaskJournalRow | undefined,
  lease: OwnerLease,
  now: number
): boolean {
  return Boolean(
    row &&
    isUnsettled(row) &&
    !isInterrupted(row) &&
    row.ownerLease?.ownerId === lease.ownerId &&
    row.ownerLease?.epoch === lease.epoch &&
    row.ownerLease.expiresAt > now
  )
}

/** A settle records the result: the entry is settled from then on. */
function terminalPatch(current: BackgroundTaskJournalRow, patch: BackgroundTaskJournalPatch) {
  return {
    ...storedPatch(current, patch),
    settledAt: patch.settledAt ?? Date.now(),
    ...(current.host === "renderer" &&
    current.kind === "subagent" &&
    current.mode !== "foreground" &&
    (patch.status === "done" || patch.status === "error")
      ? { deliveryState: current.deliveryState ?? "pending" }
      : {}),
  }
}

function changesExecution(patch: BackgroundTaskJournalPatch): boolean {
  return ["status", "settledAt", "resultText", "error", "usage", "cancelRequestedAt"].some(
    (key) => key in patch
  )
}

/**
 * The stored entry. `status` is absent from a renderer entry (its run is the
 * status) and present on a CLI one; read entries back through
 * `listBackgroundTaskRecords` / `getBackgroundTaskRecord` to get a status.
 */
export type BackgroundTaskJournalRow = Omit<BackgroundTaskJournalRecord, "status"> & {
  status?: BackgroundTaskStatus
}

export interface BackgroundTaskListFilter {
  host?: BackgroundTaskJournalRow["host"]
  status?: BackgroundTaskStatus
}

export async function recordBackgroundTaskStart(row: BackgroundTaskJournalRow): Promise<void> {
  await getDb().backgroundTasks.add(storedRow(row, row))
}

export type JobSettlementUpsert =
  /** First sight of this end: the entry was written. */
  | { kind: "created"; record: BackgroundTaskJournalRecord }
  /** Already recorded (a second event, or reconciliation after the event). */
  | { kind: "known"; record: BackgroundTaskJournalRecord }

/**
 * Record a `shell-job` or `monitor` entry's end (ADR-0249 §1). Idempotent by
 * job or monitor id: the first report writes the settled entry, a repeat
 * leaves it as it is. One fact may still move: a monitor end first reported
 * as owed and since returned inline by the blocking call becomes `skipped`,
 * as long as no delivery batch has claimed it.
 */
export async function upsertBackgroundJobSettlement(
  record: BackgroundTaskJournalRecord
): Promise<JobSettlementUpsert> {
  if (!isJobOutboxKind(record.kind)) throw new Error("Not a background job entry")
  const db = getDb()
  return db.transaction("rw", db.backgroundTasks, async () => {
    const current = await db.backgroundTasks.get(record.runId)
    if (!current) {
      await db.backgroundTasks.add(record)
      return { kind: "created" as const, record }
    }
    if (
      record.deliveryState === "skipped" &&
      current.deliveryState === "pending" &&
      !current.deliveryId
    ) {
      const patch = {
        deliveryState: "skipped" as const,
        ...(record.job ? { job: record.job } : {}),
      }
      await db.backgroundTasks.update(record.runId, patch)
      return { kind: "known" as const, record: outboxRecord({ ...current, ...patch }) }
    }
    return { kind: "known" as const, record: outboxRecord(current) }
  })
}

export async function recordBackgroundTaskSettle(
  runId: string,
  patch: BackgroundTaskJournalPatch
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.backgroundTasks, async () => {
    const current = await db.backgroundTasks.get(runId)
    if (!current) return
    if (current.ownerLease) throw new Error("Background task ownership required")
    await db.backgroundTasks.update(runId, terminalPatch(current, patch))
  })
}

export async function updateBackgroundTaskRecord(
  runId: string,
  patch: BackgroundTaskJournalPatch
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.backgroundTasks, async () => {
    const current = await db.backgroundTasks.get(runId)
    if (current?.ownerLease && changesExecution(patch))
      throw new Error("Background task ownership required")
    await db.backgroundTasks.update(runId, current ? storedPatch(current, patch) : patch)
  })
}

/** One entry with its status (its run's, for a renderer entry). */
export async function getBackgroundTaskRecord(
  runId: string
): Promise<BackgroundTaskJournalRecord | undefined> {
  const row = await getDb().backgroundTasks.get(runId)
  return row ? (await withRunStatus([row]))[0] : undefined
}

/** Stored entries, newest first, with no status joined. */
async function listStoredRows(
  host: BackgroundTaskJournalRow["host"] | undefined
): Promise<BackgroundTaskJournalRow[]> {
  const db = getDb()
  const rows = host
    ? await db.backgroundTasks.where("host").equals(host).toArray()
    : await db.backgroundTasks.toArray()
  return rows.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Entries with their status, newest first. Reads `executionRuns` as well, so
 * a live query over it follows each run, and it cannot run inside a
 * transaction that only spans `backgroundTasks`.
 */
export async function listBackgroundTaskRecords(
  filter: BackgroundTaskListFilter = {}
): Promise<BackgroundTaskJournalRecord[]> {
  const rows = await withRunStatus(await listStoredRows(filter.host))
  return filter.status ? rows.filter((row) => row.status === filter.status) : rows
}

/** Drop every entry whose result is recorded (its run has ended). */
export async function clearSettledBackgroundTasks(
  filter: BackgroundTaskListFilter = {}
): Promise<void> {
  const db = getDb()
  const rows = await listBackgroundTaskRecords(filter)
  const settled = rows.filter((row) => row.status !== "running").map((row) => row.runId)
  if (settled.length > 0) await db.backgroundTasks.bulkDelete(settled)
}

export function createDexieBackgroundTaskJournal(
  options: LeaseOptions = {}
): BackgroundTaskJournal & {
  renewLease(runId: string): Promise<boolean>
} {
  const now = options.now ?? Date.now
  const ownerId = options.ownerId ?? DEFAULT_OWNER_ID
  const admissions = new Map<string, { db: ReturnType<typeof getDb>; lease: OwnerLease }>()
  const requireAdmission = (runId: string) => {
    const admission = admissions.get(runId)
    if (!admission) throw new Error("Background task ownership required")
    if (getDb() !== admission.db) throw new Error("Background task scope changed")
    return admission
  }
  return {
    leaseIntervalMs: BACKGROUND_TASK_LEASE_TTL_MS / 3,
    async recordStart(record) {
      if (admissions.has(record.runId)) throw new Error("Background run already exists")
      const db = getDb()
      const lease = { ownerId, epoch: 1, expiresAt: now() + BACKGROUND_TASK_LEASE_TTL_MS }
      // Capture before the first await so immediately-settled promises remain scoped.
      admissions.set(record.runId, { db, lease })
      try {
        await db.backgroundTasks.add({
          ...storedRow(record, record),
          ...(record.host === "renderer" ? { ownerLease: lease } : {}),
        })
      } catch (error) {
        admissions.delete(record.runId)
        throw error
      }
    },
    async recordSettle(runId, patch) {
      const captured = admissions.get(runId)
      try {
        const { db, lease } = requireAdmission(runId)
        await db.transaction("rw", db.backgroundTasks, async () => {
          requireAdmission(runId)
          const current = await db.backgroundTasks.get(runId)
          requireAdmission(runId)
          if (!current || (current.host === "renderer" && !ownsRunningTask(current, lease, now())))
            throw new Error("Background task ownership lost")
          await db.backgroundTasks.update(runId, terminalPatch(current, patch))
        })
      } finally {
        if (admissions.get(runId) === captured) admissions.delete(runId)
      }
    },
    async renewLease(runId) {
      const admission = admissions.get(runId)
      if (!admission) return false
      if (getDb() !== admission.db) {
        admissions.delete(runId)
        return false
      }
      const { db, lease } = admission
      const renewed = await db.transaction("rw", db.backgroundTasks, async () => {
        if (getDb() !== db) return false
        const current = await db.backgroundTasks.get(runId)
        if (getDb() !== db) return false
        const at = now()
        if (!ownsRunningTask(current, lease, at)) return false
        if (current?.cancelRequestedAt !== undefined) return "cancelled" as const
        await db.backgroundTasks.update(runId, {
          ownerLease: { ...lease, expiresAt: at + BACKGROUND_TASK_LEASE_TTL_MS },
        })
        return true
      })
      if (renewed === false && admissions.get(runId) === admission) admissions.delete(runId)
      return renewed === true
    },
    list: listBackgroundTaskRecords,
    get: getBackgroundTaskRecord,
    async update(runId, patch) {
      if (!changesExecution(patch)) {
        if (admissions.has(runId)) requireAdmission(runId)
        return updateBackgroundTaskRecord(runId, patch)
      }
      const { db, lease } = requireAdmission(runId)
      await db.transaction("rw", db.backgroundTasks, async () => {
        requireAdmission(runId)
        const current = await db.backgroundTasks.get(runId)
        requireAdmission(runId)
        if (!current || !ownsRunningTask(current, lease, now()))
          throw new Error("Background task ownership lost")
        await db.backgroundTasks.update(runId, storedPatch(current, patch))
      })
    },
    clearSettled: clearSettledBackgroundTasks,
  }
}

/**
 * Reconcile orphaned runs atomically with settlement. Versioned, unclaimed
 * recovery remains discoverable if a previous boot died before redispatch;
 * legacy interrupted history stays inert. The dispatcher still verifies all
 * identity, policy, effect, and attempt evidence before accepting a restart.
 */
export async function interruptBackgroundTasksOnBoot(
  options: {
    now?: () => number
    host?: BackgroundTaskJournalRow["host"]
    isLive?: (runId: string) => boolean
    recoverInterrupted?: boolean
    /**
     * Every row this pass flipped to `interrupted`, unknown owners included,
     * once the flip has committed. The caller settles what else the rows stood
     * for (the renderer: each run's `executionRuns` row).
     */
    onInterrupted?: (rows: BackgroundTaskJournalRecord[]) => Promise<void>
  } = {}
): Promise<BackgroundTaskJournalRecord[]> {
  const db = getDb()
  let flipped: BackgroundTaskJournalRecord[] = []
  const result = await db.transaction("rw", db.backgroundTasks, async () => {
    const at = (options.now ?? Date.now)()
    // Outbox facts decide here: an open entry whose host stopped is
    // interrupted, whatever its run row says (that row is settled after).
    const rows = (await db.backgroundTasks.toArray())
      .filter(
        (row) =>
          (!options.host || row.host === options.host) &&
          (row.ownerLease !== undefined || !options.isLive?.(row.runId)) &&
          !(row.host === "renderer" && row.ownerLease && row.ownerLease.expiresAt > at)
      )
      .map(outboxRecord)
    const unknownOwners = new Set(
      rows.filter((row) => row.host === "renderer" && !row.ownerLease).map((row) => row.runId)
    )
    const interrupted = await interruptRunningTasks(
      {
        ...createDexieBackgroundTaskJournal(),
        list: async () => rows,
        update: async (runId, patch) => {
          const owner = rows.find((row) => row.runId === runId) ?? {
            host: "renderer" as const,
            kind: "subagent" as const,
          }
          await db.backgroundTasks.update(runId, {
            ...storedPatch(owner, patch),
            ...(patch.settledAt !== undefined ? { interruptedAt: patch.settledAt } : {}),
            ...(unknownOwners.has(runId)
              ? {
                  error: "Background task ownership is unknown; automatic recovery is unavailable.",
                }
              : {}),
          })
        },
      },
      options
    )
    // The entries as stored: each flip also stamped when its host stopped.
    const stamped = interrupted.map((row) => ({
      ...row,
      interruptedAt: row.interruptedAt ?? row.settledAt,
    }))
    flipped = stamped
    return [
      ...stamped.filter((row) => row.host !== "renderer" || row.ownerLease),
      ...(options.recoverInterrupted
        ? rows.filter(
            (row) =>
              row.status === "interrupted" &&
              (row.host !== "renderer" || row.ownerLease !== undefined) &&
              row.recovery?.version === 1 &&
              !row.resumedByRunId &&
              row.cancelRequestedAt === undefined
          )
        : []),
    ]
  })
  if (flipped.length > 0) await options.onInterrupted?.(flipped)
  return result
}

/** Default retention for settled journal rows (age + cap; running rows never pruned). */
export const BACKGROUND_TASK_PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const BACKGROUND_TASK_PRUNE_MAX_ITEMS = 200

/**
 * Prune settled journal rows, modeled on `pruneNotifications`: drop rows whose
 * settle (or start, for settle-less rows) is older than `maxAgeMs`, then trim
 * to the newest `maxItems`. `running` rows are never pruned. Returns the
 * number of rows removed.
 */
export async function pruneBackgroundTaskRecords(opts: {
  now: number
  maxAgeMs?: number
  maxItems?: number
  host?: BackgroundTaskJournalRow["host"]
}): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? BACKGROUND_TASK_PRUNE_MAX_AGE_MS
  const maxItems = opts.maxItems ?? BACKGROUND_TASK_PRUNE_MAX_ITEMS
  const db = getDb()
  let removed = 0
  await db.transaction("rw", db.backgroundTasks, async () => {
    // Outbox facts only: this transaction spans `backgroundTasks` alone.
    const rows = await listStoredRows(opts.host)
    // A job entry inside the reconciliation window stays: dropping it would
    // let the next reconciliation write it again and deliver it twice.
    const settled = rows.filter(
      (row) =>
        !isUnsettled(row) &&
        !(
          isJobOutboxKind(row.kind) &&
          (row.settledAt ?? row.startedAt) > opts.now - JOB_RECONCILE_WINDOW_MS
        )
    )
    const doomed = new Set<string>()
    if (maxAgeMs > 0) {
      const cutoff = opts.now - maxAgeMs
      for (const row of settled) {
        if ((row.settledAt ?? row.startedAt) < cutoff) doomed.add(row.runId)
      }
    }
    if (maxItems > 0) {
      // listBackgroundTaskRecords sorts newest-first by startedAt.
      const survivors = settled.filter((row) => !doomed.has(row.runId))
      for (const row of survivors.slice(maxItems)) doomed.add(row.runId)
    }
    if (doomed.size > 0) {
      await db.backgroundTasks.bulkDelete([...doomed])
      removed = doomed.size
    }
  })
  return removed
}

/** Admission and child ownership commit together, before any provider work. */
export async function admitBackgroundDispatch(
  row: BackgroundTaskJournalRow,
  recoveryOf?: string,
  expectedRecoveryPhase?: BackgroundDispatchRecovery["phase"],
  options: LeaseOptions = {}
): Promise<{
  journal: BackgroundTaskJournalWriter
  markDispatched: () => Promise<void>
  requestCancel: () => Promise<void>
  renewLease: () => Promise<boolean>
}> {
  const db = getDb()
  const now = options.now ?? Date.now
  let lease: OwnerLease = {
    ownerId: options.ownerId ?? DEFAULT_OWNER_ID,
    epoch: 1,
    expiresAt: now() + BACKGROUND_TASK_LEASE_TTL_MS,
  }
  const recovery = row.recovery
  if (!recovery || db.name !== recovery.namespaceId)
    throw new Error("Background dispatch scope changed")
  await db.transaction("rw", db.backgroundTasks, db.sessions, async () => {
    if (getDb() !== db) throw new Error("Background dispatch scope changed")
    const parent = await db.sessions.get(row.sessionId)
    if (!parent) throw new Error("Background dispatch parent no longer exists")
    assertSessionWritable(parent, "continue-run")
    if (await db.backgroundTasks.get(row.runId)) throw new Error("Background run already exists")
    if (recoveryOf) {
      const prior = await db.backgroundTasks.get(recoveryOf)
      if (
        !prior ||
        !isInterrupted(prior) ||
        !prior.ownerLease ||
        prior.ownerLease.expiresAt > now() ||
        prior.resumedByRunId ||
        prior.cancelRequestedAt !== undefined ||
        prior.recovery?.phase !== expectedRecoveryPhase ||
        prior.recovery?.contextFingerprint !== recovery.contextFingerprint ||
        prior.recovery?.executionSessionId !== recovery.executionSessionId
      ) {
        throw new Error("Background recovery was already claimed or changed")
      }
      const child = await db.sessions.get(recovery.executionSessionId)
      if (
        !child ||
        child.parentSessionId !== row.sessionId ||
        child.attachedChild?.status === "closed"
      ) {
        throw new Error("Background child session no longer exists")
      }
      assertSessionWritable(child, "continue-run")
      lease = { ...lease, epoch: prior.ownerLease.epoch + 1 }
      await db.backgroundTasks.update(recoveryOf, { resumedByRunId: row.runId })
    } else {
      // Explicit hidden child ownership reuses the attached-session deletion cascade.
      await db.sessions.add({
        id: recovery.executionSessionId,
        title: row.label ?? row.subagentId,
        programmaticCreator: "background-task",
        kind: "subagent",
        visibility: "embedded",
        parentSessionId: parent.id,
        projectId: parent.projectId,
        workingDir: recovery.caller.cwd,
        createdAt: row.startedAt,
        updatedAt: row.startedAt,
        attachedChild: {
          parentSessionId: parent.id,
          lifecycleOwnerSessionId: parent.id,
          context: { mode: "none" },
          workspace: "shared",
          status: "staged",
          createdAt: row.startedAt,
        },
      })
    }
    await db.backgroundTasks.add({ ...storedRow(row, row), ownerLease: lease })
  })
  const assertScope = () => {
    if (getDb() !== db) throw new Error("Background dispatch scope changed")
  }
  const renewLease = async () => {
    if (getDb() !== db) return false
    return db.transaction("rw", db.backgroundTasks, async () => {
      if (getDb() !== db) return false
      const current = await db.backgroundTasks.get(row.runId)
      if (getDb() !== db) return false
      const at = now()
      if (!ownsRunningTask(current, lease, at) || current?.cancelRequestedAt !== undefined)
        return false
      await db.backgroundTasks.update(row.runId, {
        ownerLease: { ...lease, expiresAt: at + BACKGROUND_TASK_LEASE_TTL_MS },
      })
      return true
    })
  }
  return {
    renewLease,
    journal: {
      leaseIntervalMs: BACKGROUND_TASK_LEASE_TTL_MS / 3,
      renewLease: async (runId) => runId === row.runId && renewLease(),
      recordStart: () => {
        throw new Error("Background admission already committed")
      },
      async recordSettle(runId, patch) {
        assertScope()
        await db.transaction("rw", db.backgroundTasks, db.sessions, async () => {
          assertScope()
          const current = await db.backgroundTasks.get(runId)
          assertScope()
          if (runId !== row.runId || !current || !ownsRunningTask(current, lease, now()))
            throw new Error("Background run no longer active")
          await db.backgroundTasks.update(runId, terminalPatch(current, patch))
          const child = await db.sessions.get(recovery.executionSessionId)
          if (child?.attachedChild && child.attachedChild.status !== "closed") {
            await db.sessions.update(child.id, {
              attachedChild: {
                ...child.attachedChild,
                status: patch.status === "done" ? "completed" : "interrupted",
                updatedAt: patch.settledAt,
              },
            })
          }
        })
        assertScope()
      },
    },
    async requestCancel() {
      assertScope()
      await db.transaction("rw", db.backgroundTasks, async () => {
        assertScope()
        const current = await db.backgroundTasks.get(row.runId)
        assertScope()
        if (!current || !ownsRunningTask(current, lease, now()))
          throw new Error("Background run no longer active")
        await db.backgroundTasks.update(row.runId, {
          cancelRequestedAt: current.cancelRequestedAt ?? now(),
        })
      })
      assertScope()
    },
    async markDispatched() {
      assertScope()
      await db.transaction("rw", db.backgroundTasks, db.sessions, async () => {
        assertScope()
        const current = await db.backgroundTasks.get(row.runId)
        const parent = await db.sessions.get(row.sessionId)
        const child = await db.sessions.get(recovery.executionSessionId)
        assertScope()
        assertSessionWritable(parent, "continue-run")
        assertSessionWritable(child, "continue-run")
        if (
          !parent ||
          !child ||
          child.attachedChild?.status === "closed" ||
          !current ||
          !ownsRunningTask(current, lease, now()) ||
          current.cancelRequestedAt !== undefined ||
          current.recovery?.phase !== "accepted"
        ) {
          throw new Error("Background admission is no longer executable")
        }
        await db.backgroundTasks.update(row.runId, {
          recovery: { ...recovery, phase: "dispatched" } satisfies BackgroundDispatchRecovery,
        })
        if (child.attachedChild)
          await db.sessions.update(child.id, {
            attachedChild: { ...child.attachedChild, status: "running", updatedAt: now() },
          })
      })
      assertScope()
    },
  }
}

/** Keep a pending batch's identity stable across reload and newly arriving results. */
export async function reserveBackgroundTaskDelivery(
  sessionId: string,
  runIds: string[],
  deliveryId: string
): Promise<{ deliveryId: string; runIds: string[] } | null> {
  const db = getDb()
  return db.transaction("rw", db.backgroundTasks, async () => {
    const rows = (await db.backgroundTasks.bulkGet(runIds)).filter(
      (row): row is BackgroundTaskJournalRow =>
        Boolean(
          row &&
          row.sessionId === sessionId &&
          row.host === "renderer" &&
          (row.kind === "subagent" || isJobOutboxKind(row.kind)) &&
          row.deliveryState === "pending" &&
          !isUnsettled(row) &&
          !isInterrupted(row)
        )
    )
    const existingId = rows.find((row) => row.deliveryId)?.deliveryId
    const batch = existingId ? rows.filter((row) => row.deliveryId === existingId) : rows
    if (batch.length === 0) return null
    const id = existingId ?? deliveryId
    if (!existingId) {
      await Promise.all(
        batch.map((row) => db.backgroundTasks.update(row.runId, { deliveryId: id }))
      )
    }
    return { deliveryId: id, runIds: batch.map((row) => row.runId) }
  })
}
