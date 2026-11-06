"use client"

/**
 * Focused read-aloud status selector for a single chat message.
 *
 * The chat list is virtualized and every visible assistant row mounts a
 * `ReadAloudButton`. If each button subscribed to the full orchestrator state
 * (as `useTTS` does), every progress tick would re-render all of them. This
 * hook instead encodes only the two fields a per-message control needs —
 * "am I the active speaker" and the coarse playback state — into a string
 * snapshot, so `useSyncExternalStore`'s `Object.is` bailout skips re-renders
 * on progress-only updates.
 *
 * It reads the player through the `speech` port (ADR-0250 §14). Until the port
 * has loaded every message reads as idle; where no module provides it,
 * `available` is false and the read-aloud control hides.
 */

import { useCallback, useSyncExternalStore } from "react"

import { usePort } from "@/hooks/modules/use-port"
import type { TTSOrchestratorState } from "@cognia/tts/tts-orchestrator"
import type { TTSPlaybackState } from "@cognia/tts/types"
import type { SpeechReadAloud } from "@/types/modules/ports/speech"

export interface ReadAloudStatus {
  /** False where no module provides the `speech` port: nothing can be read aloud. */
  available: boolean
  /** True when this message id owns the orchestrator's active playback. */
  isActive: boolean
  playbackState: TTSPlaybackState
  isPlaying: boolean
  isPaused: boolean
  isLoading: boolean
}

const IDLE_SNAPSHOT = "0:idle"
const noop = () => {}

function snapshotFor(readAloud: SpeechReadAloud, messageId: string): string {
  const s = readAloud.getState()
  const isActive = s.activeSourceId === messageId
  return `${isActive ? "1" : "0"}:${s.playbackState}`
}

export function useReadAloudStatus(messageId: string): ReadAloudStatus {
  const speech = usePort("speech")
  const readAloud = speech?.readAloud
  // The player calls back with its state; useSyncExternalStore only needs the
  // no-arg notification, so the extra arg is ignored.
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      readAloud ? readAloud.subscribe(onStoreChange as (s: TTSOrchestratorState) => void) : noop,
    [readAloud]
  )
  const getSnapshot = useCallback(
    () => (readAloud ? snapshotFor(readAloud, messageId) : IDLE_SNAPSHOT),
    [readAloud, messageId]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => IDLE_SNAPSHOT)

  const [activeFlag, playbackState] = snapshot.split(":") as [string, TTSPlaybackState]
  const isActive = activeFlag === "1"
  return {
    available: speech !== null,
    isActive,
    playbackState,
    isPlaying: isActive && playbackState === "playing",
    isPaused: isActive && playbackState === "paused",
    isLoading: isActive && playbackState === "loading",
  }
}
