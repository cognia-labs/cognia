import type { ChildProcess } from "node:child_process"

/**
 * Node/libuv reaps the leader before emitting exit. After that callback a
 * numeric pgid is only a probe target, never authority to signal: the old
 * group could have emptied and its number been reused. ESRCH retires even
 * that probe identity permanently. Windows needs a Job Object for proof.
 * Keeps probe/signal authority separate from leader lifecycle status.
 */
export function createProcessGroup(
  pid: number | undefined,
  supported = process.platform !== "win32",
  kill: (pid: number, signal: NodeJS.Signals | number) => unknown = (pid, signal) =>
    process.kill(pid, signal)
) {
  let identity = pid
  let leaderExited = false
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
      leaderExited = true
      isLive()
    },
    signal(signal: NodeJS.Signals | number): boolean {
      if (!isLive() || leaderExited || !identity || !supported) return false
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
      leaderExited = true
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
