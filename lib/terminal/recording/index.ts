/**
 * Terminal recording — barrel export.
 *
 *  - **types** — shared type definitions
 *  - **recorder** — captures terminal frames into asciicast v2 format
 *  - **player** — replays recordings with timing, speed, seek
 *
 * **Dormant: a library without a product entry.** Nothing in the app, the
 * dock or a plugin API records or replays a terminal yet, so this is not a
 * shipped feature and must not be described as one. The integrated-terminal
 * docs page says so, and `index.test.ts` pins that no UI layer imports it:
 * wiring a recorder into the dock means updating both, deliberately.
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
