/** Cross-context mutex for auth storage; async callbacks need more than an in-realm queue. */
const DEFAULT_WAIT_MS = 5_000

export class NamedLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NamedLockError"
  }
}

export interface NamedLockOptions {
  /** Explicit process-local mode for the headless Host; never auto-selected for browsers. */
  mode?: "in-process" | "indexeddb"
  databaseName?: string
  storeName?: string
  stores?: readonly string[]
  /** Legacy callers may deliberately serialize an entire store. */
  isolateByName?: boolean
  /** Preserve the old Logto fallback for injected, already process-local stores. */
  inProcessFallback?: "unserialized"
  /** Compatibility wrapper error type. */
  errorFactory?: (message: string) => Error
  locks?: Pick<LockManager, "request"> | null
  /** Only injected, process-local persistence may run without a cross-context primitive. */
  allowInProcess?: boolean
  waitMs?: number
}

export async function withNamedLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  options: NamedLockOptions = {}
): Promise<T> {
  if (options.mode === "in-process") return inProcessLock(name, task, options)
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks
  if (locks && options.mode !== "indexeddb") {
    return locks.request(name, () => guardedTask(task, options)) as Promise<T>
  }
  if (typeof indexedDB === "undefined") {
    if (options.allowInProcess)
      return options.inProcessFallback === "unserialized"
        ? guardedTask(task, options)
        : inProcessLock(name, task, options)
    throw lockError(options, "A cross-context authentication lock is unavailable.")
  }
  return indexedDbLock(name, task, options)
}

async function guardedTask<T>(
  task: (assertHeld: () => void) => Promise<T>,
  options: NamedLockOptions
): Promise<T> {
  let held = true
  try {
    return await task(() => {
      if (!held) throw lockError(options, "The authentication lock is no longer held.")
    })
  } finally {
    held = false
  }
}

/**
 * IndexedDB serializes readwrite transactions across windows. Keep a harmless
 * request pending until the async work settles, then let the transaction finish.
 * There is no expiring lease: a slow holder is never replaced while it can write.
 * Each name has its own database/transaction domain: IndexedDB locks stores,
 * not individual keys. A transaction on one lineage must not stall another.
 * Legacy Logto opts into its original database and auth/refresh store split.
 */
function indexedDbLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  options: NamedLockOptions
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let db: IDBDatabase | null = null
    let transaction: IDBTransaction | null = null
    let settled = false
    let started = false
    let held = false
    let done = false
    let failed = false
    let result: T | undefined
    let failure: unknown
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      held = false
      clearTimeout(timer)
      db?.close()
      if (error !== undefined) reject(error)
      else if (failed) reject(failure)
      else resolve(result as T)
    }
    const timer = setTimeout(
      () => {
        if (started) return
        finish(lockError(options, "Timed out waiting for the authentication lock."))
        try {
          transaction?.abort()
        } catch {
          /* A completed transaction needs no abort. */
        }
      },
      Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS)
    )
    let request: IDBOpenDBRequest
    try {
      const base = options.databaseName ?? "cognia-named-locks"
      request = indexedDB.open(
        options.isolateByName === false ? base : `${base}:${encodeURIComponent(name)}`,
        1
      )
    } catch (error) {
      finish(error)
      return
    }
    request.onupgradeneeded = () => {
      for (const store of options.stores ?? [options.storeName ?? "locks"]) {
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store)
      }
    }
    request.onerror = () =>
      finish(
        request.error ?? lockError(options, "The authentication lock database is unavailable.")
      )
    request.onsuccess = () => {
      db = request.result
      if (settled) {
        db.close()
        return
      }
      const storeName = options.storeName ?? "locks"
      try {
        transaction = db.transaction(storeName, "readwrite")
      } catch (error) {
        finish(error)
        return
      }
      const current = transaction
      current.onerror = () =>
        finish(current.error ?? lockError(options, "The authentication lock transaction failed."))
      current.onabort = () =>
        finish(current.error ?? lockError(options, "The authentication lock was interrupted."))
      current.oncomplete = () => {
        if (!done) finish(lockError(options, "The authentication lock ended before its work."))
        else finish()
      }
      const pump = () => {
        if (settled || done) return
        let keepAlive: IDBRequest
        try {
          keepAlive = current.objectStore(storeName).get(name)
        } catch (error) {
          finish(error)
          return
        }
        keepAlive.onsuccess = () => {
          if (!started) {
            started = true
            held = true
            clearTimeout(timer)
            void Promise.resolve()
              .then(() =>
                task(() => {
                  if (!held) throw lockError(options, "The authentication lock is no longer held.")
                })
              )
              .then(
                (value) => {
                  held = false
                  result = value
                  done = true
                },
                (error) => {
                  held = false
                  failure = error
                  failed = true
                  done = true
                }
              )
          }
          pump()
        }
      }
      pump()
    }
  })
}

function lockError(options: NamedLockOptions, message: string): Error {
  return options.errorFactory?.(message) ?? new NamedLockError(message)
}

const queues = new Map<string, Promise<void>>()

async function inProcessLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  options: NamedLockOptions
): Promise<T> {
  const previous = queues.get(name) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  queues.set(name, tail)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(lockError(options, "Timed out waiting for the authentication lock.")),
          Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS)
        )
      }),
    ])
    clearTimeout(timer)
    return await guardedTask(task, options)
  } finally {
    clearTimeout(timer)
    release()
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name)
    })
  }
}
