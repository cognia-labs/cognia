/**
 * CRUD layer for the `radarReports` Dexie table (v96) — Attention Radar
 * output. Written by `lib/radar/radar-runner.ts`; read by the pet console
 * radar panel and the pet-insight teaser hook (both via `useLiveQuery`).
 */

import Dexie from "dexie"
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
): Promise<void> {
  if (guard) {
    assertRadarDatabase({ name: activeDatabaseName() }, guard)
  }
  const db = getDb()
  assertRadarDatabase(db, guard)
  await db.transaction("rw", db.radarReports, async () => {
    assertRadarDatabase(db, guard)
    await db.radarReports.put(report)
  })
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
