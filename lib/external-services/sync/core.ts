import type { Table } from "dexie"
import { getDb } from "@/lib/db/schema"
import {
  deleteExternalSyncSeen,
  getExternalSyncSeen,
  type ExternalSyncCursorRow,
  type ExternalSyncGeneration,
} from "@/lib/db/external-sync"
import { SyncLeaseLost } from "@/lib/db/sync-leases"
import { NamedLockUnavailable, withNamedLock } from "@/lib/locks/named-lock"
import { acquireSyncLease, type SyncLease } from "../sync-lease"
import {
  ExternalSyncCursorInvalid,
  ExternalSyncRateLimited,
  type ExternalSyncDriver,
  type ExternalSyncMode,
  type ExternalSyncOptions,
  type ExternalSyncOutcome,
  type ExternalSyncTarget,
} from "./types"

class SyncProtocolError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** A purged or replaced target must never be resurrected by a stale run. */
class ExternalSyncTargetRemoved extends Error {}

const activeRuns = new Map<string, Set<AbortController>>()
export function abortExternalSyncRuns(key: string): void {
  for (const controller of activeRuns.get(key) ?? []) controller.abort()
}

/** Same bounded retry curve for sync failures and subscription renewal. */
export function externalSyncBackoff(failures: number, random: () => number = Math.random): number {
  return Math.round(
    Math.min(30_000 * 2 ** Math.min(30, failures - 1), 30 * 60_000) * (0.9 + 0.2 * random())
  )
}

