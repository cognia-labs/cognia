// Pure helpers for the scheduled-backup feature. No React, no Dexie, no
// `window` — these run inside the provider's interval and inside tests.

import type { BackupAutoSchedule } from "@cognia/agent-config-types"

/**
 * Decide whether the auto-scheduler should fire a backup right now.
 *
 *   • config disabled → false
 *   • no successful row → true (first run)
 *   • last success older than `intervalDays` → true
 */
export function shouldRunScheduledBackup(args: {
  config: BackupAutoSchedule | undefined
  lastSuccessAt: number | undefined
  now?: number
}): boolean {
  const { config, lastSuccessAt, now = Date.now() } = args
  if (!config?.enabled) return false
  if (config.intervalDays <= 0) return false
  if (!lastSuccessAt) return true
  const ageMs = now - lastSuccessAt
  const intervalMs = config.intervalDays * 24 * 60 * 60 * 1000
  return ageMs >= intervalMs
}

/**
 * Decide whether the reminder banner should appear. Independent from the
 * auto-schedule path — even users who have automation off can opt into a
 * gentle "back up your data" nudge.
 *
 *   • reminderDays falsy → false (opt-out)
 *   • last successful backup younger than reminderDays → false
 *   • dismissed within the last reminderDays → false
 */
export function shouldShowReminder(args: {
  reminderDays: number | undefined
  lastSuccessAt: number | undefined
  dismissedAt: number | undefined
  now?: number
}): boolean {
  const { reminderDays, lastSuccessAt, dismissedAt, now = Date.now() } = args
  if (!reminderDays || reminderDays <= 0) return false
  const windowMs = reminderDays * 24 * 60 * 60 * 1000
  if (lastSuccessAt && now - lastSuccessAt < windowMs) return false
  if (dismissedAt && now - dismissedAt < windowMs) return false
  return true
}

export interface BackupCandidate {
  /** Filename or absolute path. */
  name: string
  /** Mtime / completedAt — newer is "younger". */
  completedAt: number
}

const EXACT_BACKUP_TIME_SUFFIX = /-\d{8}T\d{9}Z-(?:[a-f0-9-]{36}-)?owner-[a-f0-9]{64}\.enc\.cbk$/

/** Exact interval/pre-join times are UTC; legacy dates are local-day lower bounds. */
export function scheduledBackupCompletedAt(name: string): number | null {
  const match =
    /^cognia-backup-(\d{4}-\d{2}-\d{2})(?:-interval-(\d{8}T\d{9}Z)|-prejoin-(?:(\d{8}T\d{9}Z)-)?[a-f0-9-]{36})?-owner-[a-f0-9]{64}\.enc\.cbk$/.exec(
      name
    )
  if (!match) return null
  const [, date, intervalTimestamp, prejoinTimestamp] = match
  const localDay = new Date(`${date}T00:00:00`)
  const [year, month, day] = date.split("-").map(Number)
  // Local date construction can normalize impossible dates, too.
  if (
    localDay.getFullYear() !== year ||
    localDay.getMonth() + 1 !== month ||
    localDay.getDate() !== day
  )
    return null
  const timestamp = intervalTimestamp ?? prejoinTimestamp
  if (!timestamp) return localDay.getTime()
  const iso = timestamp.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/,
    "$1-$2-$3T$4:$5:$6.$7Z"
  )
  const completedAt = Date.parse(iso)
  // Date.parse normalizes impossible dates, which must not authorize deletion.
  if (!Number.isFinite(completedAt) || new Date(completedAt).toISOString() !== iso) return null
  return completedAt
}

/**
 * Pick the candidates to delete so the scheduled-backup directory keeps only
 * the newest `retainCount` entries. Pure: takes the file list, returns the
 * subset to remove.
 */
export function pruneScheduledBackups<T extends BackupCandidate>(
  candidates: T[],
  retainCount: number,
  keepName?: string
): T[] {
  if (retainCount <= 0) return [...candidates]
  if (candidates.length <= retainCount) return []
  const sorted = [...candidates].sort(
    (a, b) =>
      Number(b.name === keepName) - Number(a.name === keepName) ||
      b.completedAt - a.completedAt ||
      // An exact local-midnight point is newer than an imprecise same-day file.
      Number(EXACT_BACKUP_TIME_SUFFIX.test(b.name)) -
        Number(EXACT_BACKUP_TIME_SUFFIX.test(a.name)) ||
      (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)
  )
  return sorted.slice(retainCount)
}
