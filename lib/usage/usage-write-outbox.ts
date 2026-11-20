/**
 * Usage rows whose write failed, kept until they are written (ADR-0253 §10).
 *
 * A Host-run turn (a member's turn on an organization Host, a paired device's
 * turn on its Host) is booked by no chat view: the brain writes its usage row
 * itself, once, when the turn ends. A failed write used to be logged and
 * dropped, so the spend was recorded nowhere. Here it is parked instead:
 *
 * - {@link bookUsageRow} commits the row. Only when that fails is the row
 *   stored in `usageWriteOutbox`, with the shared retry curve
 *   (`decideNextAttempt`), and retried on a timer.
 * - A row that runs out of attempts is kept as `deadlettered`, never deleted;
 *   every start of the outbox ({@link startUsageWriteOutbox}) retries all kept
 *   rows, dead-lettered ones included.
 * - If even the outbox write fails, the row is held in memory and retried with
 *   the others for as long as the process lives.
 *
 * The row carries ids and numbers only, never message content. Writes of one
 * `messageId` are serialized, and a version written directly retires the one
 * parked before it, so a retry never puts an older figure back over a newer
 * one. Each outbox belongs to one account database: a write is never booked
 * into, nor kept in, an account other than the one the row was booked for.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
import { activeDatabaseName, getDb, withDbReopenRetry, type CogniaDB } from "@/lib/db/schema"
import { decideNextAttempt } from "@/lib/queue/retry-policy"

export interface UsageWriteOutboxRow {
  /** The usage row's `messageId`. */
  id: string
  row: SessionUsageRow
  state: "pending" | "deadlettered"
  attempts: number
  nextAttemptAt: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export interface UsageWriteOutboxStore {
  put(row: UsageWriteOutboxRow): Promise<void>
  get(id: string): Promise<UsageWriteOutboxRow | undefined>
  delete(id: string): Promise<void>
  /** Pending rows due at `now`. */
  due(now: number): Promise<UsageWriteOutboxRow[]>
  /** Every kept row, dead-lettered ones included. */
  all(): Promise<UsageWriteOutboxRow[]>
  /** When the earliest pending row is due, or `undefined` when none is. */
  nextPendingAt(): Promise<number | undefined>
}

export interface UsageWriteOutboxDeps {
  commit(row: SessionUsageRow): Promise<void>
  store: UsageWriteOutboxStore
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(level: "warn" | "error", message: string): void
  /**
   * True when a failure says another account database is active now. The
   * write is then neither retried nor kept here: the row belongs to the
   * account it was booked for, and waits for that account's next start.
   */
  isForeignDatabase?(error: unknown): boolean
}

export interface UsageWriteOutbox {
  /** Write the row now, or keep it until it is written. Never throws. */
  book(row: SessionUsageRow): Promise<void>
  /** Retry what is due; with `everything`, every kept row. */
  drain(options?: { everything?: boolean }): Promise<void>
  /** Rows held in memory because the outbox itself could not keep them. */
  heldCount(): number
  stop(): void
}

/** How soon a row only held in memory is tried again. */
export const USAGE_OUTBOX_HELD_RETRY_MS = 30_000

const foreignDatabase = (error: unknown) =>
  error instanceof Error && error.name === "UsageLedgerDatabaseChangedError"

