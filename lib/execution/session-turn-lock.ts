/** Shared whole-turn admission for desktop and headless session producers. */
import { createMutex, type Mutex } from "@cognia/primitives"
import { getDb } from "@/lib/db/schema"

const locks = new Map<string, { mutex: Mutex; users: number }>()
export type SessionTurnLease = () => Promise<void>

export function sessionTurnLockKey(sessionId: string): string {
  return `cognia:agent-turn:${getDb().name}:session:${sessionId}`
}

/** Stops whose interrupt has not settled, by lock key; overlapping stops count. */
type StopFence = {
  count: number
  cleared: Promise<void>
  clear: () => void
  releaseShared?: () => void
}
const stops = new Map<string, StopFence>()
/** This realm's shared stop locks, until each is fully released. */
const stopLocks = new Map<string, Set<Promise<unknown>>>()

const stopLockName = (key: string) => `${key}:stop`

/**
 * Fences admission for every producer of the session until the returned
 * (idempotent) release runs: a late interrupt must not reach the next turn,
 * whoever starts it and whether or not a turn holds the lock now. Synchronous
 * for this realm; one shared Web Lock per pending fence, held until its last
 * overlapping stop settles, carries it to other windows/workers.
 */
export function beginSessionStop(sessionId: string): () => void {
  const key = sessionTurnLockKey(sessionId)
  let entry = stops.get(key)
  if (!entry) {
    let clear!: () => void
    const cleared = new Promise<void>((resolve) => {
      clear = resolve
    })
    const created: StopFence = { count: 0, cleared, clear }
    entry = created
    stops.set(key, created)
    const webLocks = globalThis.navigator?.locks
    if (webLocks?.request) {
      // Queued behind a running turn's exclusive hold until it ends; a stop
      // that settles first withdraws the request instead of fencing later turns.
      const withdraw = new AbortController()
      created.releaseShared = () => withdraw.abort()
      const held: Promise<unknown> = webLocks
        .request(
          stopLockName(key),
          { mode: "shared", signal: withdraw.signal },
          () =>
            new Promise<void>((resolve) => {
              if (withdraw.signal.aborted) resolve()
              else created.releaseShared = resolve
            })
        )
        .catch(() => undefined)
        .finally(() => {
          const set = stopLocks.get(key)
          set?.delete(held)
          if (set?.size === 0) stopLocks.delete(key)
        })
      const set = stopLocks.get(key) ?? new Set<Promise<unknown>>()
      set.add(held)
      stopLocks.set(key, set)
    }
  }
  entry.count++
  const owned = entry
  let released = false
  return () => {
    if (released) return
    released = true
    if (--owned.count > 0) return
    if (stops.get(key) === owned) stops.delete(key)
    owned.releaseShared?.()
    owned.clear()
  }
}

/** This realm's fence only; synchronous. */
export function sessionStopPending(sessionId: string): boolean {
  return stops.has(sessionTurnLockKey(sessionId))
}

/**
 * Whether any realm holds or requested a stop fence (shared mode; an exclusive
 * request is a producer's barrier). This realm's released fences finish first.
 */
async function foreignStopFence(key: string): Promise<boolean> {
  const webLocks = globalThis.navigator?.locks
  if (!webLocks?.query) return false
  const releasing = stopLocks.get(key)
  if (releasing?.size) await Promise.all(releasing)
  return sharedStopRequested(key, await webLocks.query())
}

function sharedStopRequested(key: string, { held = [], pending = [] }: LockManagerSnapshot) {
  return [...held, ...pending].some(
    (lock) => lock.name === stopLockName(key) && lock.mode === "shared"
  )
}

/** Any realm: a stop is pending for this session. */
export async function sessionStopFenced(sessionId: string): Promise<boolean> {
  const key = sessionTurnLockKey(sessionId)
  return stops.has(key) || (await foreignStopFence(key))
}

/** This realm's fence: refuse (nonblocking) or wait until it clears. */
async function passLocalStopFence(key: string, ifAvailable: boolean): Promise<boolean> {
  for (;;) {
    const local = stops.get(key)
    if (!local) return true
    if (ifAvailable) return false
    await local.cleared
  }
}

/** Nonblocking desktop admission, or queued admission for headless turns. */
export function acquireSessionTurnLease(
  sessionId: string,
  ifAvailable = false
): Promise<SessionTurnLease | null> {
  const database = getDb()
  const key = sessionTurnLockKey(sessionId)
  // Refuse without touching the lock; the fence is re-checked once it is held.
  if (ifAvailable && stops.has(key)) return Promise.resolve(null)
  const webLocks = globalThis.navigator?.locks
  return new Promise((resolve, reject) => {
    let drained!: () => void
    const released = new Promise<void>((resolveReleased) => {
      drained = resolveReleased
    })
    const deliver = () =>
      new Promise<void>((release) => {
        let complete = false
        resolve(() => {
          if (!complete) {
            complete = true
            release()
          }
          return released
        })
      })
    const assertDatabase = () => {
      if (getDb() !== database) throw new Error("Session turn database changed while waiting")
    }
    const hold = async () => {
      for (;;) {
        assertDatabase()
        if (!(await passLocalStopFence(key, ifAvailable))) {
          resolve(null)
          return
        }
        assertDatabase()
        if (!webLocks?.request) {
          // In-realm only: nothing can begin between this check and delivery.
          if (stops.has(key)) continue
          await deliver()
          return
        }
        // A stop that settled here may still be releasing its shared lock.
        const releasing = stopLocks.get(key)
        if (releasing?.size) {
          await Promise.all(releasing)
          continue
        }
        // The lease holds the stop barrier exclusively for its whole lifetime:
        // a Stop from any window queues its shared fence behind this turn and
        // is granted (FIFO) before any later admission, with no snapshot gap.
        let outcome = "retry" as "refused" | "retry" | "delivered"
        await webLocks.request(
          stopLockName(key),
          { mode: "exclusive", ifAvailable },
          async (lock) => {
            if (!lock) {
              outcome = "refused"
              return
            }
            assertDatabase()
            // A stop in this realm may have begun while the barrier was granted.
            if (stops.has(key)) return
            // A queued turn yields to a Stop requested behind it and queues again.
            if (!ifAvailable && webLocks.query && sharedStopRequested(key, await webLocks.query()))
              return
            if (stops.has(key)) return
            assertDatabase()
            outcome = "delivered"
            await deliver()
          }
        )
        if (outcome === "delivered") return
        if (outcome === "refused" || ifAvailable) {
          resolve(null)
          return
        }
      }
    }
    if (webLocks?.request) {
      void webLocks
        .request(key, { ifAvailable }, async (lock) => {
          if (!lock) {
            resolve(null)
            return
          }
          await hold()
        })
        .then(drained, (error) => {
          drained()
          reject(error)
        })
      return
    }
    let entry = locks.get(key)
    if (!entry) {
      entry = { mutex: createMutex(), users: 0 }
      locks.set(key, entry)
    }
    if (ifAvailable && entry.mutex.isLocked()) {
      resolve(null)
      return
    }
    entry.users++
    const owned = entry
    void entry.mutex.runExclusive(hold).then(
      () => {
        if (--owned.users === 0) locks.delete(key)
        drained()
      },
      (error) => {
        if (--owned.users === 0) locks.delete(key)
        drained()
        reject(error)
      }
    )
  })
}

export async function withSessionTurnLock<T>(
  sessionId: string,
  action: () => Promise<T>
): Promise<T> {
  const release = await acquireSessionTurnLease(sessionId)
  try {
    return await action()
  } finally {
    await release!()
  }
}
