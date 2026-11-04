/** Cross-process protection for the generated catalogs and their matching assets. */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { DatabaseSync } from "node:sqlite"
import { spawn, spawnSync } from "node:child_process"

// A native resource must stay strongly rooted while an async callback waits.
// In particular, an unresolved Promise need not retain its suspended frame.
const activeWriterConnections = new Set()

function windowsJobCommand(mode, jobName) {
  if (process.platform !== "win32") throw new Error("Windows artifact jobs require Windows")
  if (!/^Global\\CogniaPluginArtifact-[a-f0-9-]{36}$/.test(jobName))
    throw new Error("Invalid Windows artifact job identity")
  const source = fs.readFileSync(
    new URL("./plugin-artifact-windows-job.ps1", import.meta.url),
    "utf8"
  )
  const script = `& {${source}\n} -Mode ${mode} -JobName '${jobName}' -OwnerPid ${process.pid}`
  return {
    command: path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe"
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  }
}

/** Attach before compiler imports; Windows Job membership also covers orphaned descendants. */
export async function createWindowsPluginArtifactJob() {
  const name = `Global\\CogniaPluginArtifact-${randomUUID()}`
  const { command, args } = windowsJobCommand("attach", name)
  // libuv kills non-detached children when their parent exits, but Windows
  // PowerShell cannot reliably start detached. A detached Node guardian owns
  // PowerShell's lifetime and keeps both outside the compiler's libuv job.
  const guardian = `const {spawn}=require('node:child_process');
const child=spawn(process.argv[1],process.argv.slice(2),{stdio:['ignore','inherit','inherit'],windowsHide:true});
child.once('error',error=>{console.error(error.message);process.exitCode=1});
child.once('exit',code=>{process.exitCode=code??1});`
  const guardianEnv = { ...process.env }
  for (const key of Object.keys(guardianEnv))
    if (["NODE_OPTIONS", "COGNIA_PLUGIN_COMPILATION_LEASE"].includes(key.toUpperCase()))
      delete guardianEnv[key]
  const child = spawn(process.execPath, ["-e", guardian, command, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: true,
    env: guardianEnv,
  })
  return new Promise((resolve, reject) => {
    let output = "",
      diagnostics = "",
      settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      child.off("error", fail)
      child.off("exit", exited)
      child.stdout.destroy()
      child.stderr.destroy()
      if (error) {
        child.kill()
        reject(error)
      } else {
        child.unref()
        resolve({ name, guardianPid: child.pid })
      }
    }
    const fail = (error) => finish(error)
    const exited = (code) =>
      finish(new Error(`Windows artifact job could not attach (${code}): ${diagnostics.trim()}`))
    const deadline = globalThis.setTimeout(
      () => finish(new Error("Windows artifact job attach timed out")),
      30000
    )
    child.once("error", fail)
    child.once("exit", exited)
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-4096)
    })
    child.stdout.on("data", (chunk) => {
      output += chunk
      if (output.split(/\r?\n/).includes(`ready:${name}`)) finish()
    })
  })
}

export function windowsPluginArtifactJobActive(name) {
  const { command, args } = windowsJobCommand("query", name)
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30000 })
  if (result.error) throw result.error
  if (result.status !== 0 || !/^(active|idle)$/.test(result.stdout.trim()))
    throw new Error(`Cannot query Windows artifact job: ${result.stderr.trim()}`)
  return result.stdout.trim() === "active"
}

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
export function activePluginArtifactLeases(
  directory,
  { jobActive = windowsPluginArtifactJobActive } = {}
) {
  const leases = []
  for (const file of fs.readdirSync(directory).filter((name) => /^reader-.*\.json$/.test(name))) {
    const absolute = path.join(directory, file)
    const lease = JSON.parse(fs.readFileSync(absolute, "utf8"))
    const alive = lease.windowsJob
      ? jobActive(lease.windowsJob)
      : lease.processGroup && process.platform !== "win32"
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
  { processGroup = false, unconfirmedFamily = false, windowsJob, windowsJobOwner } = {}
) {
  const token = randomUUID(),
    file = path.join(directory, `reader-${token}.json`)
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: process.pid,
      token,
      artifactSha256,
      processGroup,
      unconfirmedFamily,
      windowsJob,
      windowsJobOwner,
    }),
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
  if (!processGroup && !unconfirmedFamily && !windowsJob) process.once("exit", release)
  return release
}
