/**
 * Who is running a child run, and what to do about one nobody runs any more
 * (ADR-0252 §3, X10).
 *
 * A child the launcher runs itself (`agent`, `external`, `twin`, a caller's
 * engine) lives in the process that launched it: when that process stops (a
 * refresh, a closed window, a crash) the engine is gone and its row would read
 * `running` forever. A child with a `backgroundTasks` entry is reconciled by
 * the outbox's owner lease (`interruptRendererBackgroundTasksOnBoot`). This
 * covers the rest.
 *
 *   - The launcher holds an ownership claim for the child from BEFORE its row
 *     is written until AFTER the row is settled (`holdChildRunOwnership`).
 *   - `reconcileOrphanedChildRuns` reads the open rows the launcher marked as
 *     its own, then asks which claims are still held, and settles every row
 *     no live process claims as `cancelled`: the work did not go wrong, its
 *     host went away. Rows first, claims second: a row in the list had its
 *     claim taken before the row existed, so a claim missing from the later
 *     snapshot was released, which only happens after the row is settled (the
 *     settle is re-checked before writing).
 *
 * The claim is a Web Lock (`navigator.locks`), which every same-origin webview
 * of the app shares and the browser releases when a process dies. A host
 * without Web Locks and without a browser window (the headless brain, a Node
 * test) is one process, so an in-process set is the truth there. A browser
 * without Web Locks cannot tell another window's runs from orphans and skips
 * the reconciliation rather than guess.
 *
 * Only rows the launcher marked (`launchedBy: "child-run"` on the opening
 * event) are touched: `execution:job:` is also the id space of outbound
 * delivery and integration action jobs, which their own queues reconcile.
 * Rows written before the marker are not reconciled (ADR-0252: no migration).
 */

import { isTerminalRunStatus, type ExecutionRun } from "@/types/execution/run"

/** The opening-event marker of a row the launcher wrote. */
export const CHILD_RUN_LAUNCHER_MARK = "child-run"

const LOCK_PREFIX = "cognia:child-run:"

export interface ChildRunOwnership {
  /** Claim `runId`; resolves once held, with its release. */
  hold(runId: string): Promise<() => void>
  /** The run ids some live process claims, or `null` when this host cannot tell. */
  held(): Promise<ReadonlySet<string> | null>
}

interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<void>
  query(): Promise<{ held?: { name?: string }[] }>
}

function lockManager(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : undefined
}

/** A real browser window, not the headless brain's bare `window` shim. */
function hasBrowserWindow(): boolean {
  const win = (globalThis as { window?: { addEventListener?: unknown } }).window
  return (
    typeof win !== "undefined" &&
    typeof win.addEventListener === "function" &&
    typeof (globalThis as { document?: unknown }).document !== "undefined"
  )
}

/** Web Locks: shared by every same-origin webview, released when one dies. */
export function webLockOwnership(locks: LockManagerLike): ChildRunOwnership {
  return {
    hold: (runId) =>
      new Promise((resolveHeld, rejectHeld) => {
        let release!: () => void
        const released = new Promise<void>((resolve) => (release = resolve))
        locks
          .request(`${LOCK_PREFIX}${runId}`, async () => {
            resolveHeld(release)
            await released
          })
          .catch(rejectHeld)
      }),
    held: async () => {
      const snapshot = await locks.query()
      const ids = new Set<string>()
      for (const lock of snapshot.held ?? []) {
        if (lock.name?.startsWith(LOCK_PREFIX)) ids.add(lock.name.slice(LOCK_PREFIX.length))
      }
      return ids
    },
  }
}

