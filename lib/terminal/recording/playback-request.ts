/**
 * Which recording the dock's playback dialog shows.
 *
 * Held here rather than in the dock's own state because the dock unmounts
 * whenever its panel closes, and "Play" is offered from toasts that outlive
 * it: the recording a toast asked for must still be there when the dock
 * mounts again to draw the dialog.
 */

import type { TerminalRecording } from "./types"

let current: TerminalRecording | null = null
const listeners = new Set<() => void>()

function publish(next: TerminalRecording | null): void {
  if (current === next) return
  current = next
  for (const listener of listeners) listener()
}

/** Show `recording` in the playback dialog. */
export function requestPlayback(recording: TerminalRecording): void {
  publish(recording)
}

export function closePlayback(): void {
  publish(null)
}

export function getPlaybackRequest(): TerminalRecording | null {
  return current
}

export function subscribePlaybackRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
