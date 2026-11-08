"use client"

/**
 * Live recordings of dock sessions, one at most per session.
 *
 * The recorder (`recorder.ts`) only turns pushed strings into timed frames.
 * This binds it to a live session: it reads the byte stream through
 * `BaseTerminalSession.tapData` — passive, so the dock's xterm still gets its
 * early-data replay and a background tab keeps recording while its xterm is
 * unmounted — and follows the session's size so playback reflows where the
 * recorded terminal did.
 *
 * A recording ends in one of three ways and is then held, finished, until the
 * dock saves or discards it: the user stops it, the duration cap is reached,
 * or the session exits. Holding it is what keeps a cancelled save dialog or a
 * closed tab from silently throwing the take away.
 *
 * Only output is recorded (`captureInput` stays off): input frames would hold
 * every keystroke, including a password typed at a prompt that does not echo.
 *
 * Module-level, like `session-registry.ts`: recordings belong to this renderer.
 */

import type { BaseTerminalSession } from "../base-session"
import { createRecorder, DEFAULT_MAX_DURATION_SEC, type Recorder } from "./recorder"
import type { TerminalRecording } from "./types"

export type SessionRecordingEndReason = "stopped" | "limit" | "exited"

export type SessionRecordingState =
  | { status: "recording"; sessionId: string; title: string; startedAt: number }
  | {
      status: "finished"
      sessionId: string
      title: string
      startedAt: number
      reason: SessionRecordingEndReason
      recording: TerminalRecording
    }

interface Entry {
  state: SessionRecordingState
  recorder: Recorder
  cleanups: Array<() => void>
}

/** Terminal size used when the session has never reported one. */
export const FALLBACK_SIZE = { cols: 80, rows: 24 } as const

const entries = new Map<string, Entry>()
const sizes = new Map<string, { cols: number; rows: number }>()
const listeners = new Set<() => void>()
let snapshot: ReadonlyMap<string, SessionRecordingState> = new Map()

function publish(): void {
  snapshot = new Map([...entries].map(([id, entry]) => [id, entry.state]))
  for (const listener of listeners) listener()
}

function detach(entry: Entry): void {
  for (const cleanup of entry.cleanups) {
    try {
      cleanup()
    } catch {
      /* listener already gone */
    }
  }
  entry.cleanups = []
}

function finish(sessionId: string, reason: SessionRecordingEndReason): void {
  const entry = entries.get(sessionId)
  if (!entry || entry.state.status !== "recording") return
  detach(entry)
  const recording = entry.recorder.stop(sessionId)
  entry.state = { ...entry.state, status: "finished", reason, recording }
  publish()
}

/**
 * The size the session's xterm last fitted to. Called wherever the dock
 * resizes a session, so a recording starts at the real size and records each
 * change as a resize frame.
 */
export function reportTerminalSize(sessionId: string, cols: number, rows: number): void {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return
  const previous = sizes.get(sessionId)
  if (previous && previous.cols === cols && previous.rows === rows) return
  sizes.set(sessionId, { cols, rows })
  entries.get(sessionId)?.recorder.pushResize(cols, rows)
}

export function getReportedTerminalSize(sessionId: string): { cols: number; rows: number } | null {
  return sizes.get(sessionId) ?? null
}

export interface StartSessionRecordingInput {
  session: Pick<BaseTerminalSession, "id" | "tapData" | "onExit" | "isExited">
  title: string
  maxDurationSec?: number
  /** Test seam. */
  now?: () => number
}

/**
 * Start recording `session`. Returns `false` — and changes nothing — when the
 * session is already recorded (or holds an unsaved take) or has exited.
 */
export function startSessionRecording(input: StartSessionRecordingInput): boolean {
  const { session } = input
  if (entries.has(session.id) || session.isExited) return false
  const now = input.now ?? Date.now
  const recorder = createRecorder(
    { title: input.title, maxDurationSec: input.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC },
    { now }
  )
  const size = sizes.get(session.id) ?? FALLBACK_SIZE
  recorder.start(size.cols, size.rows)

  const decoder = new TextDecoder()
  const entry: Entry = {
    state: { status: "recording", sessionId: session.id, title: input.title, startedAt: now() },
    recorder,
    cleanups: [],
  }
  entries.set(session.id, entry)
  entry.cleanups.push(
    session.tapData((bytes) => {
      const text = decoder.decode(bytes, { stream: true })
      if (text) recorder.pushOutput(text)
    }),
    session.onExit(() => finish(session.id, "exited")),
    recorder.onStateChange((status) => {
      // The recorder's own duration cap moves it to "stopped" on a timer.
      if (status === "stopped") finish(session.id, "limit")
    })
  )
  publish()
  return true
}

/**
 * Stop recording and return the take. The take stays held (status
 * `finished`) until {@link releaseSessionRecording} — so the caller can save
 * it, and keep it if the save is cancelled. Returns the held take when the
 * recording had already ended, or `null` when there is none.
 */
export function stopSessionRecording(sessionId: string): TerminalRecording | null {
  finish(sessionId, "stopped")
  const state = entries.get(sessionId)?.state
  return state?.status === "finished" ? state.recording : null
}

/** Drop a recording (live or held) without saving it. */
export function releaseSessionRecording(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (!entry) return
  detach(entry)
  if (entry.state.status === "recording") entry.recorder.discard()
  entries.delete(sessionId)
  publish()
}

/** Forget a session that left the dock: its size, and a live recording ends. */
export function sessionLeftDock(sessionId: string): void {
  sizes.delete(sessionId)
  finish(sessionId, "exited")
}

export function getSessionRecording(sessionId: string): SessionRecordingState | null {
  return snapshot.get(sessionId) ?? null
}

/** Stable snapshot for `useSyncExternalStore`; replaced on every change. */
export function getSessionRecordingsSnapshot(): ReadonlyMap<string, SessionRecordingState> {
  return snapshot
}

export function subscribeSessionRecordings(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop every recording, size and listener. */
export function __resetSessionRecordingsForTesting(): void {
  for (const entry of entries.values()) {
    detach(entry)
    if (entry.state.status === "recording") entry.recorder.discard()
  }
  entries.clear()
  sizes.clear()
  listeners.clear()
  snapshot = new Map()
}
