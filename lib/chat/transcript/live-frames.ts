/**
 * Live in-flight replies for a member agent turn (`transcript://live`, P6e).
 *
 * A member's agent runs in their person brain, not in the Host's sidecar, so
 * the sidecar's `claude://message` stream never carries it. The brain already
 * projects the agent's events into the assistant message it persists; it
 * sends the same parts to the member's devices as they change:
 *
 * - A **patch** keeps the first `base` parts of the previous frame and
 *   replaces the rest with `parts`. Projected parts are replaced, not edited,
 *   so a part that did not change is the same object and stays in the prefix.
 * - A patch with `extend` keeps part `base` too and appends `extend` to its
 *   `text`; `parts` replace what follows it. A streaming text or reasoning
 *   part only grows, so it costs its new characters, not its whole text: a
 *   reply far over the frame budget keeps streaming (ADR-0253 G15).
 * - A **keyframe** (`base` 0) carries the whole message. The first frame of a
 *   reply is one, then one every {@link TRANSCRIPT_LIVE_KEYFRAME_MS}, so a
 *   device that joined late or missed a frame catches up within that. A
 *   periodic keyframe over the budget is skipped for a patch: a device that
 *   is following keeps following, one that is not reads the transcript.
 * - `settled` is the final frame, sent just before the brain writes the reply
 *   for good: a keyframe, or a patch when the whole reply is over the budget
 *   (a device that cannot apply that patch drops the reply and reads the
 *   transcript). Its `afterRevision` is the transcript revision the brain
 *   had persisted before it, so a device keeps drawing the finished reply
 *   until its timeline has read past that revision. `reset` means "stop
 *   drawing this reply live": when even the patch, or the reply's first or
 *   final keyframe, is over {@link TRANSCRIPT_LIVE_FRAME_MAX_BYTES} nothing
 *   is sent, and the device reads the persisted transcript instead.
 *
 * The Host rebuilds every frame from these keys, refuses one over 200 KiB,
 * delivers it only to the person's own devices and never replays it
 * (`crates/cognia-companion/src/ws_bridge.rs`). A frame is a view of the
 * reply, never its record: the persisted message stays authoritative.
 */

import type { UIMessage } from "ai"

export const TRANSCRIPT_LIVE_TOPIC = "transcript://live"
/** How often the brain sends the changed tail of a live reply. */
export const TRANSCRIPT_LIVE_INTERVAL_MS = 100
/** How often a live reply is resent whole. */
export const TRANSCRIPT_LIVE_KEYFRAME_MS = 2_000
/** The brain's own budget; the Host's hard ceiling is 256 KiB. */
export const TRANSCRIPT_LIVE_FRAME_MAX_BYTES = 200 * 1024
const MAX_ID_LENGTH = 256

export type TranscriptLivePart = UIMessage["parts"][number]
export type TranscriptLiveFrameState = "streaming" | "settled" | "reset"

