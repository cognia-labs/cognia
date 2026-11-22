/**
 * CRUD layer for the `radarReports` Dexie table (v96) — Attention Radar
 * output. Written by `lib/radar/radar-runner.ts`; read by the pet console
 * radar panel and the pet-insight teaser hook (both via `useLiveQuery`).
 */

import Dexie from "dexie"
import { isMemoryEligibleForRetrieval } from "@cognia/memory/retrieve/retriever"
import type { RadarReport } from "@/types/radar"
import { activeDatabaseEpoch, activeDatabaseName, getDb } from "./schema"

export class RadarAccountChangedError extends Error {
  readonly code = "radar_account_changed"
  constructor(
    readonly expectedDatabase: string,
    readonly activeDatabase: string
  ) {
    super(`radar write for ${expectedDatabase} refused: ${activeDatabase} is active`)
    this.name = "RadarAccountChangedError"
  }
}

export interface RadarDatabaseGuard {
  expectDatabase?: string
  expectEpoch?: number
  /**
   * Re-verify `report.sources` inside the commit transaction (B1): drop sources
   * that were deleted, tombstoned, or rendered ineligible while the model ran,
   * remap `graveyard` and `actionEvidence` indexes, and discard the report
   * (`return null`) when every source vanished before commit.
   */
  verifyLiveSources?: boolean
  now?: number
}

function assertRadarDatabase(db: { name: string }, guard?: RadarDatabaseGuard): void {
  if (!guard) return
  const currentName = db.name
  if (guard.expectDatabase !== undefined && currentName !== guard.expectDatabase) {
    throw new RadarAccountChangedError(guard.expectDatabase, currentName)
  }
  if (guard.expectEpoch !== undefined && activeDatabaseEpoch() !== guard.expectEpoch) {
    throw new RadarAccountChangedError(guard.expectDatabase ?? currentName, activeDatabaseName())
  }
}

function hasRetainedSuggestion(row: RadarReport): boolean {
  if (row.suggestions !== undefined) {
    return row.suggestions.some((suggestion) => suggestion.status !== "dismissed")
  }
  // Legacy reports without `suggestions` synthesize one `pending` suggestion per action.
  return row.actions.length > 0
}

export async function saveRadarReport(
  report: RadarReport,
  guard?: RadarDatabaseGuard
): Promise<RadarReport | null> {
  if (guard) {
    assertRadarDatabase({ name: activeDatabaseName() }, guard)
  }
  const db = getDb()
  assertRadarDatabase(db, guard)
  if (!guard?.verifyLiveSources || !report.sources || report.sources.length === 0) {
    await db.transaction("rw", db.radarReports, async () => {
      assertRadarDatabase(db, guard)
      await db.radarReports.put(report)
    })
    return report
  }

  const now = guard.now ?? Date.now()
  return db.transaction(
    "rw",
    [db.radarReports, db.memories, db.syncTombstones, db.capturedItems],
    async () => {
      assertRadarDatabase(db, guard)
      const sources = report.sources ?? []
      const memoryIds = sources.filter((s) => s.source === "memory").map((s) => s.id)
      const captureIds = sources.filter((s) => s.source === "capture").map((s) => s.id)
      const [memoryRows, tombstoneRows, captureRows] = await Promise.all([
        memoryIds.length > 0 ? db.memories.bulkGet(memoryIds) : Promise.resolve([]),
        memoryIds.length > 0
          ? db.syncTombstones.bulkGet(memoryIds.map((id): ["memories", string] => ["memories", id]))
          : Promise.resolve([]),
        captureIds.length > 0 ? db.capturedItems.bulkGet(captureIds) : Promise.resolve([]),
      ])

      const liveMemoryIds = new Set<string>()
      memoryIds.forEach((id, idx) => {
        const mem = memoryRows[idx]
        const tombstoned = tombstoneRows[idx] !== undefined
        if (mem && !tombstoned && isMemoryEligibleForRetrieval(mem, now)) {
          liveMemoryIds.add(id)
        }
      })
      const liveCaptureIds = new Set<string>()
      captureIds.forEach((id, idx) => {
        if (captureRows[idx] !== undefined) {
          liveCaptureIds.add(id)
        }
      })

      const indexMap = new Map<number, number>()
      const survivingSources: NonNullable<RadarReport["sources"]> = []
      sources.forEach((source, oldIndex) => {
        const alive =
          source.source === "memory"
            ? liveMemoryIds.has(source.id)
            : source.source === "capture"
              ? liveCaptureIds.has(source.id)
              : true
        if (alive) {
          indexMap.set(oldIndex, survivingSources.length)
          survivingSources.push(source)
        }
      })

      if (survivingSources.length === 0) {
        return null
      }

      const prunedReport: RadarReport =
        survivingSources.length === sources.length
          ? report
          : {
              ...report,
              itemCount: survivingSources.length,
              sources: survivingSources,
              graveyard: report.graveyard.flatMap((entry) => {
                const mapped = indexMap.get(entry.index)
                return mapped !== undefined ? [{ ...entry, index: mapped }] : []
              }),
              ...(report.actionEvidence
                ? {
                    actionEvidence: report.actionEvidence.map((indexes) =>
                      indexes.flatMap((oldIdx) => {
                        const mapped = indexMap.get(oldIdx)
                        return mapped !== undefined ? [mapped] : []
                      })
                    ),
                  }
                : {}),
            }

      await db.radarReports.put(prunedReport)
      return prunedReport
    }
  )
}

export async function getRadarReport(id: string): Promise<RadarReport | undefined> {
  return getDb().radarReports.get(id)
}

/** Most-recent report for a scope, or undefined. */
export async function getLatestRadarReport(
  scope = "self",
  guard?: RadarDatabaseGuard
): Promise<RadarReport | undefined> {
  if (guard) {
    assertRadarDatabase({ name: activeDatabaseName() }, guard)
  }
  const db = getDb()
  assertRadarDatabase(db, guard)
  return db.radarReports
    .where("[scope+generatedAt]")
    .between([scope, Dexie.minKey], [scope, Dexie.maxKey])
    .last()
}

/** Newest-first list, capped. */
export async function listRadarReports(limit = 20): Promise<RadarReport[]> {
  return getDb().radarReports.orderBy("generatedAt").reverse().limit(limit).toArray()
}

/**
 * Every report, newest first: the panel's history picker. Uncapped by leaving
 * the limit off, never by a huge one: IndexedDB's `getAll` count is an
 * unsigned long, so `limit(Number.MAX_SAFE_INTEGER)` throws in a real browser.
 */
export async function listAllRadarReports(): Promise<RadarReport[]> {
  return getDb().radarReports.orderBy("generatedAt").reverse().toArray()
}

/** Trim to the newest `keep` reports (called after each write). */
export async function pruneRadarReports(keep = 20, guard?: RadarDatabaseGuard): Promise<number> {
  if (guard) {
    assertRadarDatabase({ name: activeDatabaseName() }, guard)
  }
  const db = getDb()
  assertRadarDatabase(db, guard)
  return db.transaction("rw", db.radarReports, async () => {
    assertRadarDatabase(db, guard)
    const rows = await db.radarReports.orderBy("generatedAt").reverse().offset(keep).toArray()
    // Decisions and accepted commitments remain reachable after newer reports,
    // including legacy reports whose actions synthesize pending suggestions.
    const ids = rows.filter((row) => !hasRetainedSuggestion(row)).map((row) => row.id)
    if (ids.length === 0) return 0
    await db.radarReports.bulkDelete(ids as string[])
    return ids.length
  })
}