export async function runExternalSync<Item>(
  target: ExternalSyncTarget,
  driver: ExternalSyncDriver<Item>,
  options: ExternalSyncOptions = {}
): Promise<ExternalSyncOutcome> {
  const db = getDb()
  const now = options.now ?? Date.now
  let mode: ExternalSyncMode = "full"
  let generation: ExternalSyncGeneration | undefined
  let tombstoned = 0
  const outcome = (
    status: ExternalSyncOutcome["status"],
    errorCode?: string
  ): ExternalSyncOutcome => ({
    status,
    mode,
    pages: generation?.pages ?? 0,
    applied: generation?.applied ?? 0,
    tombstoned,
    ...(errorCode ? { errorCode } : {}),
  })
  const initial = await db.externalSyncCursors.get(target.key)
  const matchesTarget = (row: ExternalSyncCursorRow) =>
    row.owner === target.owner && row.connectionRef === target.connectionRef
  const updateCursor = async (patch: Partial<ExternalSyncCursorRow>) => {
    if (!(await db.externalSyncCursors.update(target.key, patch)))
      throw new ExternalSyncTargetRemoved()
  }
  const selectMode = (row?: ExternalSyncCursorRow): ExternalSyncMode =>
    options.mode === "full" || driver.fullScanOnly || !row?.cursor || row.invalidated
      ? "full"
      : "incremental"
  mode = selectMode(initial)
  if (options.signal?.aborted) return outcome("cancelled")
  if (
    (options.isOffline ?? (() => typeof navigator !== "undefined" && navigator.onLine === false))()
  ) {
    try {
      await db.transaction("rw", db.externalSyncCursors, async () => {
        const row = await db.externalSyncCursors.get(target.key)
        if (
          (initial && !row) ||
          (row && (!matchesTarget(row) || row.generation?.id !== initial?.generation?.id))
        )
          throw new ExternalSyncTargetRemoved()
        options.signal?.throwIfAborted()
        if (row) await updateCursor({ deferredOffline: true })
        else await db.externalSyncCursors.add({ ...target, failures: 0, deferredOffline: true })
        options.signal?.throwIfAborted()
      })
    } catch (error) {
      if (error instanceof ExternalSyncTargetRemoved || options.signal?.aborted)
        return outcome("cancelled")
      throw error
    }
    return outcome("deferred-offline")
  }

  const run = async (
    lease?: SyncLease,
    assertHeld: () => void = () => {}
  ): Promise<ExternalSyncOutcome> => {
    const controller = new AbortController()
    const controllers = activeRuns.get(target.key) ?? new Set<AbortController>()
    controllers.add(controller)
    activeRuns.set(target.key, controllers)
    const abort = () => controller.abort()
    for (const signal of [options.signal, lease?.signal]) {
      if (signal?.aborted) abort()
      signal?.addEventListener("abort", abort, { once: true })
    }
    const signal = controller.signal
    const check = () => {
      signal.throwIfAborted()
      assertHeld()
    }
    const tables: Table[] = [db.externalSyncCursors, db.externalSyncSeen]
    let persisted = initial !== undefined
    let expectedGeneration = initial?.generation?.id
    const assertTarget = async (allowCreate = false) => {
      check()
      const current = await db.externalSyncCursors.get(target.key)
      check()
      if (
        (!current && !allowCreate) ||
        (current && (!matchesTarget(current) || current.generation?.id !== expectedGeneration))
      )
        throw new ExternalSyncTargetRemoved()
    }
    const commit = async <T>(task: () => Promise<T>, allowCreate = false): Promise<T> => {
      check()
      const guarded = async () => {
        // The existence, target identity and generation fence share the write transaction.
        await assertTarget(allowCreate)
        const result = await task()
        check()
        return result
      }
      return lease ? lease.commit(tables, guarded) : db.transaction("rw", tables, guarded)
    }
    let renewing = false
    const timer = lease
      ? setInterval(() => {
          if (renewing || signal.aborted) return
          renewing = true
          void lease
            .renew()
            .then((held) => {
              if (!held) abort()
            }, abort)
            .finally(() => {
              renewing = false
            })
        }, 10_000)
      : undefined
    try {
      const current = await db.externalSyncCursors.get(target.key)
      if ((persisted && !current) || (current && !matchesTarget(current)))
        throw new ExternalSyncTargetRemoved()
      let row = current ?? { ...target, failures: 0 }
      persisted = current !== undefined
      expectedGeneration = row.generation?.id
      mode = selectMode(row)
      generation = row.generation
      if (options.mode !== "full" && row.backoffUntil !== undefined && now() < row.backoffUntil)
        return outcome("backoff", row.lastErrorCode)
      let invalidations = 0
      while (true) {
        if (!generation || generation.mode !== mode) {
          const previous = generation
          generation = { id: crypto.randomUUID(), mode, startedAt: now(), pages: 0, applied: 0 }
          const next = generation
          await commit(async () => {
            if (previous) await deleteExternalSyncSeen(target.key, previous.id)
            if (await db.externalSyncCursors.get(target.key))
              await updateCursor({ generation: next })
            else await db.externalSyncCursors.add({ ...row, generation: next })
          }, !persisted)
          persisted = true
          expectedGeneration = next.id
        }
        const pending = generation
        const pageTokens = new Set(pending.pageTokens ?? (pending.page ? [pending.page] : []))
        while (pending.terminalCursor === undefined) {
          await assertTarget()
          let page
          try {
            page = await driver.fetchPage({
              mode,
              cursor: mode === "incremental" ? row.cursor : undefined,
              page: pending.page,
              signal,
            })
          } catch (error) {
            if (!(error instanceof ExternalSyncCursorInvalid)) throw error
            await commit(async () => {
              await deleteExternalSyncSeen(target.key, pending.id)
              await updateCursor({
                cursor: undefined,
                generation: undefined,
                invalidated: true,
              })
            })
            row = { ...row, cursor: undefined, generation: undefined, invalidated: true }
            generation = undefined
            expectedGeneration = undefined
            if (invalidations++ > 0) throw new SyncProtocolError("cursor-invalid")
            mode = "full"
            break
          }
          await assertTarget()
          if (page.nextPage !== undefined && pageTokens.has(page.nextPage))
            throw new SyncProtocolError("page-cursor-repeated")
          if (page.nextPage === undefined && !page.cursor)
            throw new SyncProtocolError("terminal-cursor-missing")
          const items = [...new Map(page.items.map((item) => [driver.itemId(item), item])).values()]
          await driver.applyPage(
            { items, deleted: [...new Set(page.deleted ?? [])] },
            { mode, generation: pending.id, signal }
          )
          check()
          const checkpoint: ExternalSyncGeneration = {
            ...pending,
            page: page.nextPage,
            pages: pending.pages + 1,
            applied: pending.applied + items.length,
            pageTokens: [...pageTokens, ...(page.nextPage !== undefined ? [page.nextPage] : [])],
            ...(page.nextPage === undefined ? { terminalCursor: page.cursor } : {}),
          }
          await commit(async () => {
            if (mode === "full" && items.length)
              await db.externalSyncSeen.bulkPut(
                items.map((item) => ({
                  key: target.key,
                  generation: pending.id,
                  itemId: driver.itemId(item),
                }))
              )
            await updateCursor({ generation: checkpoint })
          })
          Object.assign(pending, checkpoint)
          if (page.nextPage !== undefined) pageTokens.add(page.nextPage)
        }
        if (!generation) continue
        await assertTarget()
        if (mode === "full" && driver.listKnownIds && driver.tombstone) {
          const known = await driver.listKnownIds(signal)
          check()
          const seen = await getExternalSyncSeen(target.key, pending.id)
          await assertTarget()
          const unseen = [...new Set(known)].filter((id) => !seen.has(id))
          if (unseen.length) await driver.tombstone(unseen, { generation: pending.id, signal })
          check()
          tombstoned = unseen.length
        }
        await driver.complete?.({ signal })
        await assertTarget()
        await commit(async () => {
          await updateCursor({
            cursor: pending.terminalCursor,
            committedAt: now(),
            lastSuccessAt: now(),
            generation: undefined,
            invalidated: undefined,
            failures: 0,
            backoffUntil: undefined,
            lastErrorCode: undefined,
            deferredOffline: undefined,
          })
          await deleteExternalSyncSeen(target.key, pending.id)
        })
        return outcome("completed")
      }
    } catch (error) {
      if (
        signal.aborted ||
        error instanceof ExternalSyncTargetRemoved ||
        error instanceof SyncLeaseLost ||
        (error instanceof Error && error.name === "AbortError")
      )
        return outcome("cancelled")
      const code =
        error instanceof ExternalSyncRateLimited
          ? "rate-limited"
          : error instanceof SyncProtocolError
            ? error.code
            : "sync-failed"
      try {
        await commit(async () => {
          const current = await db.externalSyncCursors.get(target.key)
          if (!current) throw new ExternalSyncTargetRemoved()
          const failures = current.failures + 1
          const retry =
            error instanceof ExternalSyncRateLimited
              ? Math.max(
                  1000,
                  Math.min(
                    3_600_000,
                    Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 1000
                  )
                )
              : externalSyncBackoff(failures, options.random)
          await updateCursor({
            failures,
            backoffUntil: now() + retry,
            lastErrorCode: code,
          })
        })
      } catch (commitError) {
        if (
          signal.aborted ||
          commitError instanceof SyncLeaseLost ||
          commitError instanceof ExternalSyncTargetRemoved
        )
          return outcome("cancelled")
        // Storage failure cannot authorize advancing the cursor.
      }
      return outcome(error instanceof ExternalSyncRateLimited ? "backoff" : "failed", code)
    } finally {
      clearInterval(timer)
      controllers.delete(controller)
      if (!controllers.size) activeRuns.delete(target.key)
      for (const input of [options.signal, lease?.signal])
        input?.removeEventListener("abort", abort)
    }
  }

  if (target.connectionRef) {
    const lease = await acquireSyncLease(target.connectionRef, `sync:${target.key}`)
    if (!lease) return outcome("busy")
    try {
      return await run(lease)
    } finally {
      await lease.release()
    }
  }
  try {
    return await withNamedLock(
      `cognia-external-sync:${target.key}`,
      (held) => run(undefined, held),
      {
        ifAvailable: true,
        ...(typeof window === "undefined" ? { mode: "in-process" as const } : {}),
      }
    )
  } catch (error) {
    if (error instanceof NamedLockUnavailable) return outcome("busy")
    throw error
  }
}
