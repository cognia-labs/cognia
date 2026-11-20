// Run admission for `run_code` (ADR-0117 Phase 4, CM-11).
//
// The per-run budgets bound one program. These bound how many programs run at
// once: one sidecar serves every session on its Host, and each program is a
// confined child plus its RSS sampling and IPC traffic. A session runs its
// programs one after another; the Host runs at most a handful at a time.
//
// Waiters are served in arrival order, but one held back only by its own
// session's limit never blocks another session's waiter behind it. Waiting is
// bounded and follows the turn's signal, so a queued program never outlives
// the turn that asked for it.

/** The limits admission reads; `lib/ai/code-mode/limits.json` supplies them. */
export interface RunAdmissionLimits {
  maxConcurrentRunsPerSession: number
  maxConcurrentRunsPerHost: number
  maxAdmissionWaitMs: number
}

/** The concurrency ceiling a refused waiter was held back by. */
export interface RunAdmissionLimit {
  kind: "concurrent-runs-session" | "concurrent-runs-host"
  limit: number
}

export type RunAdmission =
  | { ok: true; release: () => void }
  | { ok: false; reason: "cancelled" }
  | { ok: false; reason: "busy"; limit: RunAdmissionLimit }

export interface RunAdmissionRequest {
  /** Absent for a caller with no session; only the Host limit applies then. */
  sessionId?: string | undefined
  signal?: AbortSignal | undefined
  limits: RunAdmissionLimits
}

export type RunAdmissionGate = (request: RunAdmissionRequest) => Promise<RunAdmission>

interface Waiter {
  sessionId: string | undefined
  limits: RunAdmissionLimits
  settle: (admission: RunAdmission) => void
}

/** A fresh admission table; the sidecar uses one, tests make their own. */
export function createRunAdmission() {
  let hostRunning = 0
  const sessionRunning = new Map<string, number>()
  const waiters: Waiter[] = []

  const sessionCount = (sessionId: string | undefined) =>
    sessionId === undefined ? 0 : (sessionRunning.get(sessionId) ?? 0)

  /** The limit that holds this waiter back right now, or null when it fits. */
  function blockedBy(sessionId: string | undefined, limits: RunAdmissionLimits) {
    if (sessionId !== undefined && sessionCount(sessionId) >= limits.maxConcurrentRunsPerSession) {
      return {
        kind: "concurrent-runs-session",
        limit: limits.maxConcurrentRunsPerSession,
      } as const
    }
    if (hostRunning >= limits.maxConcurrentRunsPerHost) {
      return { kind: "concurrent-runs-host", limit: limits.maxConcurrentRunsPerHost } as const
    }
    return null
  }

  function start(sessionId: string | undefined): () => void {
    hostRunning += 1
    if (sessionId !== undefined) sessionRunning.set(sessionId, sessionCount(sessionId) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      hostRunning = Math.max(0, hostRunning - 1)
      if (sessionId !== undefined) {
        const next = sessionCount(sessionId) - 1
        if (next > 0) sessionRunning.set(sessionId, next)
        else sessionRunning.delete(sessionId)
      }
      admitWaiting()
    }
  }

  function admitWaiting() {
    for (let index = 0; index < waiters.length;) {
      const waiter = waiters[index]!
      if (blockedBy(waiter.sessionId, waiter.limits)) {
        index += 1
        continue
      }
      waiters.splice(index, 1)
      waiter.settle({ ok: true, release: start(waiter.sessionId) })
    }
  }

  const acquire: RunAdmissionGate = ({ sessionId, signal, limits }) => {
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "cancelled" })
    // Every release re-runs admission, so whoever still waits is held back.
    // A newcomer that fits may start, unless its own session already has a
    // program waiting: a session's programs start in the order it asked.
    const sessionQueued = waiters.some((waiter) => waiter.sessionId === sessionId)
    if (!sessionQueued && !blockedBy(sessionId, limits)) {
      return Promise.resolve({ ok: true, release: start(sessionId) })
    }
    return new Promise<RunAdmission>((resolve) => {
      // `timer` and `onAbort` are bound before the waiter is queued or the
      // listener added, so nothing calls `leave` before they exist.
      const leave = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const waiter: Waiter = {
        sessionId,
        limits,
        settle: (admission) => {
          leave()
          resolve(admission)
        },
      }
      const onAbort = () => waiter.settle({ ok: false, reason: "cancelled" })
      const timer = setTimeout(() => {
        const limit = blockedBy(sessionId, limits) ?? {
          kind: "concurrent-runs-host" as const,
          limit: limits.maxConcurrentRunsPerHost,
        }
        waiter.settle({ ok: false, reason: "busy", limit })
      }, limits.maxAdmissionWaitMs)
      timer.unref?.()
      signal?.addEventListener("abort", onAbort, { once: true })
      waiters.push(waiter)
    })
  }

  return {
    acquire,
    /** Programs running now, for tests and diagnostics. */
    running: () => ({ host: hostRunning, sessions: new Map(sessionRunning) }),
    waiting: () => waiters.length,
  }
}

/** This sidecar's admission table: one sidecar serves one Host. */
export const runAdmission = createRunAdmission()
