// /goal milestones → pet events. Observes the newest goal-event row and maps a
// completed turn to "goalProgress" and a goal the judge declared done to
// "goalComplete" (the biggest single XP award — finishing a goal is the pet's
// proudest moment).
//
// Not every `exit_triggered` row finishes a goal: the turn driver also logs one
// for the resumable pauses (`judge_failed_too_many`, `needs_approval` → `paused`)
// and for the stops and limits. Only `judge_done` is rewarded; see
// `goalEventToEmit`.
//
// The Dexie observation is injectable so the mapping logic is unit-tested with a
// plain fake; the default observer uses Dexie's `liveQuery`.

import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import type { GoalEvent, GoalEventPayload } from "@/types/goal"
import type { PetEmit } from "../pet-event-bus"

export type RowObserver<T> = (onRows: (rows: T[]) => void) => () => void

/**
 * Pure mapping from a goal-event payload to a pet emit (or null when ignored).
 *
 * `exit_triggered` becomes "goalComplete" only for `judge_done`, the one exit
 * that means the objective was met. It lands the goal in `completed`, a terminal
 * status, so a goal pays the completion award at most once, however many times
 * it was paused and resumed.
 *
 * Every other exit deliberately emits nothing rather than a smaller award:
 * - The paused exits (`judge_failed_too_many`, `needs_approval`) are a failure
 *   or a blocker. Paying for them would reward every pause → resume cycle.
 * - The terminal non-success exits (`user_stopped`, `preempted`, the turn,
 *   budget and cost limits, `timed_out`) end the goal without meeting it.
 *   "goalComplete" celebrates ("Victory!", a congratulation, the goal-count
 *   achievement), which would be wrong for a goal that was stopped or ran out.
 * - The turns before any exit already paid "goalProgress" each.
 * - The zero-XP radar kinds don't fit. "waiting" and "error" are resting visual
 *   states, not transient ones, and the goal side has no event that would clear
 *   them, so the pet would stay stuck in them.
 */
export function goalEventToEmit(
  payload: GoalEventPayload
): { kind: "goalComplete" | "goalProgress"; xp: number } | null {
  if (payload.kind === "exit_triggered") {
    return payload.exit === "judge_done" ? { kind: "goalComplete", xp: 25 } : null
  }
  if (payload.kind === "turn_completed") return { kind: "goalProgress", xp: 5 }
  return null
}

const RECENT_GOAL_EVENTS_LIMIT = 50
const MAX_SEEN_IDS = 200

/* istanbul ignore next -- thin Dexie liveQuery wrapper, exercised at runtime */
const defaultObserver: RowObserver<GoalEvent> = (onRows) => {
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const sub = Dexie.liveQuery(() =>
    getDb().chatGoalEvents.orderBy("ts").reverse().limit(RECENT_GOAL_EVENTS_LIMIT).toArray()
  ).subscribe({ next: onRows })
  return () => sub.unsubscribe()
}

export function wireGoalSource(
  emit: PetEmit,
  observe: RowObserver<GoalEvent> = defaultObserver
): () => void {
  const seenTsById = new Map<string, number>()
  let watermarkTs = -Infinity
  let started = false

  const remember = (id: string, ts: number) => {
    seenTsById.set(id, ts)
    if (seenTsById.size > MAX_SEEN_IDS) {
      for (const [seenId, seenTs] of seenTsById) {
        if (seenTs < watermarkTs) seenTsById.delete(seenId)
      }
      while (seenTsById.size > MAX_SEEN_IDS) {
        const oldest = seenTsById.keys().next().value
        if (oldest === undefined) break
        seenTsById.delete(oldest)
      }
    }
  }

  return observe((rows) => {
    if (!started) {
      // Ignore whatever was already present when we attached. The baseline is
      // taken on the FIRST callback even when the table is empty: returning
      // before marking it would make the first real row the baseline, and a
      // brand-new user's first goal progress would never reach the pet.
      started = true
      for (const row of rows) {
        if (row.ts > watermarkTs) watermarkTs = row.ts
        remember(row.id, row.ts)
      }
      return
    }
    if (rows.length === 0) return

    // `liveQuery` returns newest-first; reverse first so equal-timestamp rows
    // keep chronological order, then emit every unseen row at/after the
    // watermark so batched turn_completed + exit_triggered or multi-goal
    // completions are never dropped and deletions never re-emit older rows (F23).
    const candidates = [...rows]
      .reverse()
      .filter((row) => row.ts >= watermarkTs && !seenTsById.has(row.id))
      .sort((a, b) => a.ts - b.ts)

    for (const row of candidates) {
      if (row.ts > watermarkTs) watermarkTs = row.ts
      remember(row.id, row.ts)
      const mapped = goalEventToEmit(row.payload)
      if (mapped) {
        emit({ source: "goal", kind: mapped.kind, xp: mapped.xp, meta: { goalId: row.goalId } })
      }
    }
  })
}