/** One process: what this process holds is everything anyone holds. */
export function inProcessOwnership(): ChildRunOwnership {
  const claims = new Map<string, number>()
  return {
    hold: async (runId) => {
      claims.set(runId, (claims.get(runId) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = (claims.get(runId) ?? 1) - 1
        if (left > 0) claims.set(runId, left)
        else claims.delete(runId)
      }
    },
    held: async () => new Set(claims.keys()),
  }
}

/** Claims nothing can see: a browser without Web Locks. */
function blindOwnership(): ChildRunOwnership {
  return { hold: async () => () => undefined, held: async () => null }
}

let ownership: ChildRunOwnership | undefined

function currentOwnership(): ChildRunOwnership {
  if (!ownership) {
    const locks = lockManager()
    ownership = locks
      ? webLockOwnership(locks)
      : hasBrowserWindow()
        ? blindOwnership()
        : inProcessOwnership()
  }
  return ownership
}

/**
 * Claim a child run for this process. Called by the launcher before the row
 * is written; the release is called after the row is settled. A claim that
 * cannot be taken (the lock manager refused) yields a no-op release: the run
 * still runs, and is simply not distinguishable from an orphan here.
 */
export async function holdChildRunOwnership(runId: string): Promise<() => void> {
  try {
    return await currentOwnership().hold(runId)
  } catch {
    return () => undefined
  }
}

export interface OrphanReconcileDeps {
  /** Open `job` rows (queued, running, waiting, paused). */
  listOpenJobRuns(): Promise<ExecutionRun[]>
  /** True when the row's opening event carries the launcher's mark. */
  isLauncherRun(runId: string): Promise<boolean>
  /** True when a `backgroundTasks` entry delivers this child's result. */
  hasOutboxEntry(childId: string): Promise<boolean>
  /** Settle `runId` cancelled unless it settled meanwhile. */
  settleCancelled(runId: string): Promise<boolean>
  ownership?: ChildRunOwnership
}

async function defaultDeps(): Promise<OrphanReconcileDeps> {
  const [{ listExecutionRuns, runEventJournal, semanticRunEvent, getExecutionRun }, { getDb }] =
    await Promise.all([import("@/lib/db/execution-runs"), import("@/lib/db/schema")])
  return {
    listOpenJobRuns: () =>
      listExecutionRuns({
        kinds: ["job"],
        statuses: ["queued", "running", "waiting", "paused"],
        limit: Number.MAX_SAFE_INTEGER,
      }),
    isLauncherRun: async (runId) => {
      const opening = await getDb().executionRunEvents.get(
        `execution-event:${runId}:tool-entry:${runId}`
      )
      return (
        opening?.type === "run.started" && opening.payload?.launchedBy === CHILD_RUN_LAUNCHER_MARK
      )
    },
    hasOutboxEntry: async (childId) => Boolean(await getDb().backgroundTasks.get(childId)),
    settleCancelled: async (runId) => {
      const run = await getExecutionRun(runId)
      if (!run || isTerminalRunStatus(run.status)) return false
      // The launcher's own settle event id: a settle racing this one dedupes.
      await runEventJournal.append(
        runId,
        semanticRunEvent(
          "run.cancelled",
          { reason: "host_stopped" },
          { sourceEventId: `tool-entry:${runId}:finished` }
        )
      )
      return true
    },
  }
}

/**
 * Settle every open child run the launcher wrote that no live process runs.
 * Resolves the ids it settled. Safe to call on every recovery tick: a run
 * some process still holds is never touched.
 */
export async function reconcileOrphanedChildRuns(deps?: OrphanReconcileDeps): Promise<string[]> {
  const resolved = deps ?? (await defaultDeps())
  const claims = resolved.ownership ?? currentOwnership()
  // Rows first, claims second (see the module comment).
  const open = await resolved.listOpenJobRuns()
  if (open.length === 0) return []
  const held = await claims.held()
  if (!held) return []
  const settled: string[] = []
  for (const run of open) {
    if (held.has(run.id)) continue
    if (!(await resolved.isLauncherRun(run.id).catch(() => false))) continue
    if (await resolved.hasOutboxEntry(run.sourceId).catch(() => true)) continue
    if (await resolved.settleCancelled(run.id).catch(() => false)) settled.push(run.id)
  }
  return settled
}

/** Test-only: drop the cached ownership so the next call picks it again. */
export function __resetChildRunOwnershipForTesting(next?: ChildRunOwnership): void {
  ownership = next
}
