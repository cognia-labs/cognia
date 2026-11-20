/**
 * Bounded fan-out with real stops: run one async task per item, at most
 * `concurrency` at once, each under its own deadline.
 *
 * What a plain `Promise.race` timeout gets wrong is the slot. Racing a task
 * against a timer stops *waiting* for it, but the task keeps running, and a
 * pool that hands its slot to the next item then has more work in flight than
 * it promised. Here every task receives its own `AbortSignal`:
 *
 * - its deadline passing aborts that signal (reason: {@link TimeoutError});
 * - the caller's `signal` aborting aborts every running task's signal, and
 *   no item that has not started yet is started;
 * - a task keeps its slot until its promise settles. A task whose signal was
 *   aborted gets `stopGraceMs` to settle; if it is still running then, the
 *   slot is given back and the outcome says the stop was never confirmed
 *   (`stopped: false`), so the overrun is recorded rather than silent.
 *
 * Outcomes come back in item order. Pure: no logger, no clock beyond timers.
 */

import { TimeoutError } from "./with-timeout"

export interface BoundedFanOutOptions {
  /** Most tasks in flight at once (at least 1). */
  concurrency: number
  /** Per-task deadline in ms. `0` / absent: no deadline. */
  timeoutMs?: number
  /** Label for the {@link TimeoutError} a deadline raises. */
  timeoutLabel?: string
  /**
   * How long an aborted task may take to settle before its slot is given
   * back anyway. Default {@link DEFAULT_STOP_GRACE_MS}.
   */
  stopGraceMs?: number
  /** Stops the whole fan-out: running tasks are aborted, waiting ones never start. */
  signal?: AbortSignal
}

export type FanOutOutcome<R> =
  | { status: "fulfilled"; value: R }
  | {
      status: "rejected"
      error: unknown
      /** The task's own deadline passed. */
      timedOut: boolean
      /**
       * Whether the task has stopped. `false` only for an aborted task that
       * was still running when its grace ran out: its slot was given back,
       * its work may still be going.
       */
      stopped: boolean
    }
  /** Never started: the caller's signal aborted first. */
  | { status: "skipped" }

export const DEFAULT_STOP_GRACE_MS = 10_000

/** Run `task` over `items` within the bounds of `options`; never rejects. */
export async function boundedFanOut<T, R>(
  items: readonly T[],
  task: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  options: BoundedFanOutOptions
): Promise<Array<FanOutOutcome<R>>> {
  const outcomes = new Array<FanOutOutcome<R>>(items.length)
  const width = Math.max(1, Math.min(Math.floor(options.concurrency) || 1, items.length || 1))
  const grace = Math.max(0, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)
  const deadline =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 0
  let next = 0

  const runOne = async (index: number): Promise<void> => {
    const controller = new AbortController()
    const onParentAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", onParentAbort, { once: true })
    let timedOut = false
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    try {
      const work = Promise.resolve()
        .then(() => task(items[index] as T, index, controller.signal))
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error })
        )
        .finally(() => {
          settled = true
        })
      // Settles when the task does, or `grace` ms after its signal aborted.
      const released = new Promise<"settled" | "grace">((resolve) => {
        void work.then(() => resolve("settled"))
        const startGrace = () => {
          if (settled) return
          graceTimer = setTimeout(() => resolve("grace"), grace)
        }
        if (controller.signal.aborted) startGrace()
        else controller.signal.addEventListener("abort", startGrace, { once: true })
      })
      if (deadline > 0) {
        deadlineTimer = setTimeout(() => {
          if (settled) return
          timedOut = true
          controller.abort(new TimeoutError(options.timeoutLabel ?? "task", deadline))
        }, deadline)
      }
      const how = await released
      if (how === "grace") {
        outcomes[index] = {
          status: "rejected",
          error: controller.signal.reason,
          timedOut,
          stopped: false,
        }
        return
      }
      const result = await work
      if (controller.signal.aborted) {
        // An aborted task is a failure even when it answers anyway: the
        // caller stopped waiting for it, and its answer arrived too late.
        outcomes[index] = {
          status: "rejected",
          error: controller.signal.reason,
          timedOut,
          stopped: true,
        }
        return
      }
      outcomes[index] = result.ok
        ? { status: "fulfilled", value: result.value }
        : { status: "rejected", error: result.error, timedOut: false, stopped: true }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      options.signal?.removeEventListener("abort", onParentAbort)
    }
  }

  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      if (options.signal?.aborted) {
        outcomes[index] = { status: "skipped" }
        continue
      }
      await runOne(index)
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return outcomes
}
