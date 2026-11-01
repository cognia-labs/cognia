import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BinaryPrefetcher } from "./binary-prefetch"
import { binaryDir, readBinarySync } from "./binary-store"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("BinaryPrefetcher", () => {
  let root: string
  let prefetcher: BinaryPrefetcher
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-prefetch-"))
    prefetcher = new BinaryPrefetcher(root, { inlineLimit: 1024, poolSize: 2 })
  })
  afterEach(async () => {
    await prefetcher.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("writes a large Blob's side file in the pool and hands back its reference", () => {
    const scope = {}
    const bytes = new Uint8Array(4096).fill(3)
    const blob = new Blob([bytes])
    prefetcher.prefetch({ nested: [{ blob }] }, scope)
    expect(prefetcher.resolve(blob, scope)).toEqual({ fileRef: sha(bytes), byteLength: 4096 })
    expect(readBinarySync(root, sha(bytes), bytes.byteLength)).toEqual(bytes)
  })

  it("reads a small Blob's bytes for the inline envelope", () => {
    const scope = {}
    const blob = new Blob([Uint8Array.from([1, 2, 3])])
    prefetcher.prefetch(new Map([["k", blob]]), scope)
    expect(prefetcher.resolve(blob, scope)).toEqual({ bytes: Uint8Array.from([1, 2, 3]) })
    expect(fs.existsSync(binaryDir(root))).toBe(false)
  })

  it("copies a large view's bytes when it is recorded, not when it is encoded", () => {
    const scope = {}
    const view = new Uint16Array(1024).fill(7)
    prefetcher.prefetch(new Set([view]), scope)
    const recorded = new Uint8Array(view.buffer.slice(0))
    view.fill(9)
    expect(prefetcher.resolve(view, scope)).toEqual({ fileRef: sha(recorded), byteLength: 2048 })
  })

  it("leaves small views, unseen values and other scopes' jobs to the encoder", () => {
    const scope = {}
    const small = Uint8Array.from([1])
    const blob = new Blob([new Uint8Array(2048)])
    prefetcher.prefetch({ small, blob, at: new Date(0), re: /x/ }, scope)
    expect(prefetcher.resolve(small, scope)).toBeUndefined()
    expect(prefetcher.resolve(new Blob(["never prefetched"]), scope)).toBeUndefined()
    expect(prefetcher.resolve(blob, {})).toBeUndefined()
  })

  it("gives each write its own bytes: a buffer changed and written again is never served stale", () => {
    // The aborted-transaction case: the first scope is never committed, the
    // caller changes the buffer and writes it again under a new mutation.
    const buffer = new Uint8Array(2048).fill(1)
    const first = {}
    prefetcher.prefetch({ buffer }, first)
    buffer.fill(2)
    const second = {}
    prefetcher.prefetch({ buffer }, second)
    expect(prefetcher.resolve(buffer, second)).toEqual({
      fileRef: sha(new Uint8Array(2048).fill(2)),
      byteLength: 2048,
    })
    expect(prefetcher.resolve(buffer, first)).toEqual({
      fileRef: sha(new Uint8Array(2048).fill(1)),
      byteLength: 2048,
    })
  })

  it("restores a side file pruned after an earlier, abandoned write of the same Blob", async () => {
    const bytes = new Uint8Array(2048).fill(4)
    const blob = new Blob([bytes])
    await prefetcher.settle([blob], {})
    // Finalize pruned the orphan the abandoned write left behind.
    fs.rmSync(path.join(binaryDir(root), sha(bytes)))
    const retry = {}
    prefetcher.prefetch(blob, retry)
    expect(prefetcher.resolve(blob, retry)).toEqual({ fileRef: sha(bytes), byteLength: 2048 })
    expect(readBinarySync(root, sha(bytes), bytes.byteLength)).toEqual(bytes)
  })

  it("reports a side file done only once its name is durable, with no fsync on the main thread", async () => {
    const dirSyncs = new Int32Array(new SharedArrayBuffer(4))
    const traced = new BinaryPrefetcher(root, { inlineLimit: 1024, poolSize: 2, dirSyncs })
    const fsyncSync = jest.spyOn(fs, "fsyncSync")
    try {
      const blobs = [1, 2, 3].map((n) => new Blob([new Uint8Array(2048).fill(n)]))
      const scope = {}
      traced.prefetch(blobs, scope)
      for (const blob of blobs) traced.resolve(blob, scope)
      // Each renamed file is covered by a directory fsync that started after
      // its rename, before its job reads DONE; concurrent renames share one.
      const renamed = Atomics.load(dirSyncs, 0)
      expect(renamed).toBeGreaterThanOrEqual(1)
      expect(renamed).toBeLessThanOrEqual(3)
      // Reusing a file another job renamed in fsyncs the directory again: its
      // entry may not be durable yet when the reuse sees it.
      const reuse = new Blob([new Uint8Array(2048).fill(1)])
      const later = {}
      traced.prefetch(reuse, later)
      traced.resolve(reuse, later)
      expect(Atomics.load(dirSyncs, 0)).toBe(renamed + 1)
      expect(fsyncSync).not.toHaveBeenCalled()
    } finally {
      fsyncSync.mockRestore()
      await traced.close()
    }
  })

  it("describes the recorded bytes even when the buffer is transferred before the commit", () => {
    const scope = {}
    const buffer = new Uint8Array(4096).fill(8).buffer
    prefetcher.prefetch({ buffer }, scope)
    structuredClone(buffer, { transfer: [buffer] })
    expect(buffer.byteLength).toBe(0)
    expect(prefetcher.resolve(buffer, scope)).toEqual({
      fileRef: sha(new Uint8Array(4096).fill(8)),
      byteLength: 4096,
    })
  })

  it("waits for a whole table without blocking the event loop", async () => {
    const slow = new BinaryPrefetcher(root, { inlineLimit: 1024, poolSize: 1, fsyncDelayMs: 40 })
    try {
      const scope = {}
      const rows = [1, 2, 3, 4].map((n) => ({ blob: new Blob([new Uint8Array(2048).fill(n)]) }))
      let ticks = 0
      const ticker = setInterval(() => (ticks += 1), 5)
      await slow.settle(rows, scope)
      clearInterval(ticker)
      // ~160 ms of modelled fsyncs passed while timers kept firing.
      expect(ticks).toBeGreaterThan(5)
      for (const row of rows) expect(slow.resolve(row.blob, scope)).toHaveProperty("fileRef")
    } finally {
      await slow.close()
    }
  })

  it("keeps the process alive while it settles, with nothing else holding the loop", () => {
    // `Atomics.waitAsync` holds no handle and the workers are unref'd; a store
    // opening on a quiet process would otherwise exit mid-settle with code 0.
    const script = path.join(root, "settle.mts")
    fs.writeFileSync(
      script,
      `import { BinaryPrefetcher } from ${JSON.stringify(path.resolve(__dirname, "binary-prefetch.ts"))}\n` +
        `const p = new BinaryPrefetcher(${JSON.stringify(root)}, { inlineLimit: 16, poolSize: 1, fsyncDelayMs: 300 })\n` +
        `p.settle([new Blob([new Uint8Array(64).fill(1)])], {}).then(() => { console.log("settled"); return p.close() })\n`
    )
    const tsx = path.resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs")
    const out = execFileSync(process.execPath, [tsx, script], { encoding: "utf8" })
    expect(out.trim()).toBe("settled")
  })

  it("fails the commit with the worker's error, and after its timeout", async () => {
    // The binary directory cannot be created: a file sits where it should be.
    fs.writeFileSync(path.join(root, "binary"), "not a directory")
    const scope = {}
    const blob = new Blob([new Uint8Array(2048)])
    prefetcher.prefetch(blob, scope)
    expect(() => prefetcher.resolve(blob, scope)).toThrow(/writing a binary .* failed: .*/)

    const stuck = new BinaryPrefetcher(root, {
      inlineLimit: 1024,
      poolSize: 1,
      fsyncDelayMs: 500,
      timeoutMs: 20,
    })
    try {
      fs.rmSync(path.join(root, "binary"))
      const slowBlob = new Blob([new Uint8Array(2048).fill(1)])
      stuck.prefetch(slowBlob, scope)
      expect(() => stuck.resolve(slowBlob, scope)).toThrow(/timed out/)
    } finally {
      await stuck.close()
    }
  })

  it("retires a worker that dies: its jobs fail at once and the pool replaces it", async () => {
    const fragile = new BinaryPrefetcher(root, {
      inlineLimit: 1024,
      poolSize: 1,
      fsyncDelayMs: 2000,
      timeoutMs: 10_000,
    })
    try {
      const scope = {}
      const blob = new Blob([new Uint8Array(2048).fill(6)])
      fragile.prefetch(blob, scope)
      const workers = (
        fragile as unknown as { workers: { thread: { terminate(): Promise<number> } }[] }
      ).workers
      await workers[0].thread.terminate()
      await new Promise((resolve) => setTimeout(resolve, 20))
      const started = Date.now()
      expect(() => fragile.resolve(blob, scope)).toThrow(/worker exited/)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(workers).toHaveLength(0)
    } finally {
      await fragile.close()
    }
    // A fresh pool member serves the next job.
    const next = {}
    const blob = new Blob([new Uint8Array(2048).fill(7)])
    prefetcher.prefetch(blob, next)
    expect(prefetcher.resolve(blob, next)).toHaveProperty("fileRef")
  })

  it("counts each transaction's unfinished jobs and KiB apart, for the capture's drain gate", async () => {
    const slow = new BinaryPrefetcher(root, { inlineLimit: 1024, poolSize: 2, fsyncDelayMs: 100 })
    try {
      const trans = {}
      const other = {}
      const scope = {}
      const rows = [1, 2, 3, 4, 5].map((n) => new Blob([new Uint8Array(2048).fill(n)]))
      slow.prefetch(rows, scope, trans)
      expect(slow.groupBacklog(trans)).toEqual({ jobs: 5, kib: 10 })
      expect(slow.groupBacklog(other)).toEqual({ jobs: 0, kib: 0 })
      expect(slow.parallelism).toBe(2)
      await slow.settle(rows, scope)
      expect(slow.groupBacklog(trans)).toEqual({ jobs: 0, kib: 0 })
    } finally {
      await slow.close()
    }
  })

  it("gives each job of a table its own timeout, never one budget for the whole table", async () => {
    const paced = new BinaryPrefetcher(root, {
      inlineLimit: 1024,
      poolSize: 1,
      fsyncDelayMs: 20,
      timeoutMs: 150,
    })
    try {
      const scope = {}
      // ~20 × 20 ms of modelled fsyncs: far past one 150 ms budget.
      const rows = Array.from({ length: 20 }, (_, n) => new Blob([new Uint8Array(2048).fill(n)]))
      await paced.settle(rows, scope)
      for (const row of rows) expect(paced.resolve(row, scope)).toHaveProperty("fileRef")
    } finally {
      await paced.close()
    }
  })

  it("counts nothing for a binary it could not post", async () => {
    const file = path.join(root, "backing.bin")
    fs.writeFileSync(file, new Uint8Array(4096).fill(2))
    const fileBacked = await fs.openAsBlob(file)
    const trans = {}
    expect(() => prefetcher.prefetch({ fileBacked }, {}, trans)).toThrow()
    expect(prefetcher.groupBacklog(trans)).toEqual({ jobs: 0, kib: 0 })
  })
})
