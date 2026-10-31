/** Node-only auth mutex shared by independent cognia-agent processes. */
import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import type { withAuthLock } from "@/lib/plugin/auth/connection-credentials"

export class FileLockTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the CLI auth file lock")
    this.name = "FileLockTimeoutError"
  }
}

export class FileLockLostError extends Error {
  constructor() {
    super("The CLI auth file lock is no longer held")
    this.name = "FileLockLostError"
  }
}

export interface FileLockOptions {
  waitMs?: number
  retryMs?: number
  /** Ten minutes by default, well beyond the bounded provider refresh. */
  staleMs?: number
}

/** Keep filenames bounded and traversal-free without aliasing distinct names. */
export function sanitizedAuthName(name: string): string {
  const prefix = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "auth"
  return `${prefix}-${createHash("sha256").update(name).digest("hex")}`
}

export function fileLockPath(home: string, name: string, category: string): string {
  return path.join(
    home,
    "auth",
    "locks",
    `${sanitizedAuthName(JSON.stringify([category, name]))}.lock`
  )
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

function readLock(file: string): { raw: string; modified: number } | null {
  // Read/stat the same inode even if another process replaces the pathname.
  let fd: number
  try {
    fd = fs.openSync(file, "r")
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  try {
    return { raw: fs.readFileSync(fd, "utf8"), modified: fs.fstatSync(fd).mtimeMs }
  } finally {
    fs.closeSync(fd)
  }
}

function pidDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means it exists but belongs to another user; never steal it.
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}

function isStale(record: { raw: string; modified: number }, staleMs: number): boolean {
  let value: { pid?: unknown; timestamp?: unknown } = {}
  try {
    value = JSON.parse(record.raw) ?? {}
  } catch {
    /* An interrupted initial write. */
  }
  if (Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && pidDead(value.pid as number))
    return true
  const timestamp =
    typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      ? value.timestamp
      : record.modified
  return Date.now() - timestamp > staleMs
}

/** Serialize stale unlink and release. Checking a token then unlinking alone
 * has a cross-process TOCTOU: a second reaper can delete a fresh successor.
 * Guards are published with complete contents by an exclusive hard link and
 * can ONLY be reclaimed after their pid dies, so a live guard cannot be stolen.
 * A crashed guard is recovered under the next guard using the same protocol.
 * Storage/CAS tasks retain it through commit: even a paused live writer cannot
 * resume after an age-based takeover and overwrite a successor. Lineage locks
 * release it while awaiting the vendor; credential CAS fences late results. */
function tryGuard(file: string): (() => void) | null {
  const raw = JSON.stringify({ pid: process.pid, token: randomUUID() })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    try {
      fs.linkSync(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const previous = readLock(file)
      if (previous && guardIsDead(previous.raw)) {
        const release = tryGuard(`${file}.guard`)
        if (release) {
          try {
            const current = readLock(file)
            if (current && guardIsDead(current.raw)) fs.unlinkSync(file)
          } finally {
            release()
          }
        }
      }
      return null
    }
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  return () => {
    // Guard contents are immutable, and nobody can reap this live pid.
    fs.unlinkSync(file)
  }
}

function guardIsDead(raw: string): boolean {
  const value = JSON.parse(raw) as { pid: number }
  return Number.isSafeInteger(value.pid) && value.pid > 0 && pidDead(value.pid)
}

function withGuardSync(file: string, task: () => void): void {
  const deadline = performance.now() + 5000
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let release: (() => void) | null
  while (!(release = tryGuard(file))) {
    if (performance.now() >= deadline) throw new FileLockTimeoutError()
    Atomics.wait(sleeper, 0, 0, 5)
  }
  try {
    task()
  } finally {
    release()
  }
}

interface HeldFileLock {
  assertHeld(): void
  release(): void
}

function tryAcquire(file: string, staleMs: number, holdGuard: boolean): HeldFileLock | null {
  const releaseGuard = tryGuard(`${file}.guard`)
  if (!releaseGuard) return null
  let retained = false
  try {
    const raw = JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: randomUUID() })
    let fd: number
    try {
      fd = fs.openSync(file, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const current = readLock(file)
      if (current && isStale(current, staleMs)) fs.unlinkSync(file)
      return null
    }
    try {
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, raw, "utf8")
    } catch (error) {
      // Initialization also holds the guard: a stale reaper cannot replace
      // this inode before a failed write has finished cleaning it up.
      const created = fs.fstatSync(fd)
      try {
        const current = fs.statSync(file)
        if (current.dev === created.dev && current.ino === created.ino) fs.unlinkSync(file)
      } catch (cleanupError) {
        if (!missing(cleanupError)) throw cleanupError
      }
      throw error
    } finally {
      fs.closeSync(fd)
    }
    let held = true
    retained = holdGuard
    return {
      assertHeld() {
        if (!held || readLock(file)?.raw !== raw) throw new FileLockLostError()
      },
      release() {
        held = false
        const removeOwnLock = () => {
          if (readLock(file)?.raw === raw) fs.unlinkSync(file)
        }
        if (holdGuard) {
          try {
            removeOwnLock()
          } finally {
            releaseGuard()
          }
        } else {
          // Lineage tasks can await provider I/O; reacquire the short guard.
          withGuardSync(`${file}.guard`, removeOwnLock)
        }
      },
    }
  } finally {
    if (!retained) releaseGuard()
  }
}

function prepare(home: string, name: string, category: string, options: FileLockOptions) {
  const waitMs = options.waitMs ?? (category === "lineage" ? 65_000 : 5_000)
  const retryMs = options.retryMs ?? 20
  const staleMs = options.staleMs ?? 10 * 60_000
  if (
    !Number.isFinite(waitMs) ||
    waitMs < 0 ||
    !Number.isFinite(retryMs) ||
    retryMs <= 0 ||
    !Number.isFinite(staleMs) ||
    staleMs <= 0
  )
    throw new Error("Invalid CLI file lock timing")
  for (const dir of [path.join(home, "auth"), path.join(home, "auth", "locks")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
  }
  return { file: fileLockPath(home, name, category), waitMs, retryMs, staleMs }
}

/** Signature matches the Host seam, including its lease assertion callback. */
export function createCliFileLock(
  home: string,
  options: FileLockOptions = {}
): typeof withAuthLock {
  return async (name, task, category) => {
    const { file, waitMs, retryMs, staleMs } = prepare(home, name, category, options)
    const deadline = performance.now() + waitMs
    let lease: HeldFileLock | null
    while (!(lease = tryAcquire(file, staleMs, category !== "lineage"))) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new FileLockTimeoutError()
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, remaining)))
    }
    try {
      lease.assertHeld()
      const result = await task(lease.assertHeld)
      lease.assertHeld()
      return result
    } finally {
      lease.release()
    }
  }
}

/** Ownership and the legacy CLI enable overlay have synchronous public APIs.
 * Only use for synchronous tasks; never block on an async holder in this realm. */
export function withCliFileLockSync<T>(
  home: string,
  name: string,
  task: (assertHeld: () => void) => T,
  category: string,
  options: FileLockOptions = {}
): T {
  const { file, waitMs, retryMs, staleMs } = prepare(home, name, category, options)
  const deadline = performance.now() + waitMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let lease: HeldFileLock | null
  while (!(lease = tryAcquire(file, staleMs, true))) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new FileLockTimeoutError()
    Atomics.wait(sleeper, 0, 0, Math.min(retryMs, remaining))
  }
  try {
    lease.assertHeld()
    const result = task(lease.assertHeld)
    lease.assertHeld()
    return result
  } finally {
    lease.release()
  }
}
