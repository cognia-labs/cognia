/** Cross-context mutex for auth storage; async callbacks need more than an in-realm queue. */
const LOCK_DB_NAME = "cognia-logto-session-locks"
const LOCK_STORES = ["auth", "refresh"] as const
const DEFAULT_WAIT_MS = 5_000

export class LogtoSessionLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LogtoSessionLockError"
  }
}

export interface LogtoSessionLockOptions {
  locks?: Pick<LockManager, "request"> | null
  /** Only injected, process-local persistence may run without a cross-context primitive. */
  allowInProcess?: boolean
  waitMs?: number
}

export async function withLogtoSessionLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  options: LogtoSessionLockOptions = {}
): Promise<T> {
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks
  if (locks) {
    return locks.request(name, () => guardedTask(task)) as Promise<T>
  }
  if (typeof indexedDB === "undefined") {
    if (options.allowInProcess) return guardedTask(task)
    throw new LogtoSessionLockError("A cross-context authentication lock is unavailable.")
  }
  return indexedDbLock(name, task, options.waitMs ?? DEFAULT_WAIT_MS)
}

async function guardedTask<T>(task: (assertHeld: () => void) => Promise<T>): Promise<T> {
  let held = true
  try {
    return await task(() => {
      if (!held) throw new LogtoSessionLockError("The authentication lock is no longer held.")
    })
  } finally {
    held = false
  }
}

/**
 * IndexedDB serializes readwrite transactions across windows. Keep a harmless
 * request pending until the async work settles, then let the transaction finish.
 * There is no expiring lease: a slow holder is never replaced while it can write.
 * Auth and refresh use distinct stores because refresh nests short auth commits.
 */
function indexedDbLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  waitMs: number
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
        finish(new LogtoSessionLockError("Timed out waiting for the authentication lock."))
        try {
          transaction?.abort()
        } catch {
          /* A completed transaction needs no abort. */
        }
      },
      Math.max(0, waitMs)
    )
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(LOCK_DB_NAME, 1)
    } catch (error) {
      finish(error)
      return
    }
    request.onupgradeneeded = () => {
      for (const store of LOCK_STORES) {
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store)
      }
    }
    request.onerror = () =>
      finish(
        request.error ??
          new LogtoSessionLockError("The authentication lock database is unavailable.")
      )
    request.onsuccess = () => {
      db = request.result
      if (settled) {
        db.close()
        return
      }
      const storeName = name.startsWith("cognia-logto-refresh:") ? "refresh" : "auth"
      try {
        transaction = db.transaction(storeName, "readwrite")
      } catch (error) {
        finish(error)
        return
      }
      const current = transaction
      current.onerror = () =>
        finish(
          current.error ?? new LogtoSessionLockError("The authentication lock transaction failed.")
        )
      current.onabort = () =>
        finish(
          current.error ?? new LogtoSessionLockError("The authentication lock was interrupted.")
        )
      current.oncomplete = () => {
        if (!done)
          finish(new LogtoSessionLockError("The authentication lock ended before its work."))
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
                  if (!held)
                    throw new LogtoSessionLockError("The authentication lock is no longer held.")
                })
              )
              .then(
                (value) => {
                  result = value
                  done = true
                },
                (error) => {
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
