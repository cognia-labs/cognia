/**
 * The consumer of background job ends in one window (ADR-0249 §6, §7).
 *
 * Subscribes to the supervisor's `jobs://exited` and `jobs://monitor-fired`
 * (over the companion transport when a Host is paired) and hands every end an
 * agent's conversation is owed to the outbox. Events are lost across a
 * reload, a restart or a dropped connection, so it also reconciles: once at
 * start, and whenever the transport reports missed `jobs` events, it reads the
 * ends the supervisor kept and records them too. Recording is idempotent by
 * job id, so an end seen twice is delivered once.
 */

import type { BackgroundTaskHost, BackgroundTaskJournalRecord } from "./registry-core"
import {
  JOB_RECONCILE_WINDOW_MS,
  outboxRecordFromJobExit,
  outboxRecordFromMonitor,
  type BackgroundJobExitShape,
  type BackgroundMonitorSettlementShape,
} from "./job-settlement"

export const JOB_EXITED_EVENT = "jobs://exited"
export const MONITOR_FIRED_EVENT = "jobs://monitor-fired"

export interface JobSettlementConsumerDeps {
  host: BackgroundTaskHost
  subscribe: <T>(event: string, handler: (payload: T) => void) => Promise<() => void>
  /** The supervisor's kept ends (`background_job_settlements`). */
  listSettlements: (filter: { sinceMs: number }) => Promise<{
    jobs: readonly BackgroundJobExitShape[]
    monitors: readonly BackgroundMonitorSettlementShape[]
  }>
  /** Record an owed end and deliver it (idempotent by job id). */
  onSettled: (record: BackgroundTaskJournalRecord) => Promise<void>
  /** Called with a resolver to run when the transport missed `jobs` events. */
  registerResync?: (domain: string, resolver: () => Promise<void>) => () => void
  now?: () => number
  warn?: (message: string, error: unknown) => void
}

export interface JobSettlementConsumer {
  /** Read the supervisor's kept ends and record any this window missed. */
  reconcile(): Promise<void>
  stop(): void
}

export function startJobSettlementConsumer(deps: JobSettlementConsumerDeps): JobSettlementConsumer {
  const now = deps.now ?? Date.now
  const warn = deps.warn ?? (() => undefined)
  const unsubscribers: Array<() => void> = []
  let stopped = false

  const record = (entry: BackgroundTaskJournalRecord | null) => {
    if (!entry || stopped) return Promise.resolve()
    return deps.onSettled(entry).catch((error) => warn("background job settlement failed", error))
  }

  const subscribe = <T>(
    event: string,
    toRecord: (payload: T) => BackgroundTaskJournalRecord | null
  ) =>
    deps
      .subscribe<T>(event, (payload) => void record(toRecord(payload)))
      .then((unsubscribe) => {
        if (stopped) unsubscribe()
        else unsubscribers.push(unsubscribe)
      })
      .catch((error) => warn(`subscribing to ${event} failed`, error))

  const reconcile = async () => {
    if (stopped) return
    const { jobs, monitors } = await deps.listSettlements({
      sinceMs: now() - JOB_RECONCILE_WINDOW_MS,
    })
    for (const exit of jobs) await record(outboxRecordFromJobExit(exit, deps.host))
    for (const monitor of monitors) await record(outboxRecordFromMonitor(monitor, deps.host))
  }

  // Subscribe first, then read what was kept: an end landing between the two
  // is seen by both, and recording it twice changes nothing.
  void Promise.all([
    subscribe<BackgroundJobExitShape>(JOB_EXITED_EVENT, (exit) =>
      outboxRecordFromJobExit(exit, deps.host)
    ),
    subscribe<BackgroundMonitorSettlementShape>(MONITOR_FIRED_EVENT, (monitor) =>
      outboxRecordFromMonitor(monitor, deps.host)
    ),
  ]).then(() => reconcile().catch((error) => warn("background job reconciliation failed", error)))

  if (deps.registerResync) {
    try {
      unsubscribers.push(deps.registerResync("jobs", reconcile))
    } catch (error) {
      warn("registering the jobs resync failed", error)
    }
  }

  return {
    reconcile,
    stop() {
      stopped = true
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
    },
  }
}
