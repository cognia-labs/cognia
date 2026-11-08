/**
 * How a host answers a companion sync pull for one table: the rows past the
 * client's cursor, the tombstones recorded since, and the cursor to send back.
 * The host's own readers (`./desktop-sync-source.ts`) and the readers modules
 * contribute (`./module-handlers.ts`) both build their delta here, so every
 * table folds tombstones and advances its cursor the same way.
 */

import { readTombstonesSince } from "@/lib/db/tombstones"
import type { SyncDelta, SyncableTable } from "./types"

/** A row as most tables store it: an id and an `updatedAt` / `createdAt` watermark. */
export interface UpdatedAtRow {
  id: string
  updatedAt?: number
  createdAt?: number
}

export async function finalizeDelta<T extends UpdatedAtRow>(
  table: SyncableTable,
  rows: T[],
  since: number,
  hasMore = false,
  /**
   * How to read a row's cursor watermark. Defaults to `updatedAt ?? createdAt`
   * — the shape every other table carries. `workflowRuns` has neither, so it
   * passes `max(startedAt, completedAt)` instead (see readWorkflowRunsDelta).
   */
  cursorOf: (row: T) => number = (row) => Number(row.updatedAt ?? row.createdAt ?? 0)
): Promise<SyncDelta<T>> {
  // Fold in tombstones recorded since the cursor (v61). The phone applies
  // `deleted_ids` via `bulkDelete`, so a desktop deletion finally reaches
  // it. `deletedAt` shares the cursor space with `updatedAt` — both feed
  // `next_since` so each upsert and each tombstone crosses the wire once.
  let highestCursor = since
  for (const row of rows) {
    const candidate = cursorOf(row)
    if (candidate > highestCursor) highestCursor = candidate
  }
  // Legacy pagination may only acknowledge deletions up to its delivered page.
  const { ids: deletedIds, maxDeletedAt } = await readTombstonesSince(
    table,
    since,
    hasMore ? highestCursor : undefined
  )
  if (maxDeletedAt > highestCursor) highestCursor = maxDeletedAt

  return {
    rows,
    deleted_ids: excludeLiveKeys(table, rows, deletedIds),
    next_since: highestCursor,
    has_more: hasMore,
  }
}

/**
 * The primary key a paired client stores each table under, where it is not
 * `id`. Tombstones are recorded under this key, and the client deletes by it.
 */
const SYNC_PRIMARY_KEY: Partial<Record<SyncableTable, string>> = {
  templateDefinitions: "storageKey",
  templatePackages: "key",
}

/**
 * Drop every tombstoned key whose row is also in this delta. The rows are read
 * from the live table, so a key present there exists on the Host now: it was
 * deleted and then recreated inside one pull window (a plugin reinstalled under
 * its manifest id, a template re-imported). The client applies rows before
 * deletions, so sending both would delete the live row it had just written.
 */
export function excludeLiveKeys(
  table: SyncableTable,
  rows: readonly unknown[],
  deletedIds: readonly string[]
): string[] {
  if (deletedIds.length === 0 || rows.length === 0) return [...deletedIds]
  const keyField = SYNC_PRIMARY_KEY[table] ?? "id"
  const live = new Set<string>()
  for (const row of rows) {
    const key = (row as Record<string, unknown> | null)?.[keyField]
    if (typeof key === "string") live.add(key)
  }
  return deletedIds.filter((id) => !live.has(id))
}
