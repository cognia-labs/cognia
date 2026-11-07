/**
 * The run projection of the subagent runtime store (ADR-0252 §2): it reads
 * each tracked entry's `execution:job:<id>` row and hands the row's status to
 * `applyRuns`, so a dispatched run's status is its run's, whatever an engine
 * reported. An entry with no row (an in-turn SDK `Task`, a dispatch refused
 * before it started) is left to its engine.
 *
 * One live query over the ids the store tracks, re-issued when that set
 * changes. Started once, lazily, by the store's first entry; nothing runs
 * where there is no IndexedDB.
 */

import Dexie, { type Subscription } from "dexie"
import type { ExecutionRun } from "@cognia/plugin-contract/types/execution/run"
import type { SubAgentRunState, SubagentRuntimeState } from "./index"

interface StoreLike {
  getState(): Pick<SubagentRuntimeState, "subAgents" | "applyRuns">
  subscribe(listener: (state: SubagentRuntimeState) => void): () => void
}

export interface SubagentRunProjectionDeps {
  /** The rows for these execution run ids, in order (`undefined` when absent). */
  readRuns: (ids: string[]) => Promise<(ExecutionRun | undefined)[]>
  /** `Dexie.liveQuery` by default; a test passes a manual one. */
  liveQuery?: <T>(query: () => Promise<T>) => {
    subscribe(observer: { next(value: T): void; error(error: unknown): void }): Subscription
  }
}

function executionRowId(id: string): string {
  return `execution:job:${id}`
}

function idKey(ids: string[]): string {
  return [...ids].sort().join("\u0000")
}

/** Follow the store's tracked ids; returns the stop. */
export function startSubagentRunProjection(
  store: StoreLike,
  deps: SubagentRunProjectionDeps
): () => void {
  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment
  // a module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const liveQuery = deps.liveQuery ?? Dexie.liveQuery
  let key = ""
  let subscription: Subscription | undefined

  const follow = (ids: string[]) => {
    const nextKey = idKey(ids)
    if (nextKey === key) return
    key = nextKey
    subscription?.unsubscribe()
    subscription = undefined
    if (ids.length === 0) return
    subscription = liveQuery(() => deps.readRuns(ids.map(executionRowId))).subscribe({
      next(rows: (ExecutionRun | undefined)[]) {
        const runs: Record<string, SubAgentRunState | undefined> = {}
        ids.forEach((id, index) => {
          const row = rows[index]
          runs[id] = row
            ? { status: row.status, ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}) }
            : undefined
        })
        store.getState().applyRuns(runs)
      },
      error(error: unknown) {
        console.error("[subagent-runtime] run projection failed", error)
      },
    })
  }

  follow(Object.keys(store.getState().subAgents))
  const unsubscribe = store.subscribe((state) => follow(Object.keys(state.subAgents)))
  return () => {
    unsubscribe()
    subscription?.unsubscribe()
    subscription = undefined
    key = ""
  }
}

let started = false

/**
 * Start the store's projection once. Called by the store when it gains an
 * entry; a no-op where there is no IndexedDB (a Node test, the CLI).
 */
export async function ensureSubagentRunProjection(store: StoreLike): Promise<void> {
  if (started || typeof indexedDB === "undefined") return
  started = true
  const { getDb } = await import("@/lib/db/schema")
  startSubagentRunProjection(store, {
    readRuns: (ids) => getDb().executionRuns.bulkGet(ids),
  })
}

/** Test-only: forget that the projection started. */
export function __resetSubagentRunProjectionForTesting(): void {
  started = false
}