export function createUsageWriteOutbox(deps: UsageWriteOutboxDeps): UsageWriteOutbox {
  const held = new Map<string, SessionUsageRow>()
  const isForeign = deps.isForeignDatabase ?? foreignDatabase
  // One write of a given id at a time: a direct booking and a retry of an
  // older version must not race, or whichever lands last wins.
  const locks = new Map<string, Promise<unknown>>()
  const exclusive = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.then(work, work)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    locks.set(id, settled)
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id)
    })
    return next
  }
  let timer: unknown
  let timerAt = Number.POSITIVE_INFINITY
  let draining: Promise<void> | null = null
  let stopped = false

  const arm = (at: number) => {
    if (stopped || at >= timerAt) return
    if (timer !== undefined) deps.clearTimer(timer)
    timerAt = at
    timer = deps.setTimer(
      () => {
        timer = undefined
        timerAt = Number.POSITIVE_INFINITY
        void drain()
      },
      Math.max(0, at - deps.now())
    )
  }

  /** Arm for the earliest row still pending, so no kept row waits for a start. */
  const armForPending = async () => {
    try {
      const at = await deps.store.nextPendingAt()
      if (at !== undefined) arm(at)
    } catch (error) {
      if (isForeign(error)) return
      arm(deps.now() + USAGE_OUTBOX_HELD_RETRY_MS)
    }
  }

  const park = async (row: SessionUsageRow, error: unknown, prior?: UsageWriteOutboxRow) => {
    const now = deps.now()
    // Any failure is worth retrying: the row itself was valid when it was
    // built, so a refusal can only be the store's state at that moment.
    const decision = decideNextAttempt({
      attempts: prior?.attempts ?? 0,
      error,
      nowMs: now,
      forceRetryable: true,
    })
    const record: UsageWriteOutboxRow = {
      id: row.messageId,
      row,
      state: decision.status,
      attempts: decision.attempts,
      nextAttemptAt: decision.nextAttemptAt,
      lastError: decision.lastError,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    }
    try {
      await deps.store.put(record)
      held.delete(row.messageId)
    } catch (storeError) {
      held.set(row.messageId, row)
      deps.log(
        "error",
        `usage row ${row.messageId} could not be written or kept; retrying in memory: ${String(storeError)}`
      )
      arm(now + USAGE_OUTBOX_HELD_RETRY_MS)
      return
    }
    if (decision.status === "deadlettered") {
      deps.log(
        "error",
        `usage row ${row.messageId} kept after ${decision.attempts} failed writes; retried at the next start: ${decision.lastError}`
      )
      return
    }
    deps.log(
      "warn",
      `usage row ${row.messageId} write failed; kept for retry: ${decision.lastError}`
    )
    arm(decision.nextAttemptAt)
  }

  /** The id's write landed: an older version kept for it is superseded. */
  const retireKept = async (id: string) => {
    held.delete(id)
    try {
      await deps.store.delete(id)
    } catch (error) {
      deps.log("warn", `usage outbox row ${id} written but not cleared: ${String(error)}`)
    }
  }

  const retryHeld = async (): Promise<boolean> => {
    for (const [id, row] of [...held]) {
      const outcome = await exclusive(id, async () => {
        if (held.get(id) !== row) return "superseded" as const
        try {
          await deps.commit(row)
        } catch (error) {
          if (isForeign(error)) return "foreign" as const
          await park(row, error)
          return "parked" as const
        }
        await retireKept(id)
        return "written" as const
      })
      if (outcome === "foreign") return false
    }
    return true
  }

  const runDrain = async (everything: boolean) => {
    if (!(await retryHeld())) return
    let rows: UsageWriteOutboxRow[]
    try {
      rows = everything ? await deps.store.all() : await deps.store.due(deps.now())
    } catch (error) {
      if (isForeign(error)) return
      deps.log("error", `usage outbox could not be read: ${String(error)}`)
      arm(deps.now() + USAGE_OUTBOX_HELD_RETRY_MS)
      return
    }
    for (const kept of rows) {
      if (stopped) return
      const outcome = await exclusive(kept.id, async () => {
        // Re-read under the lock: a direct booking may have written a newer
        // version (and retired this one) or parked one over it since the read.
        let current: UsageWriteOutboxRow | undefined
        try {
          current = await deps.store.get(kept.id)
        } catch (error) {
          return isForeign(error) ? ("foreign" as const) : ("skipped" as const)
        }
        if (!current || current.updatedAt !== kept.updatedAt) return "skipped" as const
        try {
          await deps.commit(current.row)
        } catch (error) {
          if (isForeign(error)) return "foreign" as const
          await park(current.row, error, everything ? { ...current, attempts: 0 } : current)
          return "parked" as const
        }
        await retireKept(current.id)
        return "written" as const
      })
      if (outcome === "foreign") return
    }
    if (held.size > 0) arm(deps.now() + USAGE_OUTBOX_HELD_RETRY_MS)
    await armForPending()
  }

  const drain = (options: { everything?: boolean } = {}): Promise<void> => {
    if (stopped) return Promise.resolve()
    const previous = draining ?? Promise.resolve()
    const next = previous.then(() => runDrain(options.everything === true))
    draining = next.finally(() => {
      if (draining === next) draining = null
    })
    return next
  }

  return {
    book(row) {
      return exclusive(row.messageId, async () => {
        try {
          await deps.commit(row)
        } catch (error) {
          if (isForeign(error)) {
            // Booked for an account no longer active: it cannot be written
            // or kept there now, so it waits in memory for that account.
            held.set(row.messageId, row)
            deps.log("warn", `usage row ${row.messageId} held: its account database is not active`)
            return
          }
          let prior: UsageWriteOutboxRow | undefined
          try {
            prior = await deps.store.get(row.messageId)
          } catch {
            // The put below reports the store's state.
          }
          await park(row, error, prior)
          return
        }
        // Written: anything kept for this id is an older version, and a
        // retry of it would put the older figure back over this one.
        if (held.has(row.messageId)) held.delete(row.messageId)
        let kept: UsageWriteOutboxRow | undefined
        try {
          kept = await deps.store.get(row.messageId)
        } catch {
          kept = undefined
        }
        if (kept) await retireKept(row.messageId)
      })
    },
    drain,
    heldCount: () => held.size,
    stop() {
      stopped = true
      if (timer !== undefined) deps.clearTimer(timer)
      timer = undefined
      timerAt = Number.POSITIVE_INFINITY
    },
  }
}

