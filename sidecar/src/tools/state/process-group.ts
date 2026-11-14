import type { ChildProcess } from "node:child_process"

/**
 * Node/libuv reaps the leader before emitting exit. After that the pgid number
 * stays pinned only while the group still has members, so every signal is
 * sent right after a probe that found the group live: escalation (SIGKILL
 * after a SIGTERM the leader died of) still reaches survivors. The accepted
 * residue is the group emptying and its number being reused between those two
 * calls (ADR-0244). ESRCH retires the identity permanently; retirement ends
 * signal authority. Windows needs a Job Object for proof.
 */
export function createProcessGroup(
  pid: number | undefined,
  supported = process.platform !== "win32",
  kill: (pid: number, signal: NodeJS.Signals | number) => unknown = (pid, signal) =>
    process.kill(pid, signal)
) {
  let identity = pid
  let empty = false
  function isLive(): boolean {
    if (empty) return false
    if (!supported || !identity) return true
    try {
      kill(-identity, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        identity = undefined
        empty = true
        return false
      }
    }
    return true
  }
  return {
    isLive,
    leaderExited() {
      isLive()
    },
    signal(signal: NodeJS.Signals | number): boolean {
      // Probe immediately before the signal: a live group pins its number.
      if (!supported || !identity || !isLive()) return false
      try {
        kill(-identity, signal)
      } catch {
        isLive()
      }
      return true
    },
    retire() {
      const confirmed = !isLive()
      identity = undefined
      return confirmed
    },
  }
}

export function trackChildProcessGroup(child: ChildProcess, supported?: boolean) {
  const group = createProcessGroup(child.pid, supported)
  child.once("exit", () => group.leaderExited())
  child.once("error", () => group.leaderExited())
  return group
}

export type ProcessGroup = ReturnType<typeof createProcessGroup>