export interface TranscriptLiveFrame {
  sessionId: string
  /** The assistant message the brain persists for this turn. */
  messageId: string
  /** The member's message the turn answers. */
  replyTo: string
  /** 1 for a reply's first frame, then one more per frame. */
  seq: number
  /** How many parts of the previous frame stay; 0 for a keyframe. */
  base: number
  keyframe: boolean
  state: TranscriptLiveFrameState
  /** The parts from index `base` on; with `extend`, from `base + 1` on. */
  parts: TranscriptLivePart[]
  /** Patches only: text appended to the kept part at `base`. */
  extend?: string
  /** `settled` only: the transcript revision persisted before this frame. */
  afterRevision?: number
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function isCount(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

/** The shape the Host admits, checked again where frames arrive. */
export function isTranscriptLiveFrame(value: unknown): value is TranscriptLiveFrame {
  if (!value || typeof value !== "object") return false
  const frame = value as Record<string, unknown>
  if (
    !isId(frame.sessionId) ||
    !isId(frame.messageId) ||
    !isId(frame.replyTo) ||
    !isCount(frame.seq, 1) ||
    !isCount(frame.base, 0) ||
    typeof frame.keyframe !== "boolean" ||
    (frame.state !== "streaming" && frame.state !== "settled" && frame.state !== "reset") ||
    !Array.isArray(frame.parts) ||
    frame.parts.some((part) => !part || typeof part !== "object" || Array.isArray(part))
  )
    return false
  if (frame.keyframe && frame.base !== 0) return false
  if (frame.state === "reset" && frame.parts.length > 0) return false
  if (
    frame.afterRevision !== undefined &&
    (frame.state !== "settled" || !isCount(frame.afterRevision, 0))
  )
    return false
  if (
    frame.extend !== undefined &&
    (typeof frame.extend !== "string" ||
      frame.extend.length === 0 ||
      frame.keyframe ||
      frame.state === "reset")
  )
    return false
  return true
}

function textOf(part: TranscriptLivePart): string | undefined {
  const text = (part as { text?: unknown }).text
  return typeof text === "string" ? text : undefined
}

/**
 * What `next` appends to `previous`'s text, when that is all that changed: ""
 * for an equal part, `null` when anything else differs.
 */
function textExtension(previous: TranscriptLivePart, next: TranscriptLivePart): string | null {
  const before = textOf(previous)
  const after = textOf(next)
  if (before === undefined || after === undefined || !after.startsWith(before)) return null
  const rest = (part: TranscriptLivePart) => {
    const { text: _text, ...others } = part as { text?: unknown }
    return JSON.stringify(others)
  }
  return rest(previous) === rest(next) ? after.slice(before.length) : null
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export interface TranscriptLiveEncoderOptions {
  sessionId: string
  messageId: string
  replyTo: string
  now: () => number
  maxBytes?: number
  keyframeMs?: number
}

/**
 * The brain's side: turns successive part arrays of one reply into frames.
 * `next` answers `null` when there is nothing to send.
 */
export function createTranscriptLiveEncoder(options: TranscriptLiveEncoderOptions) {
  const maxBytes = options.maxBytes ?? TRANSCRIPT_LIVE_FRAME_MAX_BYTES
  const keyframeMs = options.keyframeMs ?? TRANSCRIPT_LIVE_KEYFRAME_MS
  let sent: readonly TranscriptLivePart[] | null = null
  let lastKeyframeAt = 0
  let seq = 0
  /** A reply too large to send stays off the wire until a keyframe fits. */
  let suppressed = false

  const frame = (
    state: TranscriptLiveFrameState,
    base: number,
    parts: TranscriptLivePart[],
    keyframe: boolean
  ): TranscriptLiveFrame => ({
    sessionId: options.sessionId,
    messageId: options.messageId,
    replyTo: options.replyTo,
    seq: ++seq,
    base,
    keyframe,
    state,
    parts,
  })

  const reset = (): TranscriptLiveFrame => {
    suppressed = true
    sent = null
    return frame("reset", 0, [], true)
  }

  return {
    next(
      parts: readonly TranscriptLivePart[],
      state: "streaming" | "settled" = "streaming",
      afterRevision?: number
    ): TranscriptLiveFrame | null {
      const now = options.now()
      const keyframeDue = sent === null || now - lastKeyframeAt >= keyframeMs
      if (suppressed && state === "streaming" && now - lastKeyframeAt < keyframeMs) return null
      const keyframe = state === "settled" || suppressed || keyframeDue
      const fits = (candidate: TranscriptLiveFrame) =>
        byteLength(JSON.stringify(candidate)) <= maxBytes
      const accept = (candidate: TranscriptLiveFrame) => {
        suppressed = false
        sent = parts
        return candidate
      }
      if (keyframe) {
        lastKeyframeAt = now
        const candidate = frame(state, 0, [...parts], true)
        if (state === "settled" && afterRevision !== undefined)
          candidate.afterRevision = afterRevision
        if (fits(candidate)) return accept(candidate)
        seq -= 1
        // A keyframe too large to send gives way to a patch, so the devices
        // already following keep following, to the end. A reply's first
        // keyframe has no patch to give way to.
        if (suppressed || sent === null) return suppressed ? null : reset()
      }
      const previous = sent ?? []
      const limit = Math.min(previous.length, parts.length)
      let base = 0
      while (
        base < limit &&
        (previous[base] === parts[base] || textExtension(previous[base]!, parts[base]!) === "")
      )
        base += 1
      // A settled reply is always announced, changed or not.
      if (state === "streaming" && base === parts.length && base === previous.length) return null
      const extension = base < limit ? textExtension(previous[base]!, parts[base]!) : null
      const candidate = extension
        ? { ...frame(state, base, parts.slice(base + 1), false), extend: extension }
        : frame(state, base, parts.slice(base), false)
      if (state === "settled" && afterRevision !== undefined)
        candidate.afterRevision = afterRevision
      if (fits(candidate)) return accept(candidate)
      seq -= 1
      return reset()
    },
    /** End the live reply without content: no parts, or a reply never sent. */
    reset(): TranscriptLiveFrame | null {
      if (seq === 0) return null
      return reset()
    },
  }
}

/** A device's view of one live reply. */
export interface TranscriptLiveTurn {
  sessionId: string
  messageId: string
  replyTo: string
  seq: number
  parts: TranscriptLivePart[]
  state: "streaming" | "settled"
  /** A frame went missing: hold what is drawn until the next keyframe. */
  stale: boolean
  /** Settled: keep drawing until the timeline's revision passes this. */
  afterRevision?: number
}

/** The device's side: fold one frame into the reply it is drawing. */
export function applyTranscriptLiveFrame(
  current: TranscriptLiveTurn | null,
  frame: TranscriptLiveFrame
): TranscriptLiveTurn | null {
  if (frame.state === "reset") {
    return current && current.messageId !== frame.messageId ? current : null
  }
  const state = frame.state === "settled" ? "settled" : "streaming"
  const fresh = (): TranscriptLiveTurn => ({
    sessionId: frame.sessionId,
    messageId: frame.messageId,
    replyTo: frame.replyTo,
    seq: frame.seq,
    parts: frame.parts,
    state,
    stale: false,
    ...(frame.afterRevision !== undefined ? { afterRevision: frame.afterRevision } : {}),
  })
  if (!current || current.messageId !== frame.messageId) {
    // A patch without the keyframe it builds on cannot be drawn.
    return frame.keyframe ? fresh() : current?.state === "settled" ? current : null
  }
  if (frame.seq <= current.seq) return current
  if (frame.keyframe) return fresh()
  // A reply that ended on a patch this device cannot apply is not drawn
  // further: the transcript has it.
  const unreadable = (): TranscriptLiveTurn | null =>
    state === "settled" ? null : { ...current, stale: true }
  if (current.stale) return state === "settled" ? null : current
  if (frame.seq !== current.seq + 1 || frame.base > current.parts.length) return unreadable()
  const settledKeys =
    frame.afterRevision !== undefined ? { afterRevision: frame.afterRevision } : {}
  if (frame.extend !== undefined) {
    const extended = current.parts[frame.base]
    const text = extended ? textOf(extended) : undefined
    // Nothing to append to: this device's copy is not the brain's.
    if (!extended || text === undefined) return unreadable()
    return {
      ...current,
      seq: frame.seq,
      parts: [
        ...current.parts.slice(0, frame.base),
        { ...extended, text: text + frame.extend } as TranscriptLivePart,
        ...frame.parts,
      ],
      state,
      ...settledKeys,
    }
  }
  return {
    ...current,
    seq: frame.seq,
    parts: [...current.parts.slice(0, frame.base), ...frame.parts],
    state,
    ...settledKeys,
  }
}
