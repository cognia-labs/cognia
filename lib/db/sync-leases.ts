import type { Table } from "dexie"
import { getDb } from "./schema"

/** Device-local Host ownership; P8's sync/cursor contract reuses this fence. */
export interface SyncLeaseRow {
  key: string
  connectionRef: string
  ownerId: string
  token: string
  expiresAt: number
  heartbeatAt: number
}

export class SyncLeaseLost extends Error {
  constructor() {
    super("Connection sync lease is no longer held")
    this.name = "SyncLeaseLost"
  }
}

async function connectionAvailable(ref: string): Promise<boolean> {
  const db = getDb()
  if ((await db.authConnections.get(ref))?.status !== "connected") return false
  return !(await db.integrationAudit
    .where("kind")
    .equals("access.cleanup.pending")
    .filter((row) => (row.detail?.target as { ref?: string } | undefined)?.ref === ref)
    .count())
}

export async function sweepExpiredSyncLeases(now = Date.now()): Promise<number> {
  return getDb().syncLeases.where("expiresAt").belowOrEqual(now).delete()
}

export async function claimSyncLease(
  connectionRef: string,
  duty: string,
  ownerId: string,
  ttlMs: number,
  now = Date.now()
): Promise<SyncLeaseRow | null> {
  if (!duty || !Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new Error("Invalid sync lease duty or TTL")
  const db = getDb()
  return db.transaction("rw", db.syncLeases, db.authConnections, db.integrationAudit, async () => {
    await sweepExpiredSyncLeases(now)
    const key = `${connectionRef}:${duty}`
    // Even this owner must not start a second task while its first task lives.
    if ((await db.syncLeases.get(key)) || !(await connectionAvailable(connectionRef))) return null
    const row = {
      key,
      connectionRef,
      ownerId,
      token: crypto.randomUUID(),
      heartbeatAt: now,
      expiresAt: now + ttlMs,
    }
    await db.syncLeases.add(row)
    return row
  })
}

async function assertSyncLease(row: SyncLeaseRow, now = Date.now()): Promise<void> {
  const current = await getDb().syncLeases.get(row.key)
  if (
    !current ||
    current.token !== row.token ||
    current.ownerId !== row.ownerId ||
    current.expiresAt <= now ||
    !(await connectionAvailable(row.connectionRef))
  )
    throw new SyncLeaseLost()
}

/** The ownership check and ALL cursor writes must share this transaction. */
export async function commitSyncLease<T>(
  row: SyncLeaseRow,
  tables: readonly Table[],
  task: () => Promise<T>
): Promise<T> {
  const db = getDb()
  return db.transaction(
    "rw",
    [db.syncLeases, db.authConnections, db.integrationAudit, ...tables],
    async () => {
      await assertSyncLease(row)
      const value = await task()
      // Roll back a task that yielded past expiry before its transaction commits.
      await assertSyncLease(row)
      return value
    }
  )
}

export async function renewSyncLease(row: SyncLeaseRow, ttlMs: number): Promise<boolean> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Invalid sync lease TTL")
  try {
    await commitSyncLease(row, [], async () => {
      const now = Date.now()
      await getDb().syncLeases.update(row.key, { heartbeatAt: now, expiresAt: now + ttlMs })
    })
    return true
  } catch (error) {
    if (error instanceof SyncLeaseLost) return false
    throw error
  }
}

export async function releaseSyncLease(row: SyncLeaseRow): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.syncLeases, async () => {
    const current = await db.syncLeases.get(row.key)
    if (current?.token === row.token && current.ownerId === row.ownerId)
      await db.syncLeases.delete(row.key)
  })
}

export async function releaseConnectionSyncLeases(ref: string): Promise<void> {
  await getDb().syncLeases.where("connectionRef").equals(ref).delete()
}
