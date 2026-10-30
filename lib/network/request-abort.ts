/** Shared caller cancellation, extracted from the Google document transport. */
export function throwIfRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason
}

/** Release this caller without cancelling a shared refresh or native operation. */
export function withRequestAbort<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort)
    const abort = () => {
      cleanup()
      reject(signal ? signal.reason : new DOMException("Request aborted", "AbortError"))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      void operation().then(
        (result) => {
          cleanup()
          if (signal?.aborted) return abort()
          resolve(result)
        },
        (error: unknown) => {
          cleanup()
          reject(error)
        }
      )
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
