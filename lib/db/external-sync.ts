import { getDb } from "./schema"
import type {
  ExternalSyncMode,
  ExternalSyncSubscription,
  ExternalSyncTarget,
} from "@/lib/external-services/sync/types"

export interface ExternalSyncGeneration {
  id: string
  mode: ExternalSyncMode
  startedAt: number
  page?: string
  pages: number
  applied: number
  /** Durable cycle detection, including after a process restart. */
  pageTokens?: string[]
  /** A terminal page has applied; retry finalization without refetching the scan. */
  terminalCursor?: string
}

export interface ExternalSyncCursorRow extends ExternalSyncTarget {
  cursor?: string
  committedAt?: number
  generation?: ExternalSyncGeneration
  invalidated?: boolean
  backoffUntil?: number
  failures: number
  lastErrorCode?: string
  lastSuccessAt?: number
  deferredOffline?: boolean
  subscription?: ExternalSyncSubscription
}

export interface ExternalSyncSeenRow {
  key: string
  generation: string
  itemId: string
}

export function getExternalSyncCursor(key: string): Promise<ExternalSyncCursorRow | undefined> {
  return getDb().externalSyncCursors.get(key)
}

export function listDeferredExternalSyncs(): Promise<ExternalSyncCursorRow[]> {
  return getDb()
    .externalSyncCursors.filter((row) => row.deferredOffline === true)
    .toArray()
}

export function listExternalSyncSubscriptions(): Promise<ExternalSyncCursorRow[]> {
  return getDb()
    .externalSyncCursors.filter((row) => row.subscription !== undefined)
    .toArray()
}

export function deleteExternalSyncSeen(key: string, generation: string): Promise<number> {
  return getDb().externalSyncSeen.where("[key+generation]").equals([key, generation]).delete()
}

export async function getExternalSyncSeen(key: string, generation: string): Promise<Set<string>> {
  return new Set(
    (
      await getDb().externalSyncSeen.where("[key+generation]").equals([key, generation]).toArray()
    ).map((row) => row.itemId)
  )
}
