import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DurabilityFault } from "./types"

type Store = "journal" | "sqlite" | "binary" | "checkpoint"
const localSharedLeases = new Map<string, { holders: number; release: () => void }>()

function lockFile(root: string, store: Store): string {
  return path.join(root, `.${store}-writer.sqlite`)
}

export function hasLiveWriter(root: string, store: Store): boolean {
  if (!fs.existsSync(lockFile(root, store))) return false
  try {
    acquireWriterLease(root, store)()
    return false
  } catch (error) {
    if (error instanceof DurabilityFault && error.code === "writer-busy") return true
    throw error
  }
}

/** SQLite's kernel locks are released on process death, with no PID or stale-file heuristic. */
export function acquireWriterLease(
  root: string,
  store: Store,
  opts: { shared?: boolean } = {}
): () => void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const key = path.join(fs.realpathSync(root), path.basename(lockFile(root, store)))
  if (opts.shared) {
    let lease = localSharedLeases.get(key)
    if (!lease) {
      lease = { holders: 0, release: acquireWriterLease(root, store) }
      localSharedLeases.set(key, lease)
    }
    lease.holders += 1
    let released = false
    return () => {
      if (released) return
      released = true
      if (--lease.holders === 0) {
        try {
          lease.release()
        } finally {
          localSharedLeases.delete(key)
        }
      }
    }
  }
  const db = new DatabaseSync(key)
  try {
    if (process.platform !== "win32") fs.chmodSync(key, 0o600)
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;")
  } catch (error) {
    db.close()
    const code = (error as { errcode?: number }).errcode
    if (code === 5 || code === 6) {
      throw new DurabilityFault(
        "writer-busy",
        `${store} store has a live writer; stop it before maintenance`
      )
    }
    throw error
  }
  let released = false
  return () => {
    if (released) return
    db.close()
    released = true
  }
}
