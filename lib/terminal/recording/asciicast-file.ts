/**
 * `.cast` files on disk: what the dock saves when a recording stops, and what
 * "Open recording…" reads back for playback.
 *
 * `parseAsciicast` (recorder.ts) is the bare codec and trusts its input. A file
 * the user picks can be anything — another tool's v1 cast, a truncated write,
 * a renamed log — so this validates the header and every event line before a
 * player is built on it, and names the problem instead of throwing a
 * `SyntaxError` at the user.
 */

import { serializeAsciicast } from "./recorder"
import type { AsciicastFrame, AsciicastHeader, TerminalRecording } from "./types"

/** File extension and save-dialog filter for terminal recordings. */
export const ASCIICAST_EXTENSION = "cast"
export const ASCIICAST_FILTERS = [{ name: "asciicast", extensions: [ASCIICAST_EXTENSION] }]

/** Why a file could not be read as a recording. */
export type AsciicastFileErrorCode =
  "empty" | "not-json" | "unsupported-version" | "bad-header" | "bad-frame"

export class AsciicastFileError extends Error {
  constructor(
    readonly code: AsciicastFileErrorCode,
    readonly line?: number
  ) {
    super(line ? `${code} (line ${line})` : code)
    this.name = "AsciicastFileError"
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isFrame(value: unknown): value is AsciicastFrame {
  return (
    Array.isArray(value) &&
    value.length >= 3 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    value[0] >= 0 &&
    (value[1] === "o" || value[1] === "i" || value[1] === "r") &&
    typeof value[2] === "string"
  )
}

/**
 * Read a `.cast` file's text into a playable recording.
 *
 * Event kinds this player does not know (asciicast v2 also has `"m"` markers)
 * are skipped rather than refused: they carry nothing to draw. Frames are
 * sorted by time, since a player assumes it and a hand-edited file may not be.
 *
 * @throws {AsciicastFileError} with the reason the file is not a recording.
 */
export function recordingFromAsciicast(
  content: string,
  options: { fileName?: string; now?: () => number } = {}
): TerminalRecording {
  if (!content.trim()) throw new AsciicastFileError("empty")
  const lines = content.trim().split("\n")

  let rawHeader: unknown
  try {
    rawHeader = JSON.parse(lines[0])
  } catch {
    throw new AsciicastFileError("not-json", 1)
  }
  if (!rawHeader || typeof rawHeader !== "object" || Array.isArray(rawHeader)) {
    throw new AsciicastFileError("bad-header", 1)
  }
  const header = rawHeader as Partial<AsciicastHeader> & { version?: unknown }
  if (header.version !== 2) throw new AsciicastFileError("unsupported-version", 1)
  if (!isPositiveInt(header.width) || !isPositiveInt(header.height)) {
    throw new AsciicastFileError("bad-header", 1)
  }

  const frames: AsciicastFrame[] = []
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new AsciicastFileError("not-json", index + 1)
    }
    if (Array.isArray(event) && event[1] === "m") continue
    if (!isFrame(event)) throw new AsciicastFileError("bad-frame", index + 1)
    frames.push([event[0], event[1], event[2]])
  }
  frames.sort((a, b) => a[0] - b[0])

  const lastFrameTime = frames.length > 0 ? frames[frames.length - 1][0] : 0
  const duration =
    typeof header.duration === "number" && Number.isFinite(header.duration)
      ? Math.max(header.duration, lastFrameTime)
      : lastFrameTime
  const fileTitle = options.fileName?.replace(/\.cast$/i, "").trim()
  const title =
    (typeof header.title === "string" && header.title.trim()) || fileTitle || "recording"
  const timestamp = typeof header.timestamp === "number" ? header.timestamp : undefined

  return {
    id: `file-${(options.now ?? Date.now)()}`,
    sessionId: "",
    title,
    header: {
      version: 2,
      width: header.width,
      height: header.height,
      ...(timestamp !== undefined ? { timestamp } : {}),
      duration,
      title,
    },
    frames,
    duration,
    createdAt: timestamp !== undefined ? timestamp * 1000 : (options.now ?? Date.now)(),
    sizeBytes: content.length,
  }
}

/** Serialize for saving. Same as the codec; here so callers import one file. */
export function asciicastFileContent(recording: TerminalRecording): string {
  return serializeAsciicast(recording)
}

/**
 * A filesystem-safe default name: the tab's title and the start time, e.g.
 * `zsh-2026-11-08-1432.cast`. Uses local time, which is what the user reads.
 */
export function recordingFileName(recording: TerminalRecording): string {
  const slug =
    recording.title
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "terminal"
  const started = new Date(
    recording.header.timestamp !== undefined
      ? recording.header.timestamp * 1000
      : recording.createdAt
  )
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}-${pad(started.getHours())}${pad(started.getMinutes())}`
  return `${slug}-${stamp}.${ASCIICAST_EXTENSION}`
}