/**
 * One account database's outbox table, behind the reopen retry every writer
 * uses. Every operation first checks that `databaseName` is still the active
 * database: an outbox never reads or writes another account's table.
 */
export function dexieUsageWriteOutboxStore(databaseName: string): UsageWriteOutboxStore {
  const run = async <T>(work: (db: CogniaDB) => Promise<T>) => {
    const { UsageLedgerDatabaseChangedError } = await import("./usage-ledger")
    return withDbReopenRetry(() => {
      const db = getDb()
      if (db.name !== databaseName) throw new UsageLedgerDatabaseChangedError(databaseName, db.name)
      return work(db)
    })
  }
  return {
    put: (row) => run(async (db) => void (await db.usageWriteOutbox.put(row))),
    get: (id) => run((db) => db.usageWriteOutbox.get(id)),
    delete: (id) => run((db) => db.usageWriteOutbox.delete(id)),
    due: (now) =>
      run((db) =>
        db.usageWriteOutbox
          .where("nextAttemptAt")
          .belowOrEqual(now)
          .filter((row) => row.state === "pending")
          .toArray()
      ),
    all: () => run((db) => db.usageWriteOutbox.toArray()),
    nextPendingAt: () =>
      run(async (db) => {
        const first = await db.usageWriteOutbox
          .orderBy("nextAttemptAt")
          .filter((row) => row.state === "pending")
          .first()
        return first?.nextAttemptAt
      }),
  }
}

/** This process's outbox for each account database it booked usage into. */
const outboxes = new Map<string, UsageWriteOutbox>()

function outboxFor(databaseName: string): UsageWriteOutbox {
  let outbox = outboxes.get(databaseName)
  if (!outbox) {
    outbox = createUsageWriteOutbox({
      commit: async (row) => {
        const { commitUsageRow } = await import("./usage-ledger")
        await commitUsageRow(row, { expectDatabase: databaseName })
      },
      store: dexieUsageWriteOutboxStore(databaseName),
      now: Date.now,
      setTimer: (callback, ms) => {
        const handle = setTimeout(callback, ms)
        ;(handle as { unref?: () => void }).unref?.()
        return handle
      },
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      log: (level, message) => console[level](`[usage-outbox] ${message}`),
    })
    outboxes.set(databaseName, outbox)
  }
  return outbox
}

/**
 * Book one usage row through this process's outbox for the account database
 * active now, the one the row belongs to. Never throws.
 */
export function bookUsageRow(row: SessionUsageRow): Promise<void> {
  return outboxFor(activeDatabaseName()).book(row)
}

const starts = new Map<string, number>()

/**
 * Retry every row kept by an earlier run of this process in the active
 * account database, then keep retrying on the outbox's own timer. Each writer
 * of Host-run usage starts it; the timer stops when the last of them stops.
 */
export function startUsageWriteOutbox(): () => void {
  const databaseName = activeDatabaseName()
  const outbox = outboxFor(databaseName)
  starts.set(databaseName, (starts.get(databaseName) ?? 0) + 1)
  void outbox.drain({ everything: true })
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (starts.get(databaseName) ?? 1) - 1
    if (left > 0) {
      starts.set(databaseName, left)
      return
    }
    starts.delete(databaseName)
    outbox.stop()
    if (outboxes.get(databaseName) === outbox) outboxes.delete(databaseName)
  }
}
