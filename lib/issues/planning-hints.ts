/**
 * What a card or a row prints about an issue's planning state, computed once
 * per board pass (spec 2026-09-06, batch 1).
 *
 * The board already holds every item of the workspace, so blocked-ness,
 * sub-issue progress and the cycle name are derived here in one walk and
 * handed to the card as a small hint. The card stays a pure renderer, and the
 * list row and the mobile sheet read the same hint, so the three can never
 * disagree about whether an issue is blocked.
 *
 * The relation reads behind it live here too (spec 2026-09-06, D5): blockers,
 * the derived "blocks" side, direct children, the parent-loop check and the
 * due state. The detail panel's planning section reads them from here rather
 * than spelling its own filters, so the panel and the card agree. No Dexie:
 * callers pass the rows they already hold.
 */

import type { Issue, IssueCycle } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"

// ── relation reads ──────────────────────────────────────────────────────────

/** A row that has neither finished nor been dropped. */
function isOpen(issue: Pick<Issue, "statusCategory">): boolean {
  return issue.statusCategory === "unstarted" || issue.statusCategory === "started"
}

/**
 * Blockers that still stand in the way: listed in `blockedBy`, present in
 * `byId`, and not finished. A deleted or done blocker no longer blocks.
 */
export function openBlockers<T extends Pick<Issue, "statusCategory">>(
  issue: { blockedBy?: readonly string[] },
  byId: ReadonlyMap<string, T>
): T[] {
  const out: T[] = []
  for (const blockerId of issue.blockedBy ?? []) {
    const blocker = byId.get(blockerId)
    if (blocker && isOpen(blocker)) out.push(blocker)
  }
  return out
}

/**
 * The rows `issue.blockedBy` names that are present in `byId`, finished or
 * not, in `blockedBy` order: what the planning section lists.
 */
export function blockerRows<T>(
  issue: { blockedBy?: readonly string[] },
  byId: ReadonlyMap<string, T>
): T[] {
  return (issue.blockedBy ?? [])
    .map((id) => byId.get(id))
    .filter((row): row is T => row !== undefined)
}

/** Issues that list `issueId` as a blocker (the derived `blocks` side). */
export function blockedIssues<T extends { blockedBy?: readonly string[] }>(
  issueId: string,
  issues: readonly T[]
): T[] {
  return issues.filter((candidate) => (candidate.blockedBy ?? []).includes(issueId))
}

/** Direct children of `parentId`. */
export function childIssues<T extends { parentId?: string }>(
  parentId: string,
  issues: readonly T[]
): T[] {
  return issues.filter((candidate) => candidate.parentId === parentId)
}

export interface SubIssueProgress {
  total: number
  done: number
}

/**
 * Would setting `parentId` on `issueId` create a loop? Pure twin of the check
 * `setIssueParent` performs in its transaction, for the picker to disable the
 * entries the write would refuse.
 */
export function wouldCreateParentLoop(
  issueId: string,
  parentId: string,
  byId: ReadonlyMap<string, Pick<Issue, "id" | "parentId">>
): boolean {
  if (issueId === parentId) return true
  const seen = new Set<string>([issueId])
  let cursor = byId.get(parentId)
  while (cursor) {
    if (seen.has(cursor.id)) return true
    seen.add(cursor.id)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return false
}

export type DueState = "none" | "later" | "soon" | "today" | "overdue" | "met"

const DAY_MS = 24 * 60 * 60 * 1000
/** "Soon" is within three days. A preference later, a constant now. */
export const DUE_SOON_WINDOW_MS = 3 * DAY_MS

/**
 * How the due date reads today. A finished issue is `met` whatever the date:
 * a badge that shouts "overdue" on a closed card is noise.
 */
export function dueState(
  issue: Pick<Issue, "dueDate" | "statusCategory">,
  now: number = Date.now()
): DueState {
  if (issue.dueDate === undefined) return "none"
  if (!isOpen(issue)) return "met"
  const endOfToday = startOfDay(now) + DAY_MS
  if (issue.dueDate < startOfDay(now)) return "overdue"
  if (issue.dueDate < endOfToday) return "today"
  if (issue.dueDate < now + DUE_SOON_WINDOW_MS) return "soon"
  return "later"
}

function startOfDay(ts: number): number {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// ── planning hints ──────────────────────────────────────────────────────────

export interface IssuePlanningHint {
  /** At least one open blocker stands. */
  blocked: boolean
  /** Identifiers of the open blockers, for the badge's title. */
  blockerIdentifiers: readonly string[]
  /** Direct children, when any exist. */
  subIssues?: SubIssueProgress
  /** Parent identifier, when the issue is a sub-issue. */
  parentIdentifier?: string
  due: DueState
  cycleName?: string
}

const NO_BLOCKERS: readonly string[] = Object.freeze([])

/**
 * One hint per `unifiedId`. Only local rows carry relation fields, but the
 * map is built for every item so a consumer can look any card up without a
 * kind check.
 */
export function buildPlanningHints(
  items: readonly UnifiedIssueItem[],
  cyclesById: ReadonlyMap<string, IssueCycle> = new Map(),
  now: number = Date.now()
): Map<string, IssuePlanningHint> {
  // Relations are keyed by the LOCAL id (`sourceId`), which is what
  // `blockedBy` and `parentId` store.
  const localById = new Map<string, UnifiedIssueItem>()
  for (const item of items) {
    if (item.kind === "local") localById.set(item.sourceId, item)
  }

  const children = new Map<string, SubIssueProgress>()
  for (const item of items) {
    if (item.kind !== "local" || !item.parentId) continue
    const progress = children.get(item.parentId) ?? { total: 0, done: 0 }
    progress.total += 1
    if (item.statusCategory === "completed") progress.done += 1
    children.set(item.parentId, progress)
  }

  const hints = new Map<string, IssuePlanningHint>()
  for (const item of items) {
    const blockers = item.kind === "local" ? openBlockers(item, localById) : []
    const subIssues = item.kind === "local" ? children.get(item.sourceId) : undefined
    const parent = item.parentId ? localById.get(item.parentId) : undefined
    const cycle = item.cycleId ? cyclesById.get(item.cycleId) : undefined
    hints.set(item.unifiedId, {
      blocked: blockers.length > 0,
      blockerIdentifiers:
        blockers.length > 0 ? blockers.map((blocker) => blocker.identifier) : NO_BLOCKERS,
      ...(subIssues ? { subIssues } : {}),
      ...(parent ? { parentIdentifier: parent.identifier } : {}),
      due: dueState(item, now),
      ...(cycle ? { cycleName: cycle.name } : {}),
    })
  }
  return hints
}
