import { useCallback, useEffect, useRef, useState } from "react"
import type { Dispatch } from "react"
import {
  deliveryEntryFromJournal,
  formatElapsed,
  frameBackgroundResults,
  type BackgroundResultDeliveryEntry,
} from "@/lib/background-tasks/completion-delivery"
import {
  jobExitFromSettledFrame,
  outboxRecordFromJobExit,
} from "@/lib/background-tasks/job-settlement"
import { WakeLimiter } from "@/lib/background-tasks/wake-policy"
import { onClaudeMessage } from "@/lib/claude/ipc"
import {
  listPendingCliBackgroundDeliveries,
  markCliBackgroundDelivery,
  recordCliBackgroundJobSettlement,
  subscribeCliBackgroundSettle,
  type CliBackgroundSettleEvent,
} from "../../../agent/subagent-background-tasks"
import type { TuiAction } from "../../state/types"

/**
 * Background-run completion delivery for the TUI (the OpenCode `resumeWhenIdle`
 * pattern, the desktop twin is `hooks/chat/background-result-runtime.ts`).
 *
 * When a background sub-agent this chat session started settles, its outcome
 * is queued here and re-injected into the session as ONE framed turn, so the
 * model reacts to the result without polling `dispatch_agent({collect})`:
 *
 *  - session idle ⇒ delivered right away (a fresh turn on the model's behalf).
 *  - a turn or goal/loop run in flight ⇒ stays queued, drained at the next
 *    turn boundary (after any `btw` steer, `takeBackgroundResults` is the
 *    drain the plain-turn sender calls).
 *  - results left `pending` in the journal by an earlier process are picked
 *    up at boot so a resumed session still hears about them.
 *
 * A background shell's end (ADR-0249) arrives as the sidecar's
 * `background_job_settled` frame (the CLI runs shells in-process) and joins
 * the same queue. A turn taken only for shell ends is a wake: it waits out a
 * 10 s coalescing window and the hourly cap of the shared wake limiter, and
 * never runs at a turn boundary on its own (the boundary's drain leaves it to
 * the next idle edge, where the limiter decides). Over the cap one notice
 * says results wait; they go with the first idle edge after a turn taken for
 * another reason. The CLI enforces no cost budget, so none is checked here.
 *
 * `settleSeq` bumps on EVERY settlement the session owns (delivered or not) so
 * footer counters that read the process-global registry can recompute.
 */
export interface UseBackgroundResultsDeps {
  sessionId: string
  home?: string
  dispatch: Dispatch<TuiAction>
  /** The session can accept an injected turn right now (idle, no run driver, not copilot). */
  idle: boolean
  /** Inject the framed turn (App owns `agent.send` + the follow-up drain). */
  deliver: (framedText: string) => Promise<void>
  /** Injection seams for tests, production reads the CLI registry. */
  subscribe?: typeof subscribeCliBackgroundSettle
  listPending?: typeof listPendingCliBackgroundDeliveries
  markDelivery?: typeof markCliBackgroundDelivery
  /** Sidecar frames (`claude://message`), where in-process shell ends arrive. */
  subscribeFrames?: (handler: (frame: unknown) => void) => () => void
  recordJob?: typeof recordCliBackgroundJobSettlement
  now?: () => number
}

