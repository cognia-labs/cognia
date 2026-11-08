import { loggers } from "@cognia/logging"

export type PendingAccountWriteFlusher = (signal: AbortSignal) => Promise<void>

// Give debounced local edits time to commit, but never let storage prevent a
// security lock. All writers share this 1.5 s budget, rather than one per writer.
export const ACCOUNT_WRITE_FLUSH_TIMEOUT_MS = 1_500

const flushers = new Set<PendingAccountWriteFlusher>()

/** Register while the owner is attached to its account database. */
export function registerPendingAccountWriteFlusher(
  flusher: PendingAccountWriteFlusher
): () => void {
  flushers.add(flusher)
  return () => {
    flushers.delete(flusher)
  }
}

/** No owners means revocation can retain its synchronous fast path. */
export function flushPendingAccountWrites(): Promise<void> | undefined {
  const pending = [...flushers]
  if (!pending.length) return undefined

  const controller = new AbortController()
  const failures: unknown[] = []
  const reportFailure = () => {
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Pending account writes failed.")
  }
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Pending account writes timed out.")
      failures.push(error)
      // Owners retain only their own unsaved snapshot before crypto is revoked.
      controller.abort(error)
      try {
        reportFailure()
      } catch (failure) {
        reject(failure)
      }
    }, ACCOUNT_WRITE_FLUSH_TIMEOUT_MS)
  })
  const work = Promise.all(
    pending.map(async (flush) => {
      try {
        await flush(controller.signal)
      } catch (error) {
        failures.push(error)
      }
    })
  ).then(reportFailure)
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/**
 * For paths that switch or drop a database rather than lock it: a failed or
 * timed-out flush must not abort the switch halfway (each owner already kept
 * its own unsaved snapshot in memory), so it is logged instead of thrown.
 */
export async function settlePendingAccountWrites(): Promise<void> {
  try {
    await flushPendingAccountWrites()
  } catch (error) {
    loggers.store.warn("pending account writes did not settle before the switch", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
