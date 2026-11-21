/**
 * Room hand-offs are reported however their Squad run ended (ADR-0252 §4).
 *
 * The attempt a host launched reports itself when its outcome settles, but
 * only while that host runs. At start this finds every recent attempt that
 * ended with no entry (the host stopped between the run's end and its
 * outbox entry), and whenever a Squad run ends here it looks again, so a
 * retry launched from the run's card reaches the room without a restart.
 * Scans never overlap: one asked for while another runs waits for it.
 */

const MAX_RECONCILE_RETRIES = 4
const BASE_RETRY_DELAY_MS = 1_000

export interface ReconcileRuntimeOptions {
  retryDelayMs?: number
  maxRetries?: number
}

export async function start(options: ReconcileRuntimeOptions = {}): Promise<() => void> {
  const [settleMod, { onSquadRunEnded }] = await Promise.all([
    import("./settle"),
    import("../squad/squad-lifecycle-runner"),
  ])
  const maxRetries = options.maxRetries ?? MAX_RECONCILE_RETRIES
  const baseDelayMs = options.retryDelayMs ?? BASE_RETRY_DELAY_MS
  let stopped = false
  let retryAttempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let tail: Promise<void> = Promise.resolve()

  const clearRetryTimer = () => {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  const scheduleRetry = () => {
    if (stopped || retryTimer !== undefined || retryAttempts >= maxRetries) return
    const delay = baseDelayMs * 2 ** retryAttempts
    retryAttempts += 1
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (!stopped) void reconcile(false)
    }, delay)
    retryTimer.unref?.()
  }

  const reconcile = (resetBackoff = true): Promise<void> => {
    if (resetBackoff) {
      retryAttempts = 0
      clearRetryTimer()
    }
    tail = tail.then(async () => {
      if (stopped) return
      try {
        if (typeof settleMod.reconcileRoomHandoffsWithStatus === "function") {
          const { pendingRetry } = await settleMod.reconcileRoomHandoffsWithStatus()
          if (pendingRetry > 0) scheduleRetry()
          else retryAttempts = 0
        } else {
          await settleMod.reconcileRoomHandoffs()
          retryAttempts = 0
        }
      } catch (error: unknown) {
        console.warn("room hand-off reconciliation failed", error)
        scheduleRetry()
      }
    })
    return tail
  }
  const unsubscribe = onSquadRunEnded(() => {
    void reconcile(true)
  })
  await reconcile(true)
  return () => {
    stopped = true
    clearRetryTimer()
    unsubscribe()
  }
}
