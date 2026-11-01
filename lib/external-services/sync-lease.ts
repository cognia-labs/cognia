import type { Table } from "dexie"
import {
  claimSyncLease,
  commitSyncLease,
  renewSyncLease,
  releaseSyncLease,
  releaseConnectionSyncLeases,
  SyncLeaseLost,
  type SyncLeaseRow,
} from "@/lib/db/sync-leases"

const runtimeOwnerId = crypto.randomUUID()
const DEFAULT_TTL_MS = 30_000
const active = new Map<string, Set<AbortController>>()

/** Host-only. P8 sync tasks must use commit for cursors and heed signal on loss. */
export interface SyncLease {
  readonly row: SyncLeaseRow
  readonly signal: AbortSignal
  renew(): Promise<boolean>
  release(): Promise<void>
  commit<T>(tables: readonly Table[], task: () => Promise<T>): Promise<T>
}

export async function acquireSyncLease(
  ref: string,
  duty: string,
  { ttlMs = DEFAULT_TTL_MS }: { ttlMs?: number } = {}
): Promise<SyncLease | null> {
  const row = await claimSyncLease(ref, duty, runtimeOwnerId, ttlMs)
  if (!row) return null
  const controller = new AbortController()
  const controllers = active.get(ref) ?? new Set<AbortController>()
  controllers.add(controller)
  active.set(ref, controllers)
  const lost = () => controller.abort(new SyncLeaseLost())
  return {
    row,
    signal: controller.signal,
    async renew() {
      if (controller.signal.aborted) return false
      try {
        const renewed = await renewSyncLease(row, ttlMs)
        if (!renewed) lost()
        return renewed
      } catch (error) {
        lost()
        throw error
      }
    },
    async release() {
      lost()
      controllers.delete(controller)
      if (!controllers.size) active.delete(ref)
      await releaseSyncLease(row)
    },
    async commit(tables, task) {
      if (controller.signal.aborted) throw new SyncLeaseLost()
      try {
        return await commitSyncLease(row, tables, task)
      } catch (error) {
        if (error instanceof SyncLeaseLost) lost()
        throw error
      }
    },
  }
}

export async function withSyncLease<T>(
  ref: string,
  duty: string,
  task: (lease: SyncLease) => Promise<T>,
  options: { ttlMs?: number } = {}
): Promise<T | null> {
  const lease = await acquireSyncLease(ref, duty, options)
  if (!lease) return null
  let renewing = false
  const timer = setInterval(
    () => {
      if (renewing || lease.signal.aborted) return
      renewing = true
      void lease
        .renew()
        .catch(() => undefined)
        .finally(() => {
          renewing = false
        })
    },
    Math.max(1, (options.ttlMs ?? DEFAULT_TTL_MS) / 3)
  )
  try {
    const result = await task(lease)
    await lease.commit([], async () => undefined)
    return result
  } finally {
    clearInterval(timer)
    await lease.release()
  }
}

/** Deleting tokens fences other runtimes' writes; local tasks abort immediately. */
export async function fenceConnectionSyncLeases(ref: string): Promise<void> {
  for (const controller of active.get(ref) ?? []) controller.abort(new SyncLeaseLost())
  await releaseConnectionSyncLeases(ref)
}
