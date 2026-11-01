/**
 * Write a transaction's binary values off the commit path, before the commit.
 *
 * The durability capture appends a transaction's commit record on the Dexie
 * `complete` listener, synchronously (see `capture.ts`), and a row that holds a
 * Blob or large typed array references a content-addressed side file
 * (`binary-store.ts`) that must be durable before that record is. Writing the
 * side files there, one `fsync` pair each, blocked the brain's event loop for
 * the whole capture: 32 s for a pet media pack of 3,657 Blobs, during which the
 * brain answered no RPC, bridge frame or heartbeat (S1 ledger X8).
 *
 * So the side files are started when the mutation is recorded, while the
 * transaction is still running: {@link BinaryPrefetcher.prefetch} hands every
 * Blob, and every ArrayBuffer or view above the inline limit, to a small pool
 * of worker threads that read, hash, write and `fsync` them in parallel. The
 * `complete` listener then only waits for whatever is still unfinished
 * ({@link BinaryPrefetcher.resolve}) and appends the record. The guarantee is
 * unchanged — a commit is durable only once its side files are, names
 * included — but no side-file `fsync` runs on the main thread, and the file
 * work overlaps the transaction and itself.
 *
 * Jobs belong to the mutation that recorded them (its `scope`), never to the
 * value alone: an ArrayBuffer the caller changes and writes again, or a Blob
 * written again after an aborted transaction, starts a fresh job with the bytes
 * of that write instead of reusing a stale one.
 *
 * The brain's IndexedDB is in memory, so a transaction can finish long before
 * its side files do; the capture then holds that transaction open while more
 * than a window of its own jobs (or bytes) is unfinished
 * ({@link BinaryPrefetcher.groupBacklog}), and its commit waits for at most
 * that window. Other transactions are not held.
 *
 * Compaction and seeding read whole tables; {@link BinaryPrefetcher.settle}
 * waits for their side files with `Atomics.waitAsync`, so those never block the
 * loop at all.
 */
import os from "node:os"
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads"

import { builtinTag, isBinaryValue } from "../../db/snapshot"
import { binaryDir, INLINE_BINARY_LIMIT } from "./binary-store"
import { BLOB_READ_TIMEOUT_MS } from "./blob-sync"

/** What the encoder gets for a prefetched binary. */
export type PreparedBinary = { fileRef: string; byteLength: number } | { bytes: Uint8Array }

const PENDING = 0
const DONE = 1
const FAILED = 2
/** Header: Int32 state, Int32 result kind (1 inline bytes, 2 file ref). */
const HEADER_BYTES = 16
const REF_BYTES = 64

/**
 * Worker body. Self-contained (an eval'd worker cannot import the TypeScript
 * modules), so it repeats `writeBinarySync`'s protocol: temp file, write,
 * `fsync`, rename, directory `fsync`; an existing file of the right size is
 * reused, its mtime refreshed so a concurrent finalize spares it, and the
 * directory `fsync`ed as well, since that file may be another job's rename
 * whose entry is not durable yet. A job is DONE only once its file's name is
 * durable, so a record that names it never outlives it.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const delay = workerData.fsyncDelayMs > 0 ? new Int32Array(new SharedArrayBuffer(4)) : null
function slowFsync(fd) {
  fs.fsyncSync(fd)
  if (delay) Atomics.wait(delay, 0, 0, workerData.fsyncDelayMs)
}
const dirSyncs = workerData.dirSyncs ? new Int32Array(workerData.dirSyncs) : null
// [tickets taken, highest ticket a finished directory fsync covers]
const sync = new Int32Array(workerData.dirSync)
// Make every entry this worker has seen in the directory durable. A ticket is
// taken AFTER the rename (or after a reuse saw the file), so a directory
// fsync that started once tickets reached it covers the entry: a worker skips
// its own fsync when another, later-starting one already did.
function syncDir(dir) {
  const ticket = Atomics.add(sync, 0, 1) + 1
  if (Atomics.load(sync, 1) >= ticket) return
  const upTo = Atomics.load(sync, 0)
  if (dirSyncs) Atomics.add(dirSyncs, 0, 1)
  if (process.platform !== "win32") {
    const fd = fs.openSync(dir, "r")
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }
  for (let covered = Atomics.load(sync, 1); covered < upTo; covered = Atomics.load(sync, 1)) {
    if (Atomics.compareExchange(sync, 1, covered, upTo) === covered) break
  }
}
function writeSide(dir, bytes) {
  const reference = crypto.createHash("sha256").update(bytes).digest("hex")
  const file = path.join(dir, reference)
  if (fs.existsSync(file) && fs.statSync(file).size === bytes.byteLength) {
    const at = new Date()
    fs.utimesSync(file, at, at)
    syncDir(dir)
    return reference
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const staging = path.join(dir, ".tmp-" + crypto.randomUUID())
  const fd = fs.openSync(staging, "wx", 0o600)
  try {
    let written = 0
    while (written < bytes.byteLength) {
      written += fs.writeSync(fd, bytes, written, bytes.byteLength - written)
    }
    slowFsync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.renameSync(staging, file)
  } catch (error) {
    fs.rmSync(staging, { force: true })
    throw error
  }
  syncDir(dir)
  return reference
}
parentPort.on("message", async ({ shared, reply, dir, inlineLimit, blob, buffer, group, kib }) => {
  const header = new Int32Array(shared, 0, 4)
  const counters = new Int32Array(group)
  try {
    const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(buffer)
    if (blob && bytes.byteLength !== blob.size) {
      throw new Error("blob size changed while it was read: expected " + blob.size + ", read " + bytes.byteLength)
    }
    if (bytes.byteLength <= inlineLimit) {
      new Uint8Array(shared, ${HEADER_BYTES}, bytes.byteLength).set(bytes)
      Atomics.store(header, 1, 1)
    } else {
      const reference = writeSide(dir, bytes)
      new Uint8Array(shared, ${HEADER_BYTES}, ${REF_BYTES}).set(Buffer.from(reference, "ascii"))
      Atomics.store(header, 1, 2)
    }
    Atomics.store(header, 0, ${DONE})
  } catch (error) {
    reply.postMessage(String(error && error.message ? error.message : error))
    Atomics.store(header, 0, ${FAILED})
  } finally {
    reply.close()
    Atomics.sub(counters, 0, 1)
    Atomics.sub(counters, 1, kib)
    Atomics.notify(header, 0)
    Atomics.notify(counters, 0)
  }
})
`

interface Job {
  header: Int32Array
  shared: SharedArrayBuffer
  port: MessagePort
  byteLength: number
  /** Set when the job's worker died: why the job can never finish. */
  failure?: string
  /** Its transaction's counters (see {@link BinaryPrefetcher.groupBacklog}) and its share. */
  group: Int32Array
  kib: number
}

