"use client"

/**
 * Reactive view of the dock's session recordings
 * (`lib/terminal/recording/session-recordings.ts`).
 */

import { useSyncExternalStore } from "react"

import {
  getSessionRecordingsSnapshot,
  subscribeSessionRecordings,
  type SessionRecordingState,
} from "@/lib/terminal/recording/session-recordings"

const EMPTY: ReadonlyMap<string, SessionRecordingState> = new Map()

function serverSnapshot(): ReadonlyMap<string, SessionRecordingState> {
  return EMPTY
}

/** Every recording, keyed by session id. */
export function useSessionRecordings(): ReadonlyMap<string, SessionRecordingState> {
  return useSyncExternalStore(
    subscribeSessionRecordings,
    getSessionRecordingsSnapshot,
    serverSnapshot
  )
}

/** The recording of one session, or `null` when it is not being recorded. */
export function useSessionRecording(sessionId: string): SessionRecordingState | null {
  return useSessionRecordings().get(sessionId) ?? null
}
