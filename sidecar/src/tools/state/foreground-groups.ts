// Foreground process groups, tracked per session (ADR-0244).
//
// Every foreground child a tool starts (a `bash` command, a `run_code`
// program) runs as the leader of its own process group and is registered
// here under the session that owns it. Stop's process teardown
// (`ToolSession.disposeProcesses`) signals the session's groups and waits for
// them, its stop proof asks whether any is still live, and a sidecar that
// exits mid-call takes the groups down instead of orphaning them. Shared tool
// state, so tool categories reach it without depending on each other.

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

import { trackChildProcessGroup, type ProcessGroup } from "./process-group.ts"

/** Grace between SIGTERM and SIGKILL when an interrupt or timeout stops a run. */
export const KILL_GRACE_MS = 2_000
/** After the SIGKILL, how long to wait for `close` before giving up on the pipes. */
export const PIPE_RELEASE_MS = 500

// A foreground command runs as the leader of its own process group (POSIX), so
// stopping it reaches everything the shell started — `sh -c "node job.cjs"`
// often forks rather than execs, and killing only the shell left the real
// worker running after Esc. The groups still alive are tracked so a sidecar
// that exits mid-command takes them down instead of orphaning them.
export const GROUP_KILL = process.platform !== "win32"
const liveForegroundGroups = new Map<
  ChildProcess,
  {
    sessionId: string | undefined
    child: ChildProcess
    groupProofSupported: boolean
    group: ProcessGroup
  }
>()
const unconfirmedForegroundSessions = new Set<string>()
let exitHookInstalled = false

/** Register a foreground process group with the session that owns it. */
export function trackForegroundGroup(
  sessionId: string | undefined,
  child: ChildProcess,
  groupProofSupported: boolean
): void {
  liveForegroundGroups.set(child, {
    sessionId,
    child,
    groupProofSupported,
    group: trackChildProcessGroup(child, groupProofSupported),
  })
  if (!groupProofSupported) {
    if (sessionId) unconfirmedForegroundSessions.add(sessionId)
    child.once("exit", () => liveForegroundGroups.delete(child))
    child.once("error", () => liveForegroundGroups.delete(child))
  }
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on("exit", () => {
    for (const { group } of liveForegroundGroups.values()) group.signal("SIGKILL")
  })
}

export function foregroundGroupIsLive(groupId: ChildProcess): boolean {
  const group = liveForegroundGroups.get(groupId)
  if (!group) return false
  if (!group.group.isLive()) {
    liveForegroundGroups.delete(groupId)
    return false
  }
  return true
}

export function hasSessionForegroundGroups(sessionId: string): boolean {
  return (
    unconfirmedForegroundSessions.has(sessionId) ||
    [...liveForegroundGroups].some(
      ([id, group]) => group.sessionId === sessionId && foregroundGroupIsLive(id)
    )
  )
}

export function hasSessionForegroundProcesses(sessionId: string): boolean {
  return [...liveForegroundGroups.values()].some(
    (group) =>
      group.sessionId === sessionId &&
      group.child.exitCode === null &&
      group.child.signalCode === null
  )
}

export async function disposeForegroundGroups(sessionId: string): Promise<void> {
  const groups = [...liveForegroundGroups].filter(([, group]) => group.sessionId === sessionId)
  const pending = () =>
    groups.some(([id, group]) =>
      group.groupProofSupported
        ? foregroundGroupIsLive(id)
        : liveForegroundGroups.has(id) &&
          group.child.exitCode === null &&
          group.child.signalCode === null
    )
  for (const [id, group] of groups) {
    if (foregroundGroupIsLive(id)) signalProcessTree(group.child, "SIGTERM")
  }
  const deadline = Date.now() + KILL_GRACE_MS
  while (pending() && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  for (const [id, group] of groups) {
    if (foregroundGroupIsLive(id)) signalProcessTree(group.child, "SIGKILL")
  }
  const killDeadline = Date.now() + PIPE_RELEASE_MS
  while (pending() && Date.now() < killDeadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  if (pending()) throw new Error(`session ${sessionId} still has live foreground process groups`)
}

export function retireForegroundGroups(sessionId: string): boolean {
  let confirmed = !unconfirmedForegroundSessions.has(sessionId)
  for (const [id, entry] of liveForegroundGroups) {
    if (entry.sessionId !== sessionId) continue
    if (!entry.group.retire()) confirmed = false
    liveForegroundGroups.delete(id)
  }
  unconfirmedForegroundSessions.delete(sessionId)
  return confirmed
}

/**
 * Signal a foreground run and every process it started: the whole process
 * group on POSIX, `taskkill /T` (the tree) on Windows, where `child.kill()`
 * would only end the shell wrapper.
 */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (GROUP_KILL) {
      liveForegroundGroups.get(child)?.group.signal(signal)
    } else if (child.exitCode === null && child.signalCode === null) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => {})
    }
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/** Signal one tracked group (no-op once it is gone or was never tracked). */
export function signalForegroundGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  liveForegroundGroups.get(child)?.group.signal(signal)
}
