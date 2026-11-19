/**
 * Stop waiting on work once a signal aborts.
 *
 * This does not stop the work. A promise cannot be cancelled from outside, so
 * the caller gets its answer (the abort reason) the moment the signal fires and
 * the work, if it never looks at the signal, runs on with nobody waiting for
 * it. That is the point for a caller whose own cleanup (a lease, a slot, a
 * grant) must not wait on code it does not control.
 *
 * `reason` replaces `signal.reason` when the caller has its own error type.
 */
export function unlessAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  reason: () => unknown = () => signal?.reason
): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(reason())
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
