/** Cross-context mutex for auth storage; async callbacks need more than an in-realm queue. */
const DEFAULT_WAIT_MS = 5_000

export class NamedLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NamedLockError"
  }
}

export class NamedLockUnavailable extends NamedLockError {
  constructor() {
    super("The named lock is already held.")
    this.name = "NamedLockUnavailable"
  }
}

export interface NamedLockOptions {
  /** Try once without waiting behind an existing holder. */
  ifAvailable?: true
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
    if (options.ifAvailable)
      return locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) throw new NamedLockUnavailable()
        return guardedTask(task, options)
      }) as Promise<T>
    return locks.request(name, () => guardedTask(task, options)) as Promise<T>
  }
  if (typeof indexedDB === "undefined") {
    if (options.allowInProcess)
      return options.inProcessFallback === "unserialized"
        ? guardedTask(task, options)
        : inProcessLock(name, task, options)
    throw lockError(options, "A cross-context authentication lock is unavailable.")
  }
  return indexedDbStateLock(name, task, options)
}

function lockDatabaseName(name: string, options: NamedLockOptions): string {
  const base = options.databaseName ?? "cognia-named-locks"
  return options.isolateByName === false ? base : `${base}:${encodeURIComponent(name)}`
}

/** Short transactions expose contention without timing a queued work request. */
function updateIndexedDbReservation(
  name: string,
  options: NamedLockOptions,
  update: (owner: string | undefined) => string | undefined
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${lockDatabaseName(name, options)}:availability`, 1)
    request.onupgradeneeded = () => request.result.createObjectStore("holders")
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction("holders", "readwrite")
      const store = tx.objectStore("holders")
      // Legacy callers serialize a whole store, regardless of the key's name.
      const key = options.storeName ?? "locks"
      let previous: string | undefined
      const read = store.get(key)
      read.onsuccess = () => {
        previous = read.result
        const next = update(previous)
        if (next !== previous) {
          if (next === undefined) store.delete(key)
          else store.put(next, key)
        }
      }
      tx.oncomplete = () => {
        db.close()
        resolve(previous)
      }
      tx.onabort = tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

async function indexedDbStateLock<T>(
  name: string,
  task: (assertHeld: () => void) => Promise<T>,
  options: NamedLockOptions
): Promise<T> {
  const deadline = Date.now() + Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS)
  const remaining = () => ({ ...options, waitMs: Math.max(0, deadline - Date.now()) })
  while (true) {
    const token = crypto.randomUUID()
    const previous = await updateIndexedDbReservation(name, options, (owner) => owner ?? token)
    if (previous !== undefined) {
      // A crash rolls back the work transaction but can leave its reservation.
      // Probe through that SAME transaction domain: it can remove an observed
      // reservation only after the live holder has finished. No lease expires
      // under a slow holder, and a stale reservation cannot block forever.
      const probe = indexedDbLock(
        name,
        async () => {
          await updateIndexedDbReservation(name, options, (owner) =>
            owner === previous ? undefined : owner
          )
        },
        remaining()
      )
      if (options.ifAvailable) {
        void probe.catch(() => undefined)
        throw new NamedLockUnavailable()
      }
      await probe
      continue
    }
    try {
      let acquired = false
      const result = await indexedDbLock(
        name,
        async (held) => {
          // A probe may have overtaken a paused reservation before its work
          // transaction started. Such a caller must retry instead of entering.
          const owner = await updateIndexedDbReservation(name, options, (current) => current)
          if (owner !== token) return undefined
          acquired = true
          return task(held)
        },
        remaining()
      )
      if (acquired) return result as T
      if (options.ifAvailable) throw new NamedLockUnavailable()
    } finally {
      await updateIndexedDbReservation(name, options, (owner) =>
        owner === token ? undefined : owner
      )
    }
  }
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
      request = indexedDB.open(lockDatabaseName(name, options), 1)
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
          if (settled) return
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
  if (options.ifAvailable && queues.has(name)) throw new NamedLockUnavailable()
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
