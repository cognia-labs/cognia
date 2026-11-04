// A process-wide, lazy two-thread pool for pure per-file extraction.
// The same module is also the worker entry, including after esbuild splitting.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"
import { extractFile } from "./extractor.ts"
import type { ExtractResult } from "./extractor.ts"

const ROLE = "cognia-code-graph-extraction"
if (!isMainThread && workerData?.role === ROLE && parentPort) {
  const port = parentPort
  port.on(
    "message",
    async ({ id, filePath, source }: { id: number; filePath: string; source: string }) => {
      try {
        port.postMessage({ id, result: await extractFile(filePath, source) })
      } catch (error) {
        port.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  )
}

export interface ExtractionPool {
  extract(filePath: string, source: string): Promise<ExtractResult>
  dispose(): void
}
interface PoolOptions {
  idleMs?: number
  taskTimeoutMs?: number
  workerFactory?: () => Worker
}
interface Job {
  id: number
  owner: symbol
  filePath: string
  source: string
  resolve(result: ExtractResult): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
  cancelled?: boolean
}
interface Slot {
  worker: Worker
  job?: Job
}
interface PoolState {
  lease(): ExtractionPool
}
// A new lease cannot temporarily exceed two threads while old threads exit.
let retirement: Promise<unknown> = Promise.resolve()

function poolState(
  {
    idleMs = 1000,
    taskTimeoutMs = 30_000,
    workerFactory = () =>
      new Worker(new URL(import.meta.url), {
        workerData: { role: ROLE },
        // Inheriting --eval/--test/preloads can recursively start a host in a worker.
        // This entry executes only the trusted extractor over provided source text.
        execArgv: [],
        name: "cognia-code-index",
      }),
  }: PoolOptions,
  onEmpty: () => void
): PoolState {
  let nextId = 0,
    dead = false,
    starting = false
  let slots: Slot[] = []
  let queue: Job[] = []
  let idle: ReturnType<typeof setTimeout> | undefined
  const owners = new Set<symbol>()
  const closed = () => new Error("code-index extraction lease is disposed")
  const unavailable = () => new Error("code-index worker pool is unavailable")

  function stop(error?: Error): void {
    clearTimeout(idle)
    const old = slots
    slots = []
    const jobs = [...queue, ...old.flatMap((s) => (s.job ? [s.job] : []))]
    queue = []
    for (const job of jobs) {
      clearTimeout(job.timer)
      job.reject(error ?? closed())
    }
    const terminations: Promise<unknown>[] = []
    for (const slot of old) {
      slot.job = undefined
      // Keep error handlers attached until termination; late worker errors
      // observe that this slot is no longer owned and cannot escape teardown.
      slot.worker.unref()
      terminations.push(slot.worker.terminate().catch(() => undefined))
    }
    retirement = Promise.all([retirement, ...terminations]).then(() => undefined)
  }
  function fail(error: Error): void {
    dead = true
    stop(error)
  }

  async function start(): Promise<void> {
    if (slots.length || dead || starting) return
    starting = true
    await retirement
    if (dead || queue.length === 0 || owners.size === 0) {
      starting = false
      return
    }
    try {
      for (let i = 0; i < 2; i++) {
        const slot: Slot = { worker: workerFactory() }
        if (dead || owners.size === 0) {
          // A process 'worker' observer may dispose the last lease inside
          // the constructor, before this new thread can join slots.
          slot.worker.on("error", () => undefined)
          retirement = Promise.all([
            retirement,
            slot.worker.terminate().catch(() => undefined),
          ]).then(() => undefined)
          break
        }
        slots.push(slot)
        slot.worker.on("error", (error) => {
          if (slots.includes(slot)) fail(error instanceof Error ? error : new Error(String(error)))
        })
        slot.worker.on("exit", (code) => {
          if (slots.includes(slot)) fail(new Error(`code-index worker exited (${code})`))
        })
        slot.worker.on(
          "message",
          (message: { id?: number; result?: ExtractResult; error?: string }) => {
            if (!slots.includes(slot)) return
            const job = slot.job
            if (!job || message?.id !== job.id || !message.result || message.error) {
              fail(new Error(`code-index worker failed: ${message?.error ?? "invalid response"}`))
              return
            }
            clearTimeout(job.timer)
            slot.job = undefined
            if (!job.cancelled) job.resolve(message.result)
            slot.worker.unref()
            pump()
          }
        )
        slot.worker.unref()
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    } finally {
      starting = false
    }
    pump()
  }
  function pump(): void {
    if (dead) return
    clearTimeout(idle)
    for (const slot of slots) {
      if (slot.job) continue
      const job = queue.shift()
      if (!job) break
      slot.job = job
      slot.worker.ref()
      job.timer = setTimeout(
        () => fail(new Error("code-index worker extraction timed out")),
        taskTimeoutMs
      )
      try {
        slot.worker.postMessage({ id: job.id, filePath: job.filePath, source: job.source })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
    if (slots.length && queue.length === 0 && slots.every((s) => !s.job)) {
      idle = setTimeout(() => stop(), idleMs)
      idle.unref()
    }
  }
  return {
    lease() {
      const owner = Symbol("index-owner")
      owners.add(owner)
      return {
        extract(filePath, source) {
          if (!owners.has(owner)) return Promise.reject(closed())
          if (dead) return Promise.reject(unavailable())
          // The index pipelines at most two files per lease. Bound aggregate
          // queued payloads when many sessions index concurrently.
          if (queue.length >= 64)
            return Promise.reject(new Error("code-index worker queue is full"))
          return new Promise((resolve, reject) => {
            queue.push({ id: ++nextId, owner, filePath, source, resolve, reject })
            void start()
            pump()
          })
        },
        dispose() {
          if (!owners.delete(owner)) return
          const error = closed()
          queue = queue.filter((job) => {
            if (job.owner !== owner) return true
            job.reject(error)
            return false
          })
          for (const slot of slots)
            if (slot.job?.owner === owner) {
              slot.job.cancelled = true
              slot.job.reject(error)
              // A sibling lease may still need this pool. Let the pure parse
              // finish, but it can never publish back into the disposed index.
            }
          if (owners.size === 0) {
            stop(error)
            onEmpty()
          } else pump()
        },
      }
    },
  }
}

/** Isolated pool seam for lifecycle regressions; production shares one state. */
export function createExtractionPool(options: PoolOptions = {}): ExtractionPool {
  return poolState(options, () => undefined).lease()
}
let shared: PoolState | undefined
export function acquireExtractionPool(): ExtractionPool {
  if (!shared)
    shared = poolState({}, () => {
      shared = undefined
    })
  return shared.lease()
}
