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
 * The row carries ids and numbers only, never message content. Its write is
 * idempotent on `messageId`, so a retry that races a later booking of the same
 * reply overwrites one row.
 */

import type { SessionUsageRow } from "@/lib/db/session-usage"
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
}

export interface UsageWriteOutboxDeps {
  commit(row: SessionUsageRow): Promise<void>
  store: UsageWriteOutboxStore
  now(): number
  setTimer(callback: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  log(level: "warn" | "error", message: string): void
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

export function createUsageWriteOutbox(deps: UsageWriteOutboxDeps): UsageWriteOutbox {
  const held = new Map<string, SessionUsageRow>()
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

  const retryHeld = async () => {
    for (const [id, row] of [...held]) {
      try {
        await deps.commit(row)
        held.delete(id)
      } catch (error) {
        await park(row, error)
      }
    }
  }

  const runDrain = async (everything: boolean) => {
    await retryHeld()
    let rows: UsageWriteOutboxRow[]
    try {
      rows = everything ? await deps.store.all() : await deps.store.due(deps.now())
    } catch (error) {
      deps.log("error", `usage outbox could not be read: ${String(error)}`)
      arm(deps.now() + USAGE_OUTBOX_HELD_RETRY_MS)
      return
    }
    for (const kept of rows) {
      if (stopped) return
      try {
        await deps.commit(kept.row)
      } catch (error) {
        await park(kept.row, error, everything ? { ...kept, attempts: 0 } : kept)
        continue
      }
      try {
        await deps.store.delete(kept.id)
      } catch (error) {
        // Written; a later drain rewrites the same row, which is idempotent.
        deps.log("warn", `usage outbox row ${kept.id} written but not cleared: ${String(error)}`)
      }
    }
    if (held.size > 0) arm(deps.now() + USAGE_OUTBOX_HELD_RETRY_MS)
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
    async book(row) {
      try {
        await deps.commit(row)
        return
      } catch (error) {
        let prior: UsageWriteOutboxRow | undefined
        try {
          prior = await deps.store.get(row.messageId)
        } catch {
          // The put below reports the store's state.
        }
        await park(row, error, prior)
      }
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

/** The account database's outbox table, behind the reopen retry every writer uses. */
export function dexieUsageWriteOutboxStore(): UsageWriteOutboxStore {
  const run = async <T>(work: (db: import("@/lib/db/schema").CogniaDB) => Promise<T>) => {
    const { getDb, withDbReopenRetry } = await import("@/lib/db/schema")
    return withDbReopenRetry(() => work(getDb()))
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
  }
}

let installed: UsageWriteOutbox | null = null

function defaultOutbox(): UsageWriteOutbox {
  installed ??= createUsageWriteOutbox({
    commit: async (row) => {
      const { upsertSessionUsage } = await import("@/lib/db/session-usage")
      await upsertSessionUsage(row)
    },
    store: dexieUsageWriteOutboxStore(),
    now: Date.now,
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (level, message) => console[level](`[usage-outbox] ${message}`),
  })
  return installed
}

/** Book one usage row through this process's outbox. Never throws. */
export function bookUsageRow(row: SessionUsageRow): Promise<void> {
  return defaultOutbox().book(row)
}

let starts = 0

/**
 * Retry every row kept by an earlier run of this process, then keep retrying
 * on the outbox's own timer. Each writer of Host-run usage starts it; the
 * timer stops when the last of them stops.
 */
export function startUsageWriteOutbox(): () => void {
  const outbox = defaultOutbox()
  starts += 1
  void outbox.drain({ everything: true })
  let released = false
  return () => {
    if (released) return
    released = true
    starts -= 1
    if (starts > 0) return
    outbox.stop()
    if (installed === outbox) installed = null
  }
}
