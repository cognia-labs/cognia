// Session-scoped registry of background shells started by `bash` with
// `run_in_background: true`. Mirrors the tracked-PID discipline in
// `../builtin/process/`: the agent can only read/kill shells IT started this session,
// and the dispatch layer calls `killAll()` at session teardown so no
// background process outlives the chat session (no orphans).
//
// Output is held in a per-shell ring buffer (≤256 KB, oldest bytes dropped);
// `read()` is a NON-destructive incremental read — it returns only the bytes
// appended since the previous poll (Claude Code's BashOutput semantics) and
// advances a cursor, so repeated polls don't re-show old output.

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { trackChildProcessGroup, type ProcessGroup } from "./process-group.ts"

import { pickStreamDecoder } from "../../platform/process/console-decode.ts"

/** Max bytes of combined stdout+stderr retained per background shell. */
export const MAX_RING_BYTES = 256 * 1024

/**
 * Output tail a settlement carries into its session (ADR-0249 §2): the `bash`
 * tool's inline output budget. The host supervisor uses the same number
 * (`crates/cognia-jobs/src/limits.rs` `JOB_OUTPUT_TAIL_BYTES`).
 */
export const SETTLEMENT_TAIL_CHARS = 30_000

/**
 * How long an exited shell waits for its pipes to close before it settles. A
 * grandchild that keeps a pipe open must not hold the settlement back.
 */
export const SETTLEMENT_DRAIN_GRACE_MS = 250

/** Whether a job's end is delivered into its session (ADR-0249 §5). */
export type BackgroundNotify = "on_exit" | "none"

/** Who stopped a job that did not end on its own. */
export type BackgroundStopCause = "agent" | "person" | "owner" | "shutdown"

/**
 * Where an agent-started job or monitor reports its end (ADR-0249): the chat
 * session the agent's turn runs in, not the executor id that owns the work.
 */
export interface BackgroundDelivery {
  sessionId: string
  /** The run the executor was created for, when the send named one. */
  runId?: string | undefined
}

/**
 * One job's end, in the host supervisor's `JobExit` wire shape so a consumer
 * settles a host job and an in-process shell the same way.
 */
export interface BackgroundJobSettlement {
  jobId: string
  status: "exited" | "killed" | "interrupted" | "failed"
  exitCode: number | null
  startedAtMs: number
  endedAtMs: number
  command: string
  label?: string | undefined
  outputTail?: string | undefined
  delivery?:
    | {
        sessionId: string
        runId?: string | undefined
        notify: BackgroundNotify
        stoppedBy?: BackgroundStopCause | undefined
      }
    | undefined
}

export type BgShellStatus = "running" | "exited"

export interface BgShellEntry {
  id: string
  command: string
  child: ChildProcess
  pid: number | undefined
  /** Combined stdout+stderr ring buffer. */
  buffer: string
  /** Bytes already returned via read(). */
  cursor: number
  status: BgShellStatus
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  cwd: string | undefined
  waiters: Set<() => void>
  label?: string | undefined
  notify: BackgroundNotify
  /** Set when a kill, not the program, ended it. */
  stoppedBy?: BackgroundStopCause | undefined
}

export interface SpawnBackgroundOptions {
  command: string
  shell: string
  shellArgs: string[]
  cwd?: string | undefined
  isWin?: boolean | undefined
  env?: NodeJS.ProcessEnv | undefined
  label?: string | null | undefined
  /** Default `on_exit`: the end is delivered into the session. */
  notify?: BackgroundNotify | undefined
}

export interface ReadOptions {
  filter?: string | undefined
  maxChars?: number | undefined
}

export type ReadResult =
  | { ok: true; data: string; status: BgShellStatus; exitCode: number | null }
  | { ok: false; reason: "not_found" }

export type KillResult = { ok: true; exitCode: number | null } | { ok: false; reason: "not_found" }

export type KillByPidResult = { matched: false } | { matched: true; ok: true; jobId: string }

export interface BgShellSummary {
  id: string
  command: string
  status: BgShellStatus
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  durationMs: number
  cwd: string | undefined
}

export interface BgShellRegistry {
  spawnBackground(opts: SpawnBackgroundOptions): BgShellEntry
  read(id: string, opts?: ReadOptions): ReadResult
  waitForOutput(id: string, opts?: ReadOptions & { waitMs?: number }): Promise<ReadResult>
  kill(id: string, signal?: NodeJS.Signals | number): KillResult
  killByPid(pid: number): KillByPidResult
  killAll(): Promise<void>
  hasLiveProcesses?(): boolean
  list(): BgShellSummary[]
}

