/**
 * Terminal recording — barrel export.
 *
 *  - **types** — shared type definitions
 *  - **recorder** — captures terminal frames into asciicast v2 format
 *  - **player** — replays recordings with timing, speed, seek
 *
 * The product entry lives next door: `session-recordings.ts` binds a recorder
 * to a live dock session, `asciicast-file.ts` reads and writes `.cast` files,
 * `playback-request.ts` holds what the playback dialog shows. The dock wires
 * them (`hooks/terminal/use-terminal-recording-actions.ts`,
 * `components/terminal/terminal-recording-player.tsx`).
 */

export type {
  AsciicastHeader,
  AsciicastFrame,
  TerminalRecording,
  RecordingStatus,
  RecorderOptions,
  PlaybackState,
  GifExportOptions,
} from "./types"

export {
  createRecorder,
  serializeAsciicast,
  parseAsciicast,
  DEFAULT_MAX_DURATION_SEC,
  DEFAULT_TITLE,
} from "./recorder"
export type { Recorder, RecorderDeps, RecorderStateCallback } from "./recorder"

export { createPlayer } from "./player"
export type { Player, PlayerDeps, FrameEmitter, PlaybackStateCallback } from "./player"
