"use client"

/**
 * Plays a terminal recording back in a read-only xterm inside a dialog.
 *
 * The xterm is sized to the recording (its header, then every resize frame) —
 * not fitted to the dialog — because the bytes were laid out for that grid: a
 * full-screen program redrawn at another width is garbage. A recording wider
 * than the dialog scrolls instead.
 *
 * `createPlayer` owns the timing; this component only draws what it emits,
 * clears the screen when a backward seek replays from the start, and mirrors
 * its state into the controls.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { useTranslations } from "next-intl"
import { PauseIcon, PlayIcon } from "lucide-react"
import "@xterm/xterm/css/xterm.css"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { resolveTerminalTheme } from "@/lib/terminal/color-schemes"
import {
  createPlayer,
  formatPlaybackTime,
  PLAYBACK_SPEEDS,
  type Player,
} from "@/lib/terminal/recording/player"
import type { PlaybackState, TerminalRecording } from "@/lib/terminal/recording/types"

import { TERMINAL_DEFAULT_FONT_FAMILY, TERMINAL_DEFAULT_FONT_SIZE } from "./terminal-layout-tokens"

export interface TerminalRecordingPlayerProps {
  /** The recording to play; `null` closes the dialog. */
  recording: TerminalRecording | null
  onOpenChange: (open: boolean) => void
  /** The user's terminal appearance, so a replay looks like their terminal. */
  fontFamily?: string
  fontSize?: number
  colorScheme?: string
}

interface XtermLike {
  write: (data: string) => void
  reset: () => void
  resize: (cols: number, rows: number) => void
  dispose: () => void
}

export function TerminalRecordingPlayer({
  recording,
  onOpenChange,
  fontFamily,
  fontSize,
  colorScheme,
}: TerminalRecordingPlayerProps) {
  const t = useTranslations("terminal.recording")

  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const playerRef = useRef<Player | null>(null)
  const [state, setState] = useState<PlaybackState | null>(null)

  useEffect(() => {
    if (!recording || !container) return
    let disposed = false
    let term: XtermLike | null = null
    let player: Player | null = null

    void (async () => {
      const { Terminal } = await import("@xterm/xterm")
      if (disposed) return
      const isDark =
        typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      const xterm = new Terminal({
        cols: recording.header.width,
        rows: recording.header.height,
        disableStdin: true,
        cursorBlink: false,
        scrollback: 5000,
        fontFamily: fontFamily && fontFamily.length > 0 ? fontFamily : TERMINAL_DEFAULT_FONT_FAMILY,
        fontSize: typeof fontSize === "number" ? fontSize : TERMINAL_DEFAULT_FONT_SIZE,
        theme: resolveTerminalTheme(colorScheme, isDark),
      })
      xterm.open(container)
      term = xterm
      player = createPlayer(recording, {
        onFrame: (data) => xterm.write(data),
        onResize: (cols, rows) => xterm.resize(cols, rows),
        onReset: () => xterm.reset(),
      })
      playerRef.current = player
      player.onStateChange(setState)
      setState(player.state)
      player.play()
    })()

    return () => {
      disposed = true
      player?.dispose()
      term?.dispose()
      playerRef.current = null
      setState(null)
    }
    // The appearance is read once per opened recording: re-creating the
    // terminal mid-playback would restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, container])

  const togglePlay = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    if (player.state.playing) player.pause()
    else player.play()
  }, [])

  const duration = state?.duration ?? recording?.duration ?? 0
  const position = state?.position ?? 0
  const playing = state?.playing ?? false
  const empty = !!recording && recording.frames.length === 0

  return (
    <Dialog open={!!recording} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-testid="terminal-recording-player">
        <DialogHeader>
          <DialogTitle className="truncate">{recording?.title ?? t("player.title")}</DialogTitle>
          <DialogDescription>
            {recording
              ? t("player.description", {
                  size: `${recording.header.width}×${recording.header.height}`,
                  time: formatPlaybackTime(recording.duration),
                })
              : null}
          </DialogDescription>
        </DialogHeader>
        {empty ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("player.empty")}</p>
        ) : null}
        <div className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-2">
          <div ref={setContainer} data-testid="terminal-recording-player-screen" />
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={togglePlay}
            disabled={!state || empty}
            aria-label={playing ? t("player.pause") : t("player.play")}
            data-testid="terminal-recording-player-toggle"
          >
            {playing ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
          </Button>
          <Slider
            className="flex-1"
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.1}
            value={[position]}
            disabled={!state || empty}
            aria-label={t("player.seek")}
            onValueChange={(value) => {
              const target = value[0]
              if (typeof target === "number") playerRef.current?.seek(target)
            }}
            data-testid="terminal-recording-player-seek"
          />
          <span
            className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground"
            data-testid="terminal-recording-player-time"
          >
            {t("player.position", {
              current: formatPlaybackTime(position),
              total: formatPlaybackTime(duration),
            })}
          </span>
          <ToggleGroup
            type="single"
            size="sm"
            value={String(state?.speed ?? 1)}
            onValueChange={(value) => {
              const speed = Number(value)
              if (Number.isFinite(speed) && speed > 0) playerRef.current?.setSpeed(speed)
            }}
            aria-label={t("player.speedLabel")}
            disabled={!state || empty}
          >
            {PLAYBACK_SPEEDS.map((speed) => (
              <ToggleGroupItem
                key={speed}
                value={String(speed)}
                className="px-2 text-xs"
                aria-label={t("player.speed", { speed })}
                data-testid={`terminal-recording-player-speed-${speed}`}
              >
                {t("player.speedOption", { speed })}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default TerminalRecordingPlayer
