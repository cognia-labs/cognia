/**
 * The overview's "last 24 hours" readout, computed from audit rows.
 *
 * Pure so the counting rules are pinned without Dexie: a denied call is the
 * only kind that counts as failing, and "last screenshot" means the newest
 * *allowed* `screenshot` (a denied one captured nothing).
 */

import type { AutomationAuditLogRow } from "./audit"

export const AUDIT_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000

export interface AuditWindowSummary {
  total: number
  allow: number
  deny: number
  consent: number
  /** Most-denied commands first, at most `topN`. */
  topFailing: Array<{ command: string; count: number }>
  lastScreenshotTs: number | null
}

export function summarizeAuditWindow(
  rows: readonly Pick<AutomationAuditLogRow, "ts" | "decision" | "command">[],
  now: number,
  { windowMs = AUDIT_SUMMARY_WINDOW_MS, topN = 5 }: { windowMs?: number; topN?: number } = {}
): AuditWindowSummary {
  const cutoff = now - windowMs
  let total = 0
  let allow = 0
  let deny = 0
  let consent = 0
  let lastScreenshotTs: number | null = null
  const denyByCommand = new Map<string, number>()
  for (const row of rows) {
    if (row.ts < cutoff) continue
    total++
    if (row.decision === "allow") {
      allow++
      if (
        row.command === "screenshot" &&
        (lastScreenshotTs === null || row.ts > lastScreenshotTs)
      ) {
        lastScreenshotTs = row.ts
      }
    } else if (row.decision === "deny") {
      deny++
      denyByCommand.set(row.command, (denyByCommand.get(row.command) ?? 0) + 1)
    } else {
      consent++
    }
  }
  const topFailing = [...denyByCommand.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
    .slice(0, topN)
  return { total, allow, deny, consent, topFailing, lastScreenshotTs }
}

export type RelativeAge =
  | { unit: "seconds"; value: number }
  | { unit: "minutes"; value: number }
  | { unit: "hours"; value: number }

/** Coarse age of a timestamp, for "x minutes ago" copy. */
export function relativeAge(ts: number, now: number): RelativeAge {
  const seconds = Math.max(0, Math.round((now - ts) / 1000))
  if (seconds < 60) return { unit: "seconds", value: seconds }
  if (seconds < 3600) return { unit: "minutes", value: Math.floor(seconds / 60) }
  return { unit: "hours", value: Math.floor(seconds / 3600) }
}
