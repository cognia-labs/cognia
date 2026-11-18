"use client"

/**
 * How the exporter reaches the pixels of a SANDBOXED artifact preview.
 *
 * `preview-registry.ts` solves the same problem for `renderer` types by
 * handing out the mounted DOM node, and it says plainly that iframe types
 * cannot work that way. This is why: a React artifact frame is
 * `sandbox="allow-scripts"` with no `allow-same-origin`, so its origin is
 * opaque, `contentDocument` is null to us, and html2canvas cannot walk into
 * it. Rasterising INSIDE the frame is not an option either, because
 * html2canvas clones the document into a child iframe and an opaque-origin
 * document cannot read even its own about:blank child.
 *
 * What is left is a conversation. The frame serialises what it drew and posts
 * the markup back, and the parent renders that in the same-origin capture
 * frame it already uses for `html` artifacts. This module owns the request /
 * response correlation for that round trip.
 *
 * A plain module-level Map for the same reason `preview-registry.ts` uses one:
 * nothing renders off it, it is read once per export, and a React context
 * would re-render every preview whenever an unrelated one mounted.
 */

import { awaitPreviewRevision } from "@/lib/artifacts/preview-registry"

/** A capture the frame could not answer. */
export class ArtifactFrameCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactFrameCaptureError"
  }
}

/** The frame never answered. Almost always a preview that was closed mid-export. */
export class ArtifactFrameCaptureTimeoutError extends Error {
  constructor(artifactId: string, ms: number) {
    super(`artifact ${artifactId} preview did not answer a capture within ${ms}ms`)
    this.name = "ArtifactFrameCaptureTimeoutError"
  }
}

export interface ArtifactFrameSnapshot {
  /** A complete HTML document of what the frame rendered. */
  html: string
  width: number
  height: number
}

/**
 * Default ceiling on the round trip. Generous because the frame may still be
 * painting, but finite because a closed preview never answers at all.
 */
export const FRAME_CAPTURE_TIMEOUT_MS = 10_000

/** One live preview frame's way of answering for its artifact. */
export interface ArtifactFrameCapturer {
  /**
   * Whether the frame runs scripts (React, interactive HTML). What such a frame
   * shows can differ from its source, so an export captures it; a static frame
   * is re-rendered from source instead, which draws the same thing.
   */
  live: boolean
  /**
   * The revision this registration answers for. A frame re-registers on every
   * content change, and holds a request until that revision has rendered.
   */
  shows: () => string | null
  /**
   * Ask the frame for a snapshot of `content`. Rejects with
   * `ArtifactPreviewOutdatedError` when the frame has moved on to another
   * revision by the time it would be asked.
   */
  capture: (timeoutMs: number, content: string) => Promise<ArtifactFrameSnapshot>
}

/**
 * Stacked per id, newest last, like `preview-registry.ts`: the chat card and
 * the dock can both show one artifact, and unmounting one must leave the other
 * answering.
 */
const capturers = new Map<string, ArtifactFrameCapturer[]>()

/** Record a frame that can answer for `artifactId`, returning a disposer for this one only. */
export function registerArtifactFrameCapturer(
  artifactId: string,
  capturer: ArtifactFrameCapturer
): () => void {
  capturers.set(artifactId, [...(capturers.get(artifactId) ?? []), capturer])
  return () => {
    const remaining = (capturers.get(artifactId) ?? []).filter((item) => item !== capturer)
    if (remaining.length > 0) capturers.set(artifactId, remaining)
    else capturers.delete(artifactId)
  }
}

/** Whether a live frame is currently able to answer for `artifactId`. */
export function hasArtifactFrameCapturer(artifactId: string): boolean {
  return capturers.has(artifactId)
}

/**
 * Ask a frame showing `content` for a snapshot. `null` when no frame (or, with
 * `liveOnly`, no scripted frame) is mounted, so the caller can raise the same
 * "preview it first" error it raises for renderer types or fall back to the
 * source. A frame a render behind gets a moment to catch up; one showing
 * another revision rejects with `ArtifactPreviewOutdatedError`.
 */
export function captureArtifactFrame(
  artifactId: string,
  content: string,
  options: { timeoutMs?: number; liveOnly?: boolean; catchUpMs?: number } = {}
): Promise<ArtifactFrameSnapshot | null> {
  const timeoutMs = options.timeoutMs ?? FRAME_CAPTURE_TIMEOUT_MS
  const find = (): ArtifactFrameCapturer | "outdated" | null => {
    const candidates = [...(capturers.get(artifactId) ?? [])]
      .reverse()
      .filter((capturer) => !options.liveOnly || capturer.live)
    if (candidates.length === 0) return null
    return candidates.find((capturer) => capturer.shows() === content) ?? "outdated"
  }
  // Asked in this tick when a frame already answers for the revision, so the
  // request reaches it before anything else the caller does next.
  const found = find()
  if (found === null) return Promise.resolve(null)
  if (found !== "outdated") return found.capture(timeoutMs, content)
  return awaitPreviewRevision(artifactId, find, options.catchUpMs).then((capturer) =>
    capturer ? capturer.capture(timeoutMs, content) : null
  )
}

/** Test seam. The registry is module state, so a suite has to be able to clear it. */
export function __resetArtifactFrameCapturersForTests(): void {
  capturers.clear()
}
