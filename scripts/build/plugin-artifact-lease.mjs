/** Cross-process protection for the generated catalogs and their matching assets. */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"

// A native resource must stay strongly rooted while an async callback waits.
// In particular, an unresolved Promise need not retain its suspended frame.
const activeWriterConnections = new Set()

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid plugin artifact lock owner")
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    if (error.code === "EPERM") return true
    throw error
  }
}

export async function withPluginArtifactLock(root, operation, { timeoutMs = 5000 } = {}) {
  const directory = path.join(root, ".cache/plugin-artifact-access")
  fs.mkdirSync(directory, { recursive: true })
  // Kernel-backed SQLite locking is released even on SIGKILL. PID-file locks
  // cannot safely compare-and-remove a dead owner's reused pathname.
  const database = new DatabaseSync(path.join(directory, "writer.sqlite"))
  activeWriterConnections.add(database)
  const deadline = Date.now() + timeoutMs
  try {
    database.exec("PRAGMA busy_timeout = 0")
    while (true) {
      try {
        database.exec("CREATE TABLE IF NOT EXISTS plugin_artifact_mutex (id INTEGER)")
        database.exec("BEGIN IMMEDIATE")
        if (!database.isTransaction)
          throw new Error("Plugin artifact mutex did not begin a transaction")
        break
      } catch (error) {
        if (error.errcode !== 5 && error.code !== "SQLITE_BUSY") throw error
        if (Date.now() >= deadline)
          throw new Error(
            "artifact_in_use: another process is preparing plugin artifacts; use an isolated checkout"
          )
        await setTimeout(20)
      }
    }
    try {
      return await operation(directory)
    } finally {
      database.exec("ROLLBACK")
    }
  } finally {
    database.close()
    activeWriterConnections.delete(database)
  }
}

/** Caller holds the writer mutex while inspecting or adding readers. */
export function activePluginArtifactLeases(directory) {
  const leases = []
  for (const file of fs.readdirSync(directory).filter((name) => /^reader-.*\.json$/.test(name))) {
    const absolute = path.join(directory, file)
    const lease = JSON.parse(fs.readFileSync(absolute, "utf8"))
    const alive =
      lease.processGroup && process.platform !== "win32"
        ? (() => {
            if (!Number.isInteger(lease.pid) || lease.pid <= 0)
              throw new Error("Invalid plugin artifact lock owner")
            try {
              process.kill(-lease.pid, 0)
              return true
            } catch (error) {
              if (error.code === "ESRCH") return false
              if (error.code === "EPERM") return true
              throw error
            }
          })()
        : ownerAlive(lease.pid)
    if (alive || lease.unconfirmedFamily) leases.push(lease)
    else fs.rmSync(absolute, { force: true })
  }
  return leases
}

export function createPluginArtifactLease(
  directory,
  artifactSha256,
  { processGroup = false, unconfirmedFamily = false } = {}
) {
  const token = randomUUID(),
    file = path.join(directory, `reader-${token}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, token, artifactSha256, processGroup, unconfirmedFamily }),
    { flag: "wx" }
  )
  let released = false
  const release = () => {
    if (released) return
    released = true
    fs.rmSync(file, { force: true })
    process.off("exit", release)
  }
  // A POSIX process family can outlive its leader even on a normal exit.
  // Leave its record for the next writer to reap only after the entire group
  // has gone; removing it at the leader's exit would lose orphan protection.
  // An unconfirmed family also cannot be discarded just because its leader exits.
  if (!processGroup && !unconfirmedFamily) process.once("exit", release)
  return release
}