/** Create a fresh per-session background-shell registry. */
export function createBgShellRegistry({
  groupProofSupported = process.platform !== "win32",
  delivery,
  onSettled,
}: {
  groupProofSupported?: boolean
  /** The session agent-started shells report into; absent, nothing is reported. */
  delivery?: BackgroundDelivery | undefined
  /** Called once per shell when it ends, for a session with a delivery. */
  onSettled?: ((settlement: BackgroundJobSettlement) => void) | undefined
} = {}): BgShellRegistry {
  const shells = new Map<string, BgShellEntry>()
  let proofUnavailable = false
  const groups = new Map<string, ProcessGroup>()
  let closing = false
  let disposing: Promise<void> | undefined

  function spawnBackground({
    command,
    shell,
    shellArgs,
    cwd,
    isWin,
    env,
    label,
    notify = "on_exit",
  }: SpawnBackgroundOptions): BgShellEntry {
    if (closing) throw new Error("background shell registry is closing")
    const id = randomUUID()
    const child = spawn(shell, shellArgs, {
      cwd,
      // `env` carries the PowerShell-scrubbed environment when bash.ts supplies
      // it; undefined (legacy callers / tests) inherits the parent process env.
      ...(env ? { env } : {}),
      windowsHide: true,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: Boolean(isWin),
      stdio: ["ignore", "pipe", "pipe"],
    })
    const entry: BgShellEntry = {
      id,
      command,
      child,
      pid: child.pid,
      buffer: "",
      cursor: 0,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      cwd,
      waiters: new Set(),
      ...(label ? { label } : {}),
      notify,
    }
    groups.set(id, trackChildProcessGroup(child, groupProofSupported))
    if (!groupProofSupported) proofUnavailable = true
    const notifyWaiters = () => {
      for (const wake of [...entry.waiters]) wake()
    }
    // Decode bytes auto-detecting the console encoding (UTF-8, or the OEM code
    // page on Windows). One streaming decoder per shell, picked from the first
    // chunk, so multibyte chars split across chunks decode intact. Error strings
    // arrive already-decoded and pass straight through.
    let decoder: TextDecoder | null = null
    const cap = (chunk: Buffer | string) => {
      let s: string
      if (typeof chunk === "string") {
        s = chunk
      } else {
        if (!decoder) decoder = pickStreamDecoder(chunk)
        s = decoder.decode(chunk, { stream: true })
      }
      if (!s) return
      entry.buffer += s
      if (entry.buffer.length > MAX_RING_BYTES) {
        const drop = entry.buffer.length - MAX_RING_BYTES
        entry.buffer = entry.buffer.slice(drop)
        // Keep the cursor anchored to surviving bytes so the next read()
        // returns a clean delta rather than re-emitting shifted output.
        entry.cursor = Math.max(0, entry.cursor - drop)
      }
      notifyWaiters()
    }
    // Report the end once, with the output that arrived: on `close`, or a
    // short grace after `exit` when a grandchild keeps the pipes open.
    let reported = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const report = () => {
      if (reported) return
      reported = true
      if (graceTimer) clearTimeout(graceTimer)
      if (!delivery || !onSettled) return
      try {
        onSettled({
          jobId: entry.id,
          status: entry.stoppedBy ? "killed" : "exited",
          exitCode: entry.stoppedBy ? null : entry.exitCode,
          startedAtMs: entry.startedAt,
          endedAtMs: entry.endedAt ?? Date.now(),
          command: entry.command,
          ...(entry.label ? { label: entry.label } : {}),
          outputTail: entry.buffer.slice(-SETTLEMENT_TAIL_CHARS),
          delivery: {
            sessionId: delivery.sessionId,
            ...(delivery.runId ? { runId: delivery.runId } : {}),
            notify: entry.notify,
            ...(entry.stoppedBy ? { stoppedBy: entry.stoppedBy } : {}),
          },
        })
      } catch {
        // A consumer's failure must not break the shell's own lifecycle.
      }
    }
    child.stdout?.on("data", cap)
    child.stderr?.on("data", cap)
    child.on("error", (err: Error) => {
      cap(String(err?.message ?? err))
      if (entry.status !== "exited") {
        entry.status = "exited"
        entry.exitCode = entry.exitCode ?? null
        entry.endedAt = Date.now()
        notifyWaiters()
      }
      report()
    })
    child.on("exit", (code) => {
      entry.status = "exited"
      entry.exitCode = code
      entry.endedAt = Date.now()
      notifyWaiters()
      graceTimer ??= setTimeout(report, SETTLEMENT_DRAIN_GRACE_MS)
      graceTimer.unref?.()
    })
    child.on("close", (code) => {
      if (decoder) cap(decoder.decode())
      entry.status = "exited"
      entry.exitCode = code
      entry.endedAt = Date.now()
      notifyWaiters()
      report()
    })
    shells.set(id, entry)
    return entry
  }

  function read(id: string, { filter, maxChars }: ReadOptions = {}): ReadResult {
    const entry = shells.get(id)
    if (!entry) return { ok: false, reason: "not_found" }
    const cap =
      maxChars !== undefined && Number.isFinite(maxChars)
        ? Math.max(1, Math.floor(maxChars))
        : undefined
    const end = cap ? Math.min(entry.buffer.length, entry.cursor + cap) : entry.buffer.length
    let delta = entry.buffer.slice(entry.cursor, end)
    entry.cursor = end
    if (filter && delta) {
      try {
        const re = new RegExp(filter)
        delta = delta
          .split("\n")
          .filter((line) => re.test(line))
          .join("\n")
      } catch {
        // Invalid regex — ignore the filter and return the raw delta.
      }
    }
    return { ok: true, data: delta, status: entry.status, exitCode: entry.exitCode }
  }

  async function waitForOutput(
    id: string,
    { filter, maxChars, waitMs = 0 }: ReadOptions & { waitMs?: number } = {}
  ): Promise<ReadResult> {
    const immediate = read(id, { filter, maxChars })
    if (!immediate.ok || immediate.data || immediate.status === "exited" || waitMs <= 0) {
      return immediate
    }
    const entry = shells.get(id)
    if (!entry) return { ok: false, reason: "not_found" }
    const boundedWait = Math.min(Math.max(0, Math.floor(waitMs)), 30_000)
    return new Promise<ReadResult>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        entry.waiters.delete(finish)
        resolve(read(id, { filter, maxChars }))
      }
      const timer = setTimeout(finish, boundedWait)
      entry.waiters.add(finish)
      // Close/output may have landed between the immediate read and waiter
      // registration. Re-check once to avoid sleeping through that race.
      if (entry.status === "exited" || entry.buffer.length > entry.cursor) finish()
    })
  }

  function signalEntry(entry: BgShellEntry, signal: NodeJS.Signals | number = "SIGTERM") {
    if (process.platform !== "win32") {
      groups.get(entry.id)?.signal(signal)
    } else if (entry.pid && entry.status === "running")
      spawn("taskkill", ["/PID", String(entry.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => {})
  }

  function groupIsLive(entry: BgShellEntry): boolean {
    return groups.get(entry.id)?.isLive() ?? true
  }

  function killByPid(pid: number): KillByPidResult {
    const entry = [...shells.values()].find((candidate) => candidate.pid === pid)
    if (!entry) return { matched: false }
    kill(entry.id)
    return { matched: true, ok: true, jobId: entry.id }
  }

  function kill(id: string, signal?: NodeJS.Signals | number): KillResult {
    const entry = shells.get(id)
    if (!entry) return { ok: false, reason: "not_found" }
    if (entry.status === "running") {
      // Only the agent's own tools reach this registry's kill (`kill_shell`,
      // `terminate_process`): its stop does not wake it.
      entry.stoppedBy ??= "agent"
      try {
        signalEntry(entry, signal)
      } catch {
        // Already gone — idempotent.
      }
    }
    return { ok: true, exitCode: entry.exitCode }
  }

  function killAll(): Promise<void> {
    if (disposing) return disposing
    closing = true
    const pending = [...shells.values()].map(async (entry) => {
      const pending = () => (groupProofSupported ? groupIsLive(entry) : entry.status === "running")
      const start = Date.now()
      let escalated = false
      if (entry.status === "running") entry.stoppedBy ??= "owner"
      try {
        if (pending()) signalEntry(entry)
      } catch {
        /* verify below */
      }
      while (pending()) {
        if (!escalated && Date.now() - start >= 1_000) {
          try {
            signalEntry(entry, "SIGKILL")
          } catch {
            /* verify below */
          }
          escalated = true
        }
        if (Date.now() - start >= 2_000)
          throw new Error(`background shell ${entry.id} process group did not exit`)
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
      shells.delete(entry.id)
      groups.delete(entry.id)
    })
    disposing = Promise.allSettled(pending).then((results) => {
      const errors = results.filter((result) => result.status === "rejected")
      // Fold unknown into this registry's owner record, then retire all pgids.
      for (const group of groups.values()) if (!group.retire()) proofUnavailable = true
      groups.clear()
      shells.clear()
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "background shell cleanup failed"
        )
    })
    return disposing
  }

  function list(): BgShellSummary[] {
    return [...shells.values()].map((e) => ({
      id: e.id,
      command: e.command,
      status: e.status,
      exitCode: e.exitCode,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      durationMs: Math.max(0, (e.endedAt ?? Date.now()) - e.startedAt),
      cwd: e.cwd,
    }))
  }

  return {
    spawnBackground,
    read,
    waitForOutput,
    kill,
    killByPid,
    killAll,
    list,
    hasLiveProcesses: () => proofUnavailable || [...shells.values()].some(groupIsLive),
  }
}
