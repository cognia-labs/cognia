/**
 * How often a background job's end may wake a session (ADR-0249 §4).
 *
 * A wake is a turn a session takes only because jobs ended: a derived input
 * under ADR-0252 §5, so it never goes ahead of a person. Each session gets
 * at most {@link WAKE_CAP_PER_HOUR} of them in any hour, and ends that land
 * within {@link WAKE_COALESCE_MS} of the first one are merged into one wake.
 *
 * Over the cap the ends wait. They go with the first boundary after a turn
 * the session takes for another reason (a person's message, a subagent's
 * result), and one notification says results are waiting. The budget check
 * is the caller's: a session whose budget is exhausted is not woken at all.
 *
 * Pure state per process: the renderer and the headless brain each keep one.
 */

export const WAKE_CAP_PER_HOUR = 6
export const WAKE_COALESCE_MS = 10_000
const HOUR_MS = 60 * 60 * 1000

export type WakeDecision =
  /** Wake now. */
  | { kind: "wake" }
  /** Still coalescing: try again after `waitMs`. */
  | { kind: "wait"; waitMs: number }
  /** Over the cap: leave the ends pending. `notify` is true once per episode. */
  | { kind: "over_cap"; notify: boolean }

interface SessionWakeState {
  wakes: number[]
  /** When the first end still waiting for a wake arrived. */
  windowStartedAt?: number
  /** When the cap first refused this episode, and whether it was announced. */
  blockedAt?: number
  announced?: boolean
  /** The last turn this session took for a reason other than a wake. */
  otherTurnAt?: number
}

export interface WakeLimiterOptions {
  capPerHour?: number
  coalesceMs?: number
}

export class WakeLimiter {
  private readonly sessions = new Map<string, SessionWakeState>()
  private readonly cap: number
  private readonly coalesceMs: number

  constructor(options: WakeLimiterOptions = {}) {
    this.cap = options.capPerHour ?? WAKE_CAP_PER_HOUR
    this.coalesceMs = options.coalesceMs ?? WAKE_COALESCE_MS
  }

  /** A job's end owed to the session arrived: start its coalescing window. */
  noteSettlement(sessionId: string, now: number): void {
    const state = this.state(sessionId)
    state.windowStartedAt ??= now
  }

  /** Whether ends waiting for this session may wake it now. */
  decide(sessionId: string, now: number): WakeDecision {
    const state = this.state(sessionId)
    // Ends found pending without an event (after a reload) open the window now.
    state.windowStartedAt ??= now
    const waitMs = state.windowStartedAt + this.coalesceMs - now
    if (waitMs > 0) return { kind: "wait", waitMs }
    state.wakes = state.wakes.filter((at) => now - at < HOUR_MS)
    if (state.wakes.length < this.cap) return { kind: "wake" }
    // A turn the session took for another reason since the cap refused it:
    // the waiting ends go with that turn's boundary.
    if (state.blockedAt !== undefined && (state.otherTurnAt ?? -Infinity) >= state.blockedAt) {
      return { kind: "wake" }
    }
    state.blockedAt ??= now
    const notify = !state.announced
    state.announced = true
    return { kind: "over_cap", notify }
  }

  /** A wake was accepted: count it, and close the window and any episode. */
  recordWake(sessionId: string, now: number): void {
    const state = this.state(sessionId)
    state.wakes.push(now)
    state.windowStartedAt = undefined
    state.blockedAt = undefined
    state.announced = false
  }

  /** The session took a turn that was not a wake. */
  noteOtherTurn(sessionId: string, now: number): void {
    this.state(sessionId).otherTurnAt = now
  }

  /** Nothing is waiting for the session any more. */
  clearWindow(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state) state.windowStartedAt = undefined
  }

  private state(sessionId: string): SessionWakeState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = { wakes: [] }
      this.sessions.set(sessionId, state)
    }
    return state
  }
}