function subscribeSidecarFrames(handler: (frame: unknown) => void): () => void {
  let unlisten: (() => void) | undefined
  let stopped = false
  void onClaudeMessage((frame) => handler(frame))
    .then((stop) => {
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => undefined)
  return () => {
    stopped = true
    unlisten?.()
  }
}

export interface UseBackgroundResultsApi {
  /** Frame + clear every queued result (null when nothing is queued). */
  takeBackgroundResults: () => string | null
  /** Queued results not yet injected. */
  pendingCount: number
  /** Monotonic: bumps on each settlement this session owns. */
  settleSeq: number
}

/** Notice line for a settlement (the model-facing text is framed separately). */
export function backgroundSettleNotice(
  event: Pick<CliBackgroundSettleEvent, "subagentId" | "status" | "startedAt" | "settledAt">,
  idle: boolean
): string {
  const elapsed = formatElapsed(event.settledAt - event.startedAt)
  const tail = idle
    ? "delivering the result to the model."
    : "result queued, delivered at the next turn boundary."
  return `⏺ Background subagent "${event.subagentId}" ${event.status} in ${elapsed}: ${tail}`
}

/** Notice line for a background shell's end. */
export function backgroundShellNotice(entry: BackgroundResultDeliveryEntry): string {
  const job = entry.job
  const elapsed = formatElapsed(entry.settledAt - entry.startedAt)
  const outcome =
    job?.kind === "shell-job" && job.status === "exited"
      ? `exited with code ${job.exitCode ?? "unknown"}`
      : "ended"
  return `⏺ Background shell ${entry.jobId ?? entry.runId} ${outcome} in ${elapsed}: result queued for the model.`
}

/** Shown once when the wake cap holds shell results back. */
export const BACKGROUND_WAKE_CAP_NOTICE =
  "⏺ Background shell results are waiting: this session was woken often this hour. They reach the model after your next turn."

export function useBackgroundResults(deps: UseBackgroundResultsDeps): UseBackgroundResultsApi {
  const {
    sessionId,
    home,
    dispatch,
    idle,
    deliver,
    subscribe = subscribeCliBackgroundSettle,
    listPending = listPendingCliBackgroundDeliveries,
    markDelivery = markCliBackgroundDelivery,
    subscribeFrames = subscribeSidecarFrames,
    recordJob = recordCliBackgroundJobSettlement,
    now = Date.now,
  } = deps
  const queue = useRef(new Map<string, BackgroundResultDeliveryEntry>())
  const delivering = useRef(false)
  const limiter = useRef(new WakeLimiter())
  /** The turn in flight was a wake: its boundary is not "another reason". */
  const wakeInFlight = useRef(false)
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The latest `attemptDelivery`, for the coalescing timer to retry with. */
  const retryDelivery = useRef<() => Promise<void>>(async () => undefined)
  // Latest idle flag + deliver for the settle listener (component `idle` is
  // only the snapshot at render time, the listener fires from the registry).
  const idleRef = useRef(idle)
  const deliverRef = useRef(deliver)
  useEffect(() => {
    idleRef.current = idle
    deliverRef.current = deliver
  }, [idle, deliver])
  const [pendingCount, setPendingCount] = useState(0)
  const [settleSeq, setSettleSeq] = useState(0)

  const frameQueued = useCallback((): string | null => {
    if (queue.current.size === 0) return null
    const entries = [...queue.current.values()]
    queue.current.clear()
    setPendingCount(0)
    limiter.current.clearWindow(sessionId)
    void markDelivery(
      entries.map((entry) => entry.runId),
      "delivered",
      home
    )
    return frameBackgroundResults(entries)
  }, [markDelivery, home, sessionId])

  const onlyShellEnds = () => [...queue.current.values()].every((entry) => entry.job)

  /**
   * The turn-boundary drain. A run's result is taken here; shell ends alone
   * wait for the idle edge, where the wake limiter decides.
   */
  const takeBackgroundResults = useCallback((): string | null => {
    const wakeBoundary = wakeInFlight.current
    wakeInFlight.current = false
    if (!wakeBoundary) limiter.current.noteOtherTurn(sessionId, now())
    if (queue.current.size === 0 || onlyShellEnds()) return null
    return frameQueued()
  }, [frameQueued, sessionId, now])

  // Per-session mutex: one injected turn at a time, a result that lands while
  // the injected turn streams is picked up by that turn's follow-up drain.
  const attemptDelivery = useCallback(async (): Promise<void> => {
    if (delivering.current || !idleRef.current || queue.current.size === 0) return
    const wake = onlyShellEnds()
    if (wake) {
      const decision = limiter.current.decide(sessionId, now())
      if (decision.kind === "wait") {
        if (wakeTimer.current) clearTimeout(wakeTimer.current)
        wakeTimer.current = setTimeout(() => {
          wakeTimer.current = null
          void retryDelivery.current()
        }, decision.waitMs)
        return
      }
      if (decision.kind === "over_cap") {
        if (decision.notify) dispatch({ type: "NOTICE", message: BACKGROUND_WAKE_CAP_NOTICE })
        return
      }
    }
    delivering.current = true
    try {
      const framed = frameQueued()
      if (framed === null) return
      if (wake) {
        limiter.current.recordWake(sessionId, now())
        wakeInFlight.current = true
      }
      await deliverRef.current(framed)
    } finally {
      delivering.current = false
    }
  }, [frameQueued, sessionId, now, dispatch])
  useEffect(() => {
    retryDelivery.current = attemptDelivery
  }, [attemptDelivery])

  useEffect(
    () => () => {
      if (wakeTimer.current) clearTimeout(wakeTimer.current)
    },
    []
  )

  const enqueue = useCallback(
    (entries: readonly BackgroundResultDeliveryEntry[]) => {
      for (const entry of entries) {
        // A live settlement wins over the journal copy of the same run.
        queue.current.set(entry.runId, entry)
      }
      setPendingCount(queue.current.size)
      void attemptDelivery()
    },
    [attemptDelivery]
  )

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.sessionId !== sessionId) return
      setSettleSeq((n) => n + 1)
      if (event.kind !== "subagent" || !event.entry) return
      dispatch({
        type: "NOTICE",
        message: backgroundSettleNotice(event, idleRef.current),
        ...(event.status === "done" ? {} : { severity: "warn" as const }),
      })
      void markDelivery([event.runId], "pending", event.home ?? home)
      enqueue([event.entry])
    })
    return unsubscribe
  }, [subscribe, sessionId, dispatch, markDelivery, home, enqueue])

  // In-process shell ends this session's agent started (ADR-0249).
  useEffect(() => {
    return subscribeFrames((frame) => {
      const exit = jobExitFromSettledFrame(frame)
      if (!exit || exit.delivery?.sessionId !== sessionId) return
      const record = outboxRecordFromJobExit(exit, "cli")
      if (!record) return
      setSettleSeq((n) => n + 1)
      void recordJob(record, home)
      if (record.deliveryState !== "pending") return
      const entry = deliveryEntryFromJournal(record)
      if (!entry) return
      dispatch({ type: "NOTICE", message: backgroundShellNotice(entry) })
      limiter.current.noteSettlement(sessionId, now())
      enqueue([entry])
    })
  }, [subscribeFrames, sessionId, recordJob, home, dispatch, now, enqueue])

  // Boot: results an earlier process settled but never delivered.
  useEffect(() => {
    let cancelled = false
    void listPending({ home, owner: sessionId })
      .then((entries) => {
        if (cancelled || entries.length === 0) return
        // Do not clobber a live settlement that raced the journal read.
        enqueue(entries.filter((entry) => !queue.current.has(entry.runId)))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [listPending, home, sessionId, enqueue])

  // A run that settled mid-turn is delivered as soon as the session goes idle
  // (covers a goal/loop driver ending without a plain-turn drain).
  useEffect(() => {
    if (idle) void attemptDelivery()
  }, [idle, attemptDelivery])

  return { takeBackgroundResults, pendingCount, settleSeq }
}
