"use client"

/**
 * The dock's recording actions: start, stop-and-save, discard, open a `.cast`
 * file, and the playback dialog's state.
 *
 * Saving writes asciinema-compatible `.cast` text through the same save dialog
 * every other export uses (`saveFileAs`). A take is released only once it is
 * on disk: a cancelled dialog keeps it, and the tab's menu offers to save it
 * again.
 *
 * A recording can also end on its own — the duration cap, the shell exiting,
 * or its tab closing. Each of those raises one toast that stays until the user
 * saves or dismisses the take, so nothing recorded is thrown away silently.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react"

import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { pickAndReadFiles, saveFileAs } from "@/lib/files/file-bridge"
import {
  ASCIICAST_FILTERS,
  AsciicastFileError,
  asciicastFileContent,
  recordingFileName,
  recordingFromAsciicast,
} from "@/lib/terminal/recording/asciicast-file"
import {
  closePlayback,
  getPlaybackRequest,
  requestPlayback,
  subscribePlaybackRequest,
} from "@/lib/terminal/recording/playback-request"
import {
  getSessionRecordingsSnapshot,
  releaseSessionRecording,
  sessionLeftDock,
  startSessionRecording,
  stopSessionRecording,
  subscribeSessionRecordings,
} from "@/lib/terminal/recording/session-recordings"
import type { TerminalRecording } from "@/lib/terminal/recording/types"
import { getLiveSession } from "@/lib/terminal/session-registry"
import { displayTitle, useTerminalStore } from "@/stores/terminal/terminal-store"

/** One prompt per session for a take that ended on its own. */
function endedToastId(sessionId: string): string {
  return `terminal-recording-ended:${sessionId}`
}

/** Open the dock (if closed) and play `recording` in its dialog. */
function play(recording: TerminalRecording): void {
  useTerminalStore.getState().setPanelOpen(true)
  requestPlayback(recording)
}

export interface TerminalRecordingActions {
  start: (sessionId: string) => void
  /** Stop a live recording (or take a held one) and save it. */
  stopAndSave: (sessionId: string) => Promise<void>
  discard: (sessionId: string) => void
  openFile: () => Promise<void>
  /** Save a take; `sessionId` releases its held recording once written. */
  save: (recording: TerminalRecording, sessionId?: string) => Promise<boolean>
  /** The recording open in the playback dialog. */
  playback: TerminalRecording | null
  closePlayback: () => void
}

export function useTerminalRecordingActions(): TerminalRecordingActions {
  const t = useTranslations("terminal.recording")
  const playback = useSyncExternalStore(subscribePlaybackRequest, getPlaybackRequest, () => null)

  const save = useCallback(
    async (recording: TerminalRecording, sessionId?: string): Promise<boolean> => {
      let saved: boolean
      try {
        saved = await saveFileAs({
          defaultName: recordingFileName(recording),
          content: asciicastFileContent(recording),
          filters: ASCIICAST_FILTERS,
        })
      } catch (error) {
        toast.error(
          t("saveFailed", { message: error instanceof Error ? error.message : String(error) })
        )
        return false
      }
      if (!saved) {
        if (sessionId) toast.message(t("saveCancelled"))
        return false
      }
      if (sessionId) releaseSessionRecording(sessionId)
      toast.success(t("saved"), {
        description: recording.title,
        action: { label: t("play"), onClick: () => play(recording) },
      })
      return true
    },
    [t]
  )

  const start = useCallback(
    (sessionId: string) => {
      const session = getLiveSession(sessionId)
      const row = useTerminalStore.getState().sessions[sessionId]
      const started =
        !!session &&
        startSessionRecording({ session, title: row ? displayTitle(row) : session.info.shell })
      if (!started) toast.error(t("startFailed"))
    },
    [t]
  )

  const stopAndSave = useCallback(
    async (sessionId: string) => {
      const recording = stopSessionRecording(sessionId)
      if (recording) await save(recording, sessionId)
    },
    [save]
  )

  const discard = useCallback((sessionId: string) => {
    releaseSessionRecording(sessionId)
  }, [])

  const openFile = useCallback(async () => {
    const [file] = await pickAndReadFiles({ filters: ASCIICAST_FILTERS })
    if (!file) return
    try {
      requestPlayback(recordingFromAsciicast(file.content, { fileName: file.name }))
    } catch (error) {
      const code = error instanceof AsciicastFileError ? error.code : "not-json"
      toast.error(t("openFailed", { name: file.name }), {
        description: t(`fileError.${code}`),
      })
    }
  }, [t])

  // A take that ended on its own (cap, exit, closed tab) gets a prompt that
  // stays until it is saved or discarded. Keyed by session, so the dock
  // re-mounting (it unmounts with its panel) re-shows it rather than stacking
  // a second one; a released take dismisses its own.
  useEffect(() => {
    const shown = new Set<string>()
    const check = () => {
      const recordings = getSessionRecordingsSnapshot()
      for (const id of shown) {
        if (recordings.has(id)) continue
        shown.delete(id)
        toast.dismiss(endedToastId(id))
      }
      for (const state of recordings.values()) {
        if (state.status !== "finished" || state.reason === "stopped") continue
        if (shown.has(state.sessionId)) continue
        shown.add(state.sessionId)
        const { sessionId, recording } = state
        toast.message(t(`ended.${state.reason}`, { title: state.title }), {
          id: endedToastId(sessionId),
          description: t("ended.unsaved"),
          duration: Number.POSITIVE_INFINITY,
          action: { label: t("save"), onClick: () => void save(recording, sessionId) },
          cancel: { label: t("discard"), onClick: () => releaseSessionRecording(sessionId) },
        })
      }
    }
    check()
    return subscribeSessionRecordings(check)
  }, [save, t])

  // A recorded tab that leaves the dock ends its recording; the prompt above
  // then offers to save it.
  useEffect(() => {
    const sweep = () => {
      const sessions = useTerminalStore.getState().sessions
      for (const id of getSessionRecordingsSnapshot().keys()) {
        if (!sessions[id]) sessionLeftDock(id)
      }
    }
    sweep()
    return useTerminalStore.subscribe(sweep)
  }, [])

  return {
    start,
    stopAndSave,
    discard,
    openFile,
    save,
    playback,
    closePlayback,
  }
}
