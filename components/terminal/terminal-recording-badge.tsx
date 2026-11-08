"use client"

/**
 * Shown on a dock tab while it is recorded, and after a take ended on its own
 * and is not saved yet. Recording is visible on the tab itself — not only in a
 * menu — because everything the session prints is being captured.
 */

import { useEffect, useState } from "react"

import { useTranslations } from "next-intl"

import { useSessionRecording } from "@/hooks/terminal/use-session-recording"
import { formatPlaybackTime } from "@/lib/terminal/recording/player"

export interface TerminalRecordingBadgeProps {
  sessionId: string
  /** Test seam for the elapsed-time clock. */
  now?: () => number
}

export function TerminalRecordingBadge({ sessionId, now = Date.now }: TerminalRecordingBadgeProps) {
  const t = useTranslations("terminal.recording.badge")
  const recording = useSessionRecording(sessionId)
  const live = recording?.status === "recording"
  const [clock, setClock] = useState(() => now())

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setClock(now()), 1000)
    return () => clearInterval(timer)
  }, [live, now])

  if (!recording) return null
  if (!live) {
    return (
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full border border-red-500"
        role="img"
        aria-label={t("unsaved")}
        title={t("unsaved")}
        data-testid="terminal-recording-badge"
        data-state="unsaved"
      />
    )
  }
  const elapsed = formatPlaybackTime((clock - recording.startedAt) / 1000)
  const label = t("recording", { time: elapsed })
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-red-500"
      role="status"
      aria-label={label}
      title={label}
      data-testid="terminal-recording-badge"
      data-state="recording"
    >
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
      {elapsed}
    </span>
  )
}

export default TerminalRecordingBadge
