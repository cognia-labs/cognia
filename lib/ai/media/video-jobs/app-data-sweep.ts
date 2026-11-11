/**
 * Retention for the video files under AppData (ADR-0205), run by the storage
 * retention sweep beside `pruneSettledVideoJobs`.
 *
 * The row prune removes a workflow job's file with its row. This removes what
 * no row accounts for:
 *
 * - the directory of every database that no longer exists (account deletion or
 *   "clear all data" whose own removal failed, a removed runtime target);
 * - a generated video in the active database's directory whose job has no row
 *   (the database was cleared and recreated under the same name, or a removal
 *   failed after its row went). A file is matched to its job by name
 *   (`<jobId>.<ext>`, or the `<jobId>.<ext>.<id>.part` of a write in flight),
 *   so a job that is still downloading keeps its file;
 * - a composer staging copy older than {@link STALE_STAGING_MS}: a copy lives
 *   for one preparation, so an old one was left by a crash.
 */

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"
import {
  COMPOSER_VIDEO_STAGING_APP_DATA_DIR,
  GENERATED_VIDEO_APP_DATA_DIR,
  ACCOUNT_APP_DATA_DIRS,
  databaseAppDataDir,
} from "@/lib/tauri/account-app-data"
import {
  appDataModifiedAt,
  listAppDataDirectory,
  removeAppDataFile,
  removeAppDataDirectory,
} from "@/lib/tauri/app-data-files"
import { detectHostProfile } from "@/lib/platform/capabilities"

/** Age past which a staging copy is a crash's leftover, not a preparation's. */
export const STALE_STAGING_MS = 24 * 60 * 60 * 1000

export interface VideoAppDataSweepDeps {
  now(): number
  databaseExists(databaseName: string): Promise<boolean>
  existingJobIds(ids: readonly string[], db: ReturnType<typeof getDb>): Promise<Set<string>>
}

const defaultDeps: VideoAppDataSweepDeps = {
  now: () => Date.now(),
  databaseExists: (databaseName) => Dexie.exists(databaseName),
  existingJobIds: async (ids, db) => {
    const rows = await db.mediaGenerationJobs.bulkGet([...ids])
    return new Set(rows.flatMap((row) => (row ? [row.id] : [])))
  },
}

export interface VideoAppDataSweepResult {
  databaseDirectories: number
  orphanVideos: number
  staleStagingCopies: number
}

export interface VideoAppDataSweepReport {
  failed: number
  unknown: number
  skipped: boolean
  removed: number
}

/** Remove each path; one that cannot be removed now is left for the next sweep. */
async function removeFiles(
  paths: readonly string[],
  assertActive: () => void,
  report?: VideoAppDataSweepReport
): Promise<number> {
  let removed = 0
  for (const path of paths) {
    assertActive()
    try {
      await removeAppDataFile(path)
      removed += 1
      if (report) report.removed++
    } catch {
      if (report) report.failed++
      // Held open or refused: the next sweep tries again.
    }
    assertActive()
  }
  return removed
}

async function orphanVideos(
  deps: VideoAppDataSweepDeps,
  db: ReturnType<typeof getDb>,
  dir: string,
  assertActive: () => void
): Promise<string[]> {
  const files = (await listAppDataDirectory(dir)).filter((entry) => entry.isFile)
  assertActive()
  const jobIdOf = (name: string) => name.split(".")[0]
  const existing = await deps.existingJobIds([...new Set(files.map((f) => jobIdOf(f.name)))], db)
  assertActive()
  return files.filter((f) => !existing.has(jobIdOf(f.name))).map((f) => `${dir}/${f.name}`)
}

async function staleStagingCopies(
  deps: VideoAppDataSweepDeps,
  dir: string,
  assertActive: () => void,
  report?: VideoAppDataSweepReport
): Promise<string[]> {
  const cutoff = deps.now() - STALE_STAGING_MS
  const stale: string[] = []
  for (const entry of await listAppDataDirectory(dir)) {
    assertActive()
    if (!entry.isFile) continue
    const path = `${dir}/${entry.name}`
    const modifiedAt = await appDataModifiedAt(path).catch(() => null)
    assertActive()
    if (modifiedAt === null && report) report.unknown++
    if (modifiedAt !== null && modifiedAt < cutoff) stale.push(path)
  }
  return stale
}

/** Plan dropped directories before any deletion so a routing change aborts the sweep. */
async function droppedDirectories(deps: VideoAppDataSweepDeps, assertActive: () => void) {
  const paths: Array<{ path: string; database: boolean }> = []
  for (const dir of ACCOUNT_APP_DATA_DIRS) {
    for (const account of await listAppDataDirectory(dir)) {
      assertActive()
      if (!account.isDirectory) continue
      try {
        databaseAppDataDir(dir, account.name, "validation")
      } catch {
        continue
      }
      const accountDir = `${dir}/${account.name}`
      const databases = await listAppDataDirectory(accountDir)
      assertActive()
      let kept = databases.length
      for (const database of databases) {
        if (!database.isDirectory) continue
        let path: string
        try {
          path = databaseAppDataDir(dir, account.name, database.name)
        } catch {
          continue
        }
        const exists = await deps.databaseExists(database.name)
        assertActive()
        if (exists) continue
        paths.push({ path, database: true })
        kept--
      }
      if (kept === 0) paths.push({ path: accountDir, database: false })
    }
  }
  assertActive()
  return paths
}

/** One sweep. A no-op off the desktop, where these directories do not exist. */
export async function sweepVideoAppData(
  deps: VideoAppDataSweepDeps = defaultDeps,
  report?: VideoAppDataSweepReport
): Promise<VideoAppDataSweepResult> {
  if (detectHostProfile() !== "desktop") {
    if (report) report.skipped = true
    return { databaseDirectories: 0, orphanVideos: 0, staleStagingCopies: 0 }
  }
  const db = getDb()
  const accountId = getActiveAccountId()
  const targetKey = getRuntimeTargetScopeKey()
  const assertActive = () => {
    if (getDb() !== db || getRuntimeTargetScopeKey() !== targetKey)
      throw new Error("video_sweep_owner_changed")
  }
  const videosDir = databaseAppDataDir(GENERATED_VIDEO_APP_DATA_DIR, accountId, db.name)
  const stagingDir = databaseAppDataDir(COMPOSER_VIDEO_STAGING_APP_DATA_DIR, accountId, db.name)
  const directories = await droppedDirectories(deps, assertActive)
  const videos = await orphanVideos(deps, db, videosDir, assertActive)
  const staging = await staleStagingCopies(deps, stagingDir, assertActive, report)
  assertActive()
  let databaseDirectories = 0
  const failedDirectories: string[] = []
  for (const entry of directories) {
    assertActive()
    // Keep an account directory if one of its child deletions failed.
    if (!entry.database && failedDirectories.some((path) => path.startsWith(`${entry.path}/`)))
      continue
    try {
      await removeAppDataDirectory(entry.path)
      if (entry.database) {
        databaseDirectories++
        if (report) report.removed++
      }
    } catch {
      failedDirectories.push(entry.path)
      if (report) report.failed++
    }
    assertActive()
  }
  return {
    databaseDirectories,
    orphanVideos: await removeFiles(videos, assertActive, report),
    staleStagingCopies: await removeFiles(staging, assertActive, report),
  }
}
