"use client"

import {
  retainHeadlessPersonalEgress,
  retainTerminalPersonalEgress,
  confirmHeadlessPersonalEgressExit,
  __clearTerminalPersonalEgressForTesting,
} from "./personal-egress"
import type { PersonalEgressContext } from "@/lib/execution/personal-egress"

/**
 * Run-scoped bookkeeping for terminal sessions opened by workflow nodes
 * (`action.terminal.session.open`). Whatever a run opens — headless
 * private PTYs or visible dock tabs — is recorded here so the workflow
 * orchestrator can close everything deterministically when the run ends
 * (success OR failure), no matter how the graph terminated.
 *
 * Module-level singleton (mirrors `lib/terminal/session-registry.ts`):
 * workflow execution is renderer-local today, so a Map is sufficient.
 */

export type RunSessionMode = "dock" | "headless"

interface RunSessionEntry {
  sessionId: string
  mode: RunSessionMode
}

const byRun = new Map<string, RunSessionEntry[]>()

/**
 * An `action.terminal.session.open` whose native spawn has not returned yet.
 *
 * The run's cleanup can finish while a spawn is still awaiting the backend (a
 * cancel lands mid-spawn). Without a record of that open, the spawn's late
 * success was registered into a run whose resources had already been released,
 * and the PTY outlived the run. `closeRunSessions` marks every pending open of
 * the run released, and {@link finishRunSessionOpen} refuses to register into
 * one, so the opener closes what it got instead.
 *
 * A token, not a per-run tombstone: a run that pauses for input releases its
 * resources too and then resumes under the same id, and its later opens must
 * still register.
 */
export interface RunSessionOpen {
  readonly runId: string
  released: boolean
}

const pendingOpens = new Map<string, Set<RunSessionOpen>>()

/** Announce an open about to await its spawn. Pair with finish or abandon. */
export function beginRunSessionOpen(runId: string): RunSessionOpen {
  const open: RunSessionOpen = { runId, released: false }
  const set = pendingOpens.get(runId) ?? new Set<RunSessionOpen>()
  set.add(open)
  pendingOpens.set(runId, set)
  return open
}

function forgetOpen(open: RunSessionOpen): void {
  const set = pendingOpens.get(open.runId)
  if (!set) return
  set.delete(open)
  if (set.size === 0) pendingOpens.delete(open.runId)
}

/**
 * Register the session an open produced. Returns `false` — and registers
 * nothing — when the run released its resources while the spawn was in
 * flight; the caller then owns the session and must close it.
 */
export function finishRunSessionOpen(
  open: RunSessionOpen,
  sessionId: string,
  mode: RunSessionMode,
  context?: PersonalEgressContext
): boolean {
  forgetOpen(open)
  if (context) {
    if (mode === "headless") retainHeadlessPersonalEgress(context, sessionId)
    else retainTerminalPersonalEgress(context, sessionId)
  }
  registerRunSession(open.runId, sessionId, mode)
  if (open.released) return false
  return true
}

/** The spawn failed; nothing was opened. */
export function abandonRunSessionOpen(open: RunSessionOpen): void {
  forgetOpen(open)
}

/** Record a session opened by `runId`. */
export function registerRunSession(
  runId: string,
  sessionId: string,
  mode: RunSessionMode,
  context?: PersonalEgressContext
): void {
  if (context) {
    if (mode === "headless") retainHeadlessPersonalEgress(context, sessionId)
    else retainTerminalPersonalEgress(context, sessionId)
  }
  const list = byRun.get(runId) ?? []
  if (!list.some((e) => e.sessionId === sessionId)) {
    list.push({ sessionId, mode })
  }
  byRun.set(runId, list)
}

/** Sessions currently registered for `runId` (open order). */
export function listRunSessions(runId: string): ReadonlyArray<RunSessionEntry> {
  return byRun.get(runId) ?? []
}

/** Remove one session from the run's ledger (explicit node close). */
export function deregisterRunSession(runId: string, sessionId: string): void {
  const list = byRun.get(runId)
  if (!list) return
  const next = list.filter((e) => e.sessionId !== sessionId)
  if (next.length === 0) {
    byRun.delete(runId)
  } else {
    byRun.set(runId, next)
  }
}

/**
 * Close every session the run still holds. Best-effort: each close is
 * isolated so one failure can't leak the rest, and failed closes remain in the ledger until exit proof. Safe to call for runs that never opened a session
 * and safe to call twice.
 */
export async function closeRunSessions(runId: string): Promise<void> {
  const opening = pendingOpens.get(runId)
  if (opening) {
    for (const open of opening) open.released = true
    pendingOpens.delete(runId)
  }
  const list = byRun.get(runId)
  if (!list || list.length === 0) return
  for (const entry of list) {
    try {
      await closeRunSession(entry.sessionId, entry.mode)
      deregisterRunSession(runId, entry.sessionId)
    } catch {
      // Best-effort cleanup — a dead backend or an already-closed session
      // must never mask the run's own result.
    }
  }
}

/** Close one session the way its mode requires. Throws what the backend threw. */
export async function closeRunSession(sessionId: string, mode: RunSessionMode): Promise<void> {
  if (mode === "headless") {
    const { invoke } = await import("@tauri-apps/api/core")
    const proof = await invoke<{ status: string }>("terminal_headless_kill", { sessionId })
    if (proof?.status === "exited") confirmHeadlessPersonalEgressExit(sessionId)
    for (const runId of byRun.keys()) deregisterRunSession(runId, sessionId)
    return
  }
  const [{ killFromDock }, { useTerminalStore }] = await Promise.all([
    import("./spawn-orchestrator"),
    import("@/stores/terminal/terminal-store"),
  ])
  await killFromDock(sessionId, useTerminalStore.getState())
  for (const runId of byRun.keys()) deregisterRunSession(runId, sessionId)
}

/** Test-only: reset the ledger between cases. */
export function __clearRunSessionsForTesting(): void {
  __clearTerminalPersonalEgressForTesting()
  for (const entries of byRun.values())
    for (const entry of entries)
      if (entry.mode === "headless") confirmHeadlessPersonalEgressExit(entry.sessionId)
  byRun.clear()
  pendingOpens.clear()
}
