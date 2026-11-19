/**
 * `botEventDeliveries` companion sync handler.
 *
 * Mirrors the Host's STATUS projection (`projectBotDeliveryRow`): what
 * happened to a delivery, never what was in it. The envelope holds the whole
 * inbound event payload, which is why the table is classified
 * `encrypted-content`, and the client's list only ever renders status,
 * attempts, the error and the run link.
 *
 * Three rails on apply.
 *
 * The projection shape is FORCED, so `syncedFromHost` is set whatever the Host
 * sent. That flag is the one thing standing between a mirrored row and a
 * second machine draining it, and the consequence is not duplicated effort:
 * `botRunId` is derived from the delivery id, so two hosts running one
 * delivery mint the same `ExecutionRun` id into a table that is itself synced.
 *
 * `dedupKey` is STRIPPED rather than mirrored. It is a unique index, and
 * pushing a Host's key into the client's unique index reserves a
 * `ConstraintError` for the first device that mirrors two Hosts.
 *
 * Terminal projections are aged out on every pull by the Host's own rule (14
 * days after they SETTLED, not after they arrived), so the two sweepers cannot
 * disagree about how long a delivery is worth keeping. The Host's tombstone
 * normally removes the row first; this is for a client that missed it.
 */

import { BOT_DELIVERY_RETENTION_MS, isTerminalBotDelivery } from "@/lib/db/bot-event-deliveries"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

import type { SyncCursor, SyncOutcome } from "@/lib/sync/types"
import { runSyncHandler } from "@/lib/sync/handlers/base"

/** The Host's own window, re-exported so the client cannot pick a different one. */
export const MIRROR_BOT_DELIVERY_RETENTION_MS = BOT_DELIVERY_RETENTION_MS

/** Max aged-out rows deleted per pull, bounding one apply's IndexedDB work. */
export const MIRROR_BOT_SWEEP_BATCH = 500

export function normalizeMirroredDelivery(row: BotEventDeliveryRow): BotEventDeliveryRow {
  const next: BotEventDeliveryRow = {
    ...row,
    nextAttemptAt: 0,
    syncedFromHost: true,
  }
  // A unique index on the client. See the module header.
  delete (next as { dedupKey?: string }).dedupKey
  // Host scheduling state. A mirrored lease names an owner this device is not,
  // and a mirrored concurrency key would serialise the client against a queue
  // it does not run.
  delete next.concurrencyKey
  delete next.leaseOwner
  delete next.leaseExpiresAt
  return next
}

export async function applyBotDeliveryRows(
  rows: BotEventDeliveryRow[],
  now: number = Date.now(),
  assertCurrent: () => void = () => {}
): Promise<void> {
  const table = getDb().botEventDeliveries
  if (rows.length > 0) await table.bulkPut(rows.map(normalizeMirroredDelivery))
  assertCurrent()
  await sweepAgedMirroredDeliveries(now, assertCurrent)
}

/**
 * Delete mirrored projections that settled longer ago than the retention
 * window, exactly as `pruneSettledBotDeliveries` deletes the Host's. Aged by
 * arrival instead, a delivery that was held past the window and settled today
 * was deleted the moment the client mirrored its terminal state.
 */
export async function sweepAgedMirroredDeliveries(
  now: number = Date.now(),
  assertCurrent: () => void = () => {}
): Promise<number> {
  const table = getDb().botEventDeliveries
  const victims = await table
    .where("settledAt")
    .belowOrEqual(now - MIRROR_BOT_DELIVERY_RETENTION_MS)
    .filter((row) => row.syncedFromHost === true && isTerminalBotDelivery(row.status))
    .limit(MIRROR_BOT_SWEEP_BATCH)
    .toArray()
  if (victims.length === 0) return 0
  assertCurrent()
  await table.bulkDelete(victims.map((row) => row.id))
  return victims.length
}

export function syncBotEventDeliveries(
  transport: Transport,
  cursor: SyncCursor
): Promise<SyncOutcome> {
  return runSyncHandler<BotEventDeliveryRow>(
    {
      table: "botEventDeliveries",
      getTable: () => getDb().botEventDeliveries,
      applyRows: (rows, assertCurrent) => applyBotDeliveryRows(rows, Date.now(), assertCurrent),
    },
    transport,
    cursor
  )
}
