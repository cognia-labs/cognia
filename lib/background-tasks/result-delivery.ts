/**
 * Background results reach the conversation that is owed them: the one
 * delivery path (the OpenCode `resumeWhenIdle` pattern, ADR-0249).
 *
 * When a background `dispatch_agent` run settles, or a shell job or monitor
 * an agent started ends, its result is re-injected into the conversation as
 * a framed turn, so the model reacts without polling. Delivery follows the
 * steer-queue rule: a streaming conversation keeps it until its turn
 * settles, one that cannot be reached here keeps it until it can, and a
 * deleted conversation gets a notification only.
 *
 * Who starts the turn is a lane, one per host: the renderer's chat
 * controller (`hooks/chat/background-result-runtime.ts`) and the Host
 * brain's automated turn (`./host-delivery-lane.ts`). A lane says whether a
 * conversation can be reached and is idle, and sends.
 *
 * A turn taken only for job ends is a wake: a derived input, so a person's
 * queued turn still goes first (the steer drain runs before this one), and
 * it is bounded by the wake limiter (6 an hour, ends within 10 s merged) and
 * by the budget, which it never asks a person to raise. Over either, the
 * ends wait and one notification says so. Results owed alongside a run's
 * result go with it. Every job end is claimed from the supervisor first, so
 * two devices, or a device and the Host brain, never both deliver it.
 *
 * Durable state and reserved batch identity live on the journal row.
 * Delivery completes only after the lane's work ledger acknowledges
 * acceptance. Module-scope, so every caller in a process shares one queue.
 */

import type {
  BackgroundTaskJournalRecord,
  BackgroundTaskSettleInfo,
  BackgroundTaskStartMeta,
} from "@/lib/background-tasks/registry-core"
import {
  deliveryEntryFromJournal,
  formatElapsed,
  frameBackgroundResults,
  backgroundResultRunIds,
  type BackgroundResultDeliveryEntry,
} from "@/lib/background-tasks/completion-delivery"
import { isJobOutboxKind, supervisorIdOf } from "@/lib/background-tasks/job-settlement"
import { WakeLimiter } from "@/lib/background-tasks/wake-policy"
import { computeStableDigest } from "@/lib/ai/agent/execution/fingerprint"

/** The lane's send: inject the framed turn into a session. */
export type BackgroundReplaySend = (
  framedText: string,
  sessionId: string,
  deliveryId: string,
  personalRunIds?: readonly string[]
) => Promise<boolean>

/** Localized notification copy, supplied by the registering component. */
export interface BackgroundResultNotifyStrings {
  title: (p: { subagentId: string; status: "done" | "error"; elapsed: string }) => string
  body: (p: { runId: string }) => string
  /** Background job results wait: over the wake cap, or over budget. */
  wakeDeferredTitle?: (p: { count: number; reason: "cap" | "budget" }) => string
  wakeDeferredBody?: (p: { reason: "cap" | "budget" }) => string
}