interface PoolWorker {
  thread: Worker
  /** Jobs posted to it that may still be running (pruned lazily). */
  inflight: Set<Job>
}

export interface BinaryPrefetcherOptions {
  /** Binaries up to this many bytes stay inline (default {@link INLINE_BINARY_LIMIT}). */
  inlineLimit?: number
  /** Worker threads (default: available parallelism, 2–8). */
  poolSize?: number
  /** Longest a commit waits for one side file before it fails. */
  timeoutMs?: number
  /** Test hook: extra milliseconds per worker `fsync`, to model a slow disk. */
  fsyncDelayMs?: number
  /** Test hook: a shared counter the workers bump on every directory `fsync`. */
  dirSyncs?: Int32Array
}

/** The encoder's walk, in any realm (see `builtinTag` in `snapshot.ts`). */
function children(value: object): unknown[] | null {
  const tag = builtinTag(value)
  if (tag === "Date" || tag === "RegExp") return null
  if (tag === "Map") return [...(value as Map<unknown, unknown>)].flat()
  if (tag === "Set") return [...(value as Set<unknown>)]
  if (tag === "Error") return Object.hasOwn(value, "cause") ? [(value as Error).cause] : null
  return Array.isArray(value) ? value : Object.values(value)
}

const isPending = (job: Job) => Atomics.load(job.header, 0) === PENDING

export class BinaryPrefetcher {
  /** Per scope (a recorded mutation, a table read): its binaries' jobs. */
  private readonly jobs = new WeakMap<object, Map<object, Job>>()
  /**
   * Per group (a transaction): unfinished jobs and KiB, in shared memory. The
   * main thread adds on post, the worker subtracts when the job ends, so
   * reading the backlog is O(1) however many jobs are queued.
   */
  private readonly groups = new WeakMap<object, Int32Array>()
  /** Jobs posted without a group. */
  private readonly ungrouped = new Int32Array(new SharedArrayBuffer(8))
  /** The workers' directory-fsync tickets (see the worker source). */
  private readonly dirSync = new Int32Array(new SharedArrayBuffer(8))
  private readonly workers: PoolWorker[] = []
  private next = 0
  private readonly inlineLimit: number
  private readonly poolSize: number
  private readonly timeoutMs: number

  constructor(
    private readonly root: string,
    private readonly options: BinaryPrefetcherOptions = {}
  ) {
    this.inlineLimit = options.inlineLimit ?? INLINE_BINARY_LIMIT
    this.poolSize =
      options.poolSize ?? Math.max(2, Math.min(8, os.availableParallelism?.() ?? os.cpus().length))
    this.timeoutMs = options.timeoutMs ?? BLOB_READ_TIMEOUT_MS
  }

