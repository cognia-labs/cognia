// Visual-workflow runs → pet events. Observes the newest run row and maps its
// status to the radar: running→workflowRun, succeeded→success, failed→error.
// Tracks the (id, status) pair so an in-place status flip on the same run is
// detected. Dexie observation is injectable for testing.

import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import type { RunStatus, WorkflowRunRow } from "@/types/workflow/visual"
import type { PetEmit } from "../pet-event-bus"
import type { RowObserver } from "./goal-source"

/** Pure mapping from a run status to a pet emit (or null when ignored). */
export function runStatusToEmit(
  status: RunStatus
): { kind: "workflowRun" | "success" | "error"; xp: number } | null {
  switch (status) {
    case "running":
      return { kind: "workflowRun", xp: 0 }
    case "succeeded":
      return { kind: "success", xp: 6 }
    case "failed":
      return { kind: "error", xp: 0 }
    default:
      return null
  }
}

const RECENT_WORKFLOW_RUNS_LIMIT = 50
const MAX_TRACKED_RUNS = 200

/* istanbul ignore next -- thin Dexie liveQuery wrapper, exercised at runtime */
const defaultObserver: RowObserver<WorkflowRunRow> = (onRows) => {
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const sub = Dexie.liveQuery(() =>
    getDb().workflowRuns.orderBy("startedAt").reverse().limit(RECENT_WORKFLOW_RUNS_LIMIT).toArray()
  ).subscribe({ next: onRows })
  return () => sub.unsubscribe()
}

export function wireWorkflowSource(
  emit: PetEmit,
  observe: RowObserver<WorkflowRunRow> = defaultObserver
): () => void {
  const statusById = new Map<string, RunStatus>()
  let watermarkStartedAt = -Infinity
  let started = false

  return observe((rows) => {
    if (!started) {
      // Baseline on the FIRST callback, even an empty one. Returning before
      // marking it would make the very first run's `running` row the
      // baseline, so that run would lose its "working on it" cue.
      started = true
      for (const row of rows) {
        statusById.set(row.id, row.status)
        if (row.startedAt > watermarkStartedAt) watermarkStartedAt = row.startedAt
      }
      return
    }
    if (rows.length === 0) return

    // Process recent runs chronologically so concurrent runs that started
    // earlier still report their terminal status after a newer run starts, and
    // historical rows sliding into the window after deletion never replay (F23).
    const ordered = [...rows].reverse().sort((a, b) => a.startedAt - b.startedAt)
    const preWatermark = watermarkStartedAt

    for (const row of ordered) {
      const prevStatus = statusById.get(row.id)
      if (prevStatus !== undefined) {
        if (prevStatus === row.status) continue
        statusById.set(row.id, row.status)
        const mapped = runStatusToEmit(row.status)
        if (mapped) {
          emit({ source: "workflow", kind: mapped.kind, xp: mapped.xp, meta: { runId: row.id } })
        }
        continue
      }

      statusById.set(row.id, row.status)
      if (row.startedAt > watermarkStartedAt) watermarkStartedAt = row.startedAt
      if (row.startedAt < preWatermark) {
        // Older row sliding into the tail window after a deletion — track its
        // current status for future transitions without replaying history.
        continue
      }
      const mapped = runStatusToEmit(row.status)
      if (mapped) {
        emit({ source: "workflow", kind: mapped.kind, xp: mapped.xp, meta: { runId: row.id } })
      }
    }

    if (statusById.size > MAX_TRACKED_RUNS) {
      const activeIds = new Set(rows.map((r) => r.id))
      for (const [id, status] of statusById) {
        if (
          !activeIds.has(id) &&
          status !== "running" &&
          status !== "pending" &&
          status !== "paused"
        ) {
          statusById.delete(id)
        }
        if (statusById.size <= MAX_TRACKED_RUNS) break
      }
    }
  })
}