/** What the job-result path reads from outside, swappable in tests. */
export interface BackgroundJobDeliveryDeps {
  now: () => number
  /** Whether a send now would exceed a budget ceiling (never asks anyone). */
  isBudgetExhausted: (projectId: string | undefined) => Promise<boolean>
  /**
   * Monitor ids among `ids` whose outcome a blocking `Monitor` call already
   * returned (the supervisor marks it under the settle lock, but a wait that
   * raced the settle marks it after the event went out).
   */
  inlineMonitors: (sessionId: string, ids: readonly string[]) => Promise<Set<string>>
  /**
   * Take the delivery of a job's or monitor's end from the supervisor. Two
   * paired devices (or a window and a Host brain) may both hear one end, each
   * with its own outbox, and only the claimant delivers it.
   */
  claimDelivery: (kind: "job" | "monitor", id: string) => Promise<boolean>
  schedule: (run: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
}

/**
 * Who starts a delivery turn on this host. `isReachable` covers whatever lets
 * the host take a turn there now (an open tab, a pane, a background hold, a
 * conversation the Host owns); `consumerId` is the id this host claims job
 * ends under, stable across restarts and distinct per device.
 */
export interface BackgroundDeliveryLane {
  isReachable(sessionId: string): boolean | Promise<boolean>
  isIdle(sessionId: string): boolean | Promise<boolean>
  send: BackgroundReplaySend
  consumerId(): string
}

let lane: BackgroundDeliveryLane | undefined
let notifyStrings: BackgroundResultNotifyStrings | undefined
/** In-memory pending queue: parentSessionId → runId → entry. */
const pendingBySession = new Map<string, Map<string, BackgroundResultDeliveryEntry>>()
const deliveryLocks = new Set<string>()
let wakeLimiter = new WakeLimiter()
/** Sessions whose latest accepted turn was a wake: its settle is not "another reason". */
const wakesInFlight = new Set<string>()
const wakeTimers = new Map<string, unknown>()
let jobDeps: BackgroundJobDeliveryDeps = defaultJobDeps()

function defaultJobDeps(): BackgroundJobDeliveryDeps {
  return {
    now: Date.now,
    isBudgetExhausted: async (projectId) => {
      const { isCostBudgetConfigured, isCostBudgetExhausted } =
        await import("@/lib/usage/cost-budget-gate")
      if (!isCostBudgetConfigured()) return false
      return isCostBudgetExhausted(projectId ? { projectId } : {})
    },
    inlineMonitors: async (sessionId, ids) => {
      const { listBackgroundJobSettlements } = await import("@/lib/jobs/background-jobs")
      const { monitors } = await listBackgroundJobSettlements({ sessionId })
      const wanted = new Set(ids)
      return new Set(
        monitors
          .filter((monitor) => wanted.has(monitor.id) && monitor.delivery?.state === "inline")
          .map((monitor) => monitor.id)
      )
    },
    claimDelivery: async (kind, id) => {
      const { claimBackgroundJobDelivery } = await import("@/lib/jobs/background-jobs")
      const consumer = lane?.consumerId()
      if (!consumer) throw new Error("No delivery lane to claim for")
      return claimBackgroundJobDelivery({ kind, id, consumer })
    },
    schedule: (run, ms) => setTimeout(run, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

/** Test-only: replace what the job-result path reads from outside. */
export function __setBackgroundJobDeliveryDepsForTesting(
  deps: Partial<BackgroundJobDeliveryDeps>
): void {
  jobDeps = { ...defaultJobDeps(), ...deps }
}

/** Register this host's delivery lane (returns an unregister). */
export function registerBackgroundDeliveryLane(next: BackgroundDeliveryLane): () => void {
  lane = next
  return () => {
    if (lane === next) lane = undefined
  }
}

/** Register localized notification copy (boot initializer). */
export function registerBackgroundResultNotifyStrings(
  strings: BackgroundResultNotifyStrings
): () => void {
  notifyStrings = strings
  return () => {
    if (notifyStrings === strings) notifyStrings = undefined
  }
}

export function __resetBackgroundResultRuntimeForTesting(): void {
  lane = undefined
  notifyStrings = undefined
  pendingBySession.clear()
  deliveryLocks.clear()
  for (const handle of wakeTimers.values()) jobDeps.cancel(handle)
  wakeTimers.clear()
  wakesInFlight.clear()
  wakeLimiter = new WakeLimiter()
  jobDeps = defaultJobDeps()
}

/**
 * Settle listener for the renderer background registry (wired by the boot
 * initializer via `setRendererBackgroundSettleListener`). Terminal journal
 * settlement already marked the result pending; notify and attempt delivery.
 */
export function onBackgroundRunSettled(
  runId: string,
  meta: BackgroundTaskStartMeta,
  settle: BackgroundTaskSettleInfo
): void {
  if (meta.kind !== "subagent" || meta.host !== "renderer") return
  const entry = deliveryEntryFromJournal({
    runId,
    subagentId: meta.subagentId,
    status: settle.status,
    startedAt: meta.startedAt,
    settledAt: settle.settledAt,
    ...(settle.resultText !== undefined ? { resultText: settle.resultText } : {}),
    ...(settle.error !== undefined ? { error: settle.error } : {}),
  })
  if (!entry) return
  let bucket = pendingBySession.get(meta.sessionId)
  if (!bucket) {
    bucket = new Map()
    pendingBySession.set(meta.sessionId, bucket)
  }
  bucket.set(runId, entry)
  void fireCompletionNotification(runId, meta, entry)
  void attemptBackgroundResultDelivery(meta.sessionId)
}

/**
 * A background shell's or monitor's end reached this window (ADR-0249): from
 * `jobs://exited` / `jobs://monitor-fired`, an in-process shell's
 * `background_job_settled` frame, or reconciliation. Records it in the
 * outbox (idempotent by job id, so a repeat changes nothing) and, when the
 * conversation is owed it, opens the session's coalescing window.
 */
export async function onBackgroundJobSettled(record: BackgroundTaskJournalRecord): Promise<void> {
  if (!isJobOutboxKind(record.kind) || !record.sessionId) return
  let stored = record
  try {
    const { upsertBackgroundJobSettlement } = await import("@/lib/db/background-tasks")
    stored = (await upsertBackgroundJobSettlement(record)).record
  } catch {
    // Storage refused: the supervisor still has the end, and the next
    // reconciliation writes it.
    return
  }
  if (stored.deliveryState !== "pending" || stored.deliveredAt !== undefined) return
  wakeLimiter.noteSettlement(stored.sessionId, jobDeps.now())
  void attemptBackgroundResultDelivery(stored.sessionId)
}

/**
 * Drain a session's pending background results when it is open + idle. Called
 * from the chat hook at turn settle (AFTER the steer drain — a steer replay
 * that starts a new turn simply defers this to the next settle) and when a
 * session (re)opens. `turnSettled` says a turn just ended: unless it was a
 * wake, it was a turn taken for another reason, which lets job results the
 * wake cap held back go with this boundary.
 */
export function maybeDrainBackgroundResults(
  sessionId: string,
  options: { turnSettled?: boolean } = {}
): void {
  if (options.turnSettled) {
    if (wakesInFlight.has(sessionId)) wakesInFlight.delete(sessionId)
    else wakeLimiter.noteOtherTurn(sessionId, jobDeps.now())
  }
  void attemptBackgroundResultDelivery(sessionId)
}

/**
 * Deliver every pending entry for the session as ONE framed turn. Per-session
 * mutex; leaves entries pending when the parent is busy/closed or no send is
 * registered; marks them orphaned when the parent session no longer exists.
 */
export async function attemptBackgroundResultDelivery(sessionId: string): Promise<void> {
  if (!sessionId || deliveryLocks.has(sessionId)) return
  deliveryLocks.add(sessionId)
  try {
    let entries = await collectDeliverable(sessionId)
    if (entries.length === 0) {
      wakeLimiter.clearWindow(sessionId)
      return
    }

    const session = await readSession(sessionId)
    if (!session) {
      pendingBySession.delete(sessionId)
      await markDeliveryState(
        entries.map((e) => e.runId),
        "orphaned"
      )
      return
    }

    const current = lane
    if (!current) return
    if (!(await current.isReachable(sessionId)) || !(await current.isIdle(sessionId))) return
    const send = current.send

    entries = await dropInlineMonitors(sessionId, entries)
    if (entries.length === 0) return
    entries = await keepClaimedJobEnds(sessionId, entries)
    if (entries.length === 0) return
    // Only job ends are owed: taking a turn for them is a wake.
    const wake = entries.every((entry) => entry.job)
    if (wake && !(await admitWake(sessionId, entries.length, session))) return

    const { reserveBackgroundTaskDelivery } = await import("@/lib/db/background-tasks")
    const proposedId = computeStableDigest("background-result-delivery-v1", {
      sessionId,
      runIds: entries.map((entry) => entry.runId).sort(),
    })
    const batch = await reserveBackgroundTaskDelivery(
      sessionId,
      entries.map((entry) => entry.runId),
      proposedId
    )
    if (!batch) return
    const runIds = new Set(batch.runIds)
    const { childJobExecutionRunId } = await import("@/lib/execution/launch-child-run")
    const batchEntries = entries.filter((entry) => runIds.has(entry.runId))
    // A job entry is not a run: only run results name the runs the turn answers.
    const runResults = batchEntries.filter((entry) => !entry.job)
    const accepted = await send(
      frameBackgroundResults(batchEntries),
      sessionId,
      batch.deliveryId,
      backgroundResultRunIds(runResults).map(childJobExecutionRunId)
    )
    if (!accepted) return
    if (wake) {
      wakeLimiter.recordWake(sessionId, jobDeps.now())
      wakesInFlight.add(sessionId)
    }
    // Only remove the batch acknowledged by this receipt; another completion
    // may have arrived while the controller prepared and accepted the turn.
    const pending = pendingBySession.get(sessionId)
    for (const runId of runIds) pending?.delete(runId)
    if (pending?.size === 0) pendingBySession.delete(sessionId)
    await markDeliveryState(batch.runIds, "delivered")
  } catch {
    // Refusal or storage failure leaves the durable batch pending for a later
    // drain with the same identity. No provider acceptance is inferred.
  } finally {
    deliveryLocks.delete(sessionId)
  }
}

/**
 * Whether a turn taken only for job ends may start now. Waits out the
 * coalescing window (a timer retries), refuses over the cap or over budget,
 * and says once per episode that results are waiting.
 */
async function admitWake(
  sessionId: string,
  count: number,
  session: { projectId?: string }
): Promise<boolean> {
  const decision = wakeLimiter.decide(sessionId, jobDeps.now())
  if (decision.kind === "wait") {
    scheduleWakeRetry(sessionId, decision.waitMs)
    return false
  }
  if (decision.kind === "over_cap") {
    if (decision.notify) void fireWakeDeferredNotification(sessionId, count, "cap")
    return false
  }
  if (await jobDeps.isBudgetExhausted(session.projectId)) {
    void fireWakeDeferredNotification(sessionId, count, "budget")
    return false
  }
  return true
}

function scheduleWakeRetry(sessionId: string, waitMs: number): void {
  const previous = wakeTimers.get(sessionId)
  if (previous !== undefined) jobDeps.cancel(previous)
  wakeTimers.set(
    sessionId,
    jobDeps.schedule(() => {
      wakeTimers.delete(sessionId)
      void attemptBackgroundResultDelivery(sessionId)
    }, waitMs)
  )
}

/**
 * Re-check monitor ends before delivering them: one whose outcome a blocking
 * call returned is marked skipped and left out.
 */
async function dropInlineMonitors(
  sessionId: string,
  entries: BackgroundResultDeliveryEntry[]
): Promise<BackgroundResultDeliveryEntry[]> {
  const monitors = entries.filter((entry) => entry.job?.kind === "monitor")
  if (monitors.length === 0) return entries
  let inline: Set<string>
  try {
    inline = await jobDeps.inlineMonitors(
      sessionId,
      monitors.map(
        (entry) => entry.jobId ?? supervisorIdOf({ runId: entry.runId, kind: "monitor" })
      )
    )
  } catch {
    // The supervisor is unreachable: the event said the outcome is owed.
    return entries
  }
  const skipped = monitors.filter((entry) => inline.has(entry.jobId ?? ""))
  if (skipped.length === 0) return entries
  const ids = new Set(skipped.map((entry) => entry.runId))
  const pending = pendingBySession.get(sessionId)
  for (const runId of ids) pending?.delete(runId)
  await markDeliveryState([...ids], "skipped")
  return entries.filter((entry) => !ids.has(entry.runId))
}

/**
 * Keep the job ends this consumer holds the delivery of. An end another
 * device or the Host brain claimed is theirs: it is marked skipped here. A
 * claim that cannot be read leaves the end pending for a later drain.
 */
async function keepClaimedJobEnds(
  sessionId: string,
  entries: BackgroundResultDeliveryEntry[]
): Promise<BackgroundResultDeliveryEntry[]> {
  const jobs = entries.filter((entry) => entry.job)
  if (jobs.length === 0) return entries
  const verdicts = await Promise.all(
    jobs.map(async (entry) => {
      const kind = entry.job!.kind === "monitor" ? ("monitor" as const) : ("job" as const)
      const id = entry.jobId ?? supervisorIdOf({ runId: entry.runId, kind: entry.job!.kind })
      try {
        return { entry, claimed: await jobDeps.claimDelivery(kind, id) }
      } catch {
        return { entry, claimed: null }
      }
    })
  )
  const elsewhere = verdicts.filter((verdict) => verdict.claimed === false)
  if (elsewhere.length > 0) {
    const pending = pendingBySession.get(sessionId)
    for (const { entry } of elsewhere) pending?.delete(entry.runId)
    await markDeliveryState(
      elsewhere.map(({ entry }) => entry.runId),
      "skipped"
    )
  }
  const unread = new Set(
    verdicts.filter((verdict) => verdict.claimed === null).map(({ entry }) => entry.runId)
  )
  const lost = new Set(elsewhere.map(({ entry }) => entry.runId))
  return entries.filter((entry) => !lost.has(entry.runId) && !unread.has(entry.runId))
}

/** Union of the in-memory queue and journal `pending` rows (in-memory wins). */
async function collectDeliverable(sessionId: string): Promise<BackgroundResultDeliveryEntry[]> {
  const byRunId = new Map<string, BackgroundResultDeliveryEntry>()
  const rows = await readJournalRows(sessionId)
  const completed = new Set(
    rows
      .filter((row) => row.deliveryState && row.deliveryState !== "pending")
      .map((row) => row.runId)
  )
  for (const record of rows) {
    const entry = record.deliveryState === "pending" ? deliveryEntryFromJournal(record) : null
    if (entry) byRunId.set(record.runId, entry)
  }
  for (const [runId, entry] of pendingBySession.get(sessionId) ?? []) {
    if (completed.has(runId)) pendingBySession.get(sessionId)?.delete(runId)
    else byRunId.set(runId, entry)
  }
  return [...byRunId.values()]
}

async function readJournalRows(sessionId: string): Promise<BackgroundTaskJournalRecord[]> {
  try {
    const { listBackgroundTaskRecords } = await import("@/lib/db/background-tasks")
    const rows = await listBackgroundTaskRecords({ host: "renderer" })
    return rows.filter(
      (row) =>
        row.sessionId === sessionId &&
        (row.kind === "subagent" || isJobOutboxKind(row.kind)) &&
        (row.status === "done" || row.status === "error")
    )
  } catch {
    return []
  }
}

async function readSession(
  sessionId: string
): Promise<{ id: string; projectId?: string } | undefined> {
  try {
    const { getSession } = await import("@/lib/db/sessions")
    return await getSession(sessionId)
  } catch {
    // If the session table is unreadable, err on the side of keeping entries
    // pending rather than marking them orphaned.
    return { id: sessionId }
  }
}

async function markDeliveryState(
  runIds: string[],
  deliveryState: "pending" | "delivered" | "orphaned" | "skipped"
): Promise<void> {
  try {
    const { updateBackgroundTaskRecord } = await import("@/lib/db/background-tasks")
    const deliveredAt = deliveryState === "delivered" ? { deliveredAt: Date.now() } : {}
    await Promise.all(
      runIds.map((runId) => updateBackgroundTaskRecord(runId, { deliveryState, ...deliveredAt }))
    )
  } catch {
    // Best-effort durable mirror; the in-memory queue already drove delivery.
  }
}

async function fireCompletionNotification(
  runId: string,
  meta: BackgroundTaskStartMeta,
  entry: BackgroundResultDeliveryEntry
): Promise<void> {
  try {
    const { notify } = await import("@/lib/notifications/runtime")
    const elapsed = formatElapsed(entry.settledAt - entry.startedAt)
    const strings = notifyStrings
    const title = strings
      ? strings.title({ subagentId: meta.subagentId, status: entry.status, elapsed })
      : `Background subagent "${meta.subagentId}" ${entry.status === "done" ? "finished" : "failed"} (${elapsed})`
    const body = strings ? strings.body({ runId }) : `Run ${runId}`
    await notify({
      source: "session",
      level: entry.status === "done" ? "success" : "error",
      title,
      body,
      channels: ["center", "toast"],
      groupKey: runId,
      sourceRef: { kind: "background-run", id: runId },
      directed: true,
    })
  } catch {
    // Notifications are best-effort; delivery/journal state is unaffected.
  }
}

async function fireWakeDeferredNotification(
  sessionId: string,
  count: number,
  reason: "cap" | "budget"
): Promise<void> {
  try {
    const { notify } = await import("@/lib/notifications/runtime")
    const strings = notifyStrings
    await notify({
      source: "session",
      level: "info",
      title:
        strings?.wakeDeferredTitle?.({ count, reason }) ??
        `${count} background job result(s) are waiting`,
      body:
        strings?.wakeDeferredBody?.({ reason }) ??
        (reason === "cap"
          ? "They will reach the conversation with its next turn."
          : "The spending limit is reached, so the conversation was not started for them."),
      channels: ["center", "toast"],
      groupKey: `background-wake:${sessionId}`,
      dedupeKey: `background-wake:${sessionId}:${reason}`,
      sourceRef: { kind: "session", id: sessionId },
      directed: true,
    })
  } catch {
    // Notifications are best-effort; the results stay pending either way.
  }
}