  private worker(): PoolWorker {
    if (this.workers.length < this.poolSize) {
      const thread = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          fsyncDelayMs: this.options.fsyncDelayMs ?? 0,
          dirSyncs: this.options.dirSyncs?.buffer,
          dirSync: this.dirSync.buffer,
        },
      })
      thread.unref()
      const created: PoolWorker = { thread, inflight: new Set() }
      // A worker that dies (out of memory, a native crash) leaves the pool and
      // fails what it held, so no commit waits out the timeout for it; the
      // listener also keeps its `error` from taking down the brain.
      const retire = (reason: string) => {
        const index = this.workers.indexOf(created)
        if (index >= 0) this.workers.splice(index, 1)
        for (const job of created.inflight) {
          if (!isPending(job)) continue
          job.failure = reason
          Atomics.store(job.header, 0, FAILED)
          Atomics.sub(job.group, 0, 1)
          Atomics.sub(job.group, 1, job.kib)
          Atomics.notify(job.header, 0)
          Atomics.notify(job.group, 0)
        }
        created.inflight.clear()
      }
      thread.on("error", (error: Error) => retire(`binary worker failed: ${error.message}`))
      thread.on("exit", (code) => retire(`binary worker exited with code ${code}`))
      this.workers.push(created)
      return created
    }
    const picked = this.workers[this.next % this.workers.length]
    this.next += 1
    return picked
  }

  /**
   * Start the side files of every binary `value` holds, as jobs of `scope`,
   * counted against `group` (the transaction). Synchronous and cheap: it walks
   * the value the way the encoder does and posts work; nothing waits. Bytes of
   * an ArrayBuffer or view are copied now, which is also when IndexedDB cloned
   * them.
   */
  prefetch(value: unknown, scope: object, group?: object): void {
    let jobs = this.jobs.get(scope)
    if (!jobs) {
      jobs = new Map()
      this.jobs.set(scope, jobs)
    }
    this.walk(value, jobs, this.counters(group), new Set())
  }

  private counters(group: object | undefined): Int32Array {
    if (!group) return this.ungrouped
    let counters = this.groups.get(group)
    if (!counters) {
      counters = new Int32Array(new SharedArrayBuffer(8))
      this.groups.set(group, counters)
    }
    return counters
  }

  private walk(value: unknown, jobs: Map<object, Job>, group: Int32Array, seen: Set<object>): void {
    if (!value || typeof value !== "object") return
    if (isBinaryValue(value)) {
      if (!jobs.has(value)) {
        const job = this.start(value, group)
        if (job) jobs.set(value, job)
      }
      return
    }
    if (seen.has(value)) return
    seen.add(value)
    for (const item of children(value) ?? []) this.walk(item, jobs, group, seen)
  }

  private start(value: Blob | ArrayBuffer | ArrayBufferView, group: Int32Array): Job | undefined {
    const byteLength = value instanceof Blob ? value.size : value.byteLength
    // Small ArrayBuffers and views are already in memory and stay inline: the
    // encoder copies them itself. A Blob of any size needs its bytes read.
    if (!(value instanceof Blob) && byteLength <= this.inlineLimit) return undefined
    if (value instanceof Blob && byteLength === 0) return undefined
    const shared = new SharedArrayBuffer(
      HEADER_BYTES + (byteLength <= this.inlineLimit ? byteLength : REF_BYTES)
    )
    const { port1, port2 } = new MessageChannel()
    const kib = Math.ceil(byteLength / 1024)
    const message: Record<string, unknown> = {
      shared,
      reply: port2,
      dir: binaryDir(this.root),
      inlineLimit: this.inlineLimit,
      group: group.buffer,
      kib,
    }
    const transfer: Array<MessagePort | ArrayBuffer> = [port2 as MessagePort]
    if (value instanceof Blob) message.blob = value
    else {
      const view = ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value)
      const copy = view.slice()
      message.buffer = copy.buffer
      transfer.push(copy.buffer)
    }
    const job: Job = {
      header: new Int32Array(shared, 0, 4),
      shared,
      port: port1,
      byteLength,
      group,
      kib,
    }
    const worker = this.worker()
    if (worker.inflight.size >= 64) {
      for (const done of worker.inflight) if (!isPending(done)) worker.inflight.delete(done)
    }
    try {
      worker.thread.postMessage(message, transfer)
    } catch (error) {
      // Not posted (a file-backed Blob cannot be cloned): nothing to count.
      port1.close()
      port2.close()
      throw error
    }
    Atomics.add(group, 0, 1)
    Atomics.add(group, 1, kib)
    worker.inflight.add(job)
    // The reply port only carries an error message; it must not keep an idle
    // brain alive for a transaction that aborted and never asked for it.
    port1.unref()
    return job
  }

  /**
   * Unfinished jobs and KiB of one group (transaction), O(1). The capture
   * holds that transaction open while this exceeds its window, so its commit
   * never waits for more than the window.
   */
  groupBacklog(group: object): { jobs: number; kib: number } {
    const counters = this.groups.get(group)
    if (!counters) return { jobs: 0, kib: 0 }
    return { jobs: Atomics.load(counters, 0), kib: Atomics.load(counters, 1) }
  }

  /** The pool size: the backlog a commit can clear in about one file's time. */
  get parallelism(): number {
    return this.poolSize
  }

  /**
   * The prefetched result for `value` in `scope`, waiting for it if needed;
   * `undefined` if that scope never prefetched it.
   */
  resolve(value: object, scope: object): PreparedBinary | undefined {
    const job = this.jobs.get(scope)?.get(value)
    if (!job) return undefined
    if (isPending(job)) {
      const outcome = Atomics.wait(job.header, 0, PENDING, this.timeoutMs)
      if (outcome === "timed-out") {
        throw new Error(
          `writing a ${job.byteLength}-byte binary for the durability journal timed out`
        )
      }
    }
    if (Atomics.load(job.header, 0) === FAILED) {
      const message = job.failure ?? receiveMessageOnPort(job.port)?.message
      job.port.close()
      this.jobs.get(scope)?.delete(value)
      throw new Error(`writing a binary for the durability journal failed: ${String(message)}`)
    }
    if (Atomics.load(job.header, 1) === 1) {
      return { bytes: new Uint8Array(job.shared, HEADER_BYTES, job.byteLength).slice() }
    }
    return {
      fileRef: Buffer.from(new Uint8Array(job.shared, HEADER_BYTES, REF_BYTES)).toString("ascii"),
      byteLength: job.byteLength,
    }
  }

  /**
   * Prefetch everything `values` hold, as jobs of `scope`, and wait for it
   * without blocking the event loop (compaction, seeding). Afterwards
   * {@link resolve} returns at once.
   *
   * At most two rounds of the pool are in flight at a time, so a whole
   * table's side files never queue ahead of a commit's (a commit's jobs wait
   * behind at most that window), and each job's timeout starts when it is
   * near the head of the queue rather than when the table read began.
   */
  async settle(values: readonly unknown[], scope: object): Promise<void> {
    let jobs = this.jobs.get(scope)
    if (!jobs) {
      jobs = new Map()
      this.jobs.set(scope, jobs)
    }
    const binaries = new Set<Blob | ArrayBuffer | ArrayBufferView>()
    const seen = new Set<object>()
    const collect = (value: unknown): void => {
      if (!value || typeof value !== "object") return
      if (isBinaryValue(value)) {
        binaries.add(value)
        return
      }
      if (seen.has(value)) return
      seen.add(value)
      for (const item of children(value) ?? []) collect(item)
    }
    for (const value of values) collect(value)
    const window = this.poolSize * 2
    const inFlight: Job[] = []
    // `Atomics.waitAsync` does not keep Node's event loop alive, and the
    // workers and ports are unref'd: without a ref'd handle a store opening on
    // a quiet process (compaction at boot, a seed with Blobs) would see the
    // process exit mid-await, silently, with code 0.
    const keepAlive = setInterval(() => {}, 60_000)
    try {
      const awaitOldest = async () => {
        const job = inFlight.shift()
        if (!job || !isPending(job)) return
        const waiting = Atomics.waitAsync(job.header, 0, PENDING, this.timeoutMs)
        if (waiting.async && (await waiting.value) === "timed-out") {
          throw new Error(
            `writing a ${job.byteLength}-byte binary for the durability store timed out`
          )
        }
      }
      for (const binary of binaries) {
        if (jobs.has(binary)) continue
        const job = this.start(binary, this.ungrouped)
        if (!job) continue
        jobs.set(binary, job)
        inFlight.push(job)
        if (inFlight.length >= window) await awaitOldest()
      }
      while (inFlight.length) await awaitOldest()
      for (const job of jobs.values()) {
        if (!isPending(job)) continue
        const waiting = Atomics.waitAsync(job.header, 0, PENDING, this.timeoutMs)
        if (waiting.async && (await waiting.value) === "timed-out") {
          throw new Error("writing binaries for the durability store timed out")
        }
      }
    } finally {
      clearInterval(keepAlive)
    }
  }

  /**
   * Block the calling thread for at most `ms` while `group`'s unfinished job
   * count is still `jobs`: the capture's hold waits here between its no-op
   * reads instead of spinning, and a worker finishing a job wakes it at once.
   */
  pauseFor(group: object, jobs: number, ms: number): void {
    const counters = this.groups.get(group)
    if (counters && jobs > 0) Atomics.wait(counters, 0, jobs, ms)
  }

  async close(): Promise<void> {
    const workers = this.workers.splice(0)
    await Promise.all(workers.map((worker) => worker.thread.terminate()))
  }
}
