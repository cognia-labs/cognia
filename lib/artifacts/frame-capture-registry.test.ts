/**
 * @jest-environment jsdom
 */

import {
  ArtifactFrameCaptureError,
  captureArtifactFrame,
  hasArtifactFrameCapturer,
  registerArtifactFrameCapturer,
  __resetArtifactFrameCapturersForTests,
  type ArtifactFrameCapturer,
} from "./frame-capture-registry"
import { ArtifactPreviewOutdatedError } from "./preview-registry"

const snapshot = { html: "<!DOCTYPE html><html></html>", width: 800, height: 400 }

function frame(content: string | null, overrides: Partial<ArtifactFrameCapturer> = {}) {
  const capture = jest.fn(async (_ms: number, _content: string) => snapshot)
  const capturer: ArtifactFrameCapturer = {
    live: true,
    shows: () => content,
    capture,
    ...overrides,
  }
  return { capturer, capture }
}

describe("frame capture registry", () => {
  beforeEach(() => __resetArtifactFrameCapturersForTests())
  afterEach(() => jest.useRealTimers())

  it("returns null when no preview is mounted", async () => {
    // `null` rather than a throw: the caller raises the same "preview it first"
    // error it already raises for renderer types.
    expect(await captureArtifactFrame("missing", "v1")).toBeNull()
    expect(hasArtifactFrameCapturer("missing")).toBe(false)
  })

  it("routes a capture to the frame showing the requested content", async () => {
    const { capturer, capture } = frame("v1")
    registerArtifactFrameCapturer("a1", capturer)
    expect(hasArtifactFrameCapturer("a1")).toBe(true)
    expect(await captureArtifactFrame("a1", "v1", { timeoutMs: 1234 })).toEqual(snapshot)
    expect(capture).toHaveBeenCalledWith(1234, "v1")
  })

  it("asks only a scripted frame when the caller wants what scripts drew", async () => {
    registerArtifactFrameCapturer("a1", frame("v1", { live: false }).capturer)
    expect(await captureArtifactFrame("a1", "v1", { liveOnly: true })).toBeNull()
  })

  it("prefers the newest frame and falls back when it unmounts (C08)", async () => {
    const card = frame("v1")
    const dock = frame("v1")
    registerArtifactFrameCapturer("a1", card.capturer)
    const disposeDock = registerArtifactFrameCapturer("a1", dock.capturer)
    await captureArtifactFrame("a1", "v1")
    expect(dock.capture).toHaveBeenCalled()
    disposeDock()
    // A single slot used to be emptied here, with the card's frame still up.
    expect(hasArtifactFrameCapturer("a1")).toBe(true)
    await captureArtifactFrame("a1", "v1")
    expect(card.capture).toHaveBeenCalled()
  })

  it("a stale disposer cannot unregister the live frame", async () => {
    const first = frame("v1")
    const disposeFirst = registerArtifactFrameCapturer("a1", first.capturer)
    const second = frame("v1")
    registerArtifactFrameCapturer("a1", second.capturer)
    disposeFirst()
    disposeFirst()
    await captureArtifactFrame("a1", "v1")
    expect(second.capture).toHaveBeenCalled()
    expect(first.capture).not.toHaveBeenCalled()
  })

  it("never answers a request for one revision with another's pixels (C08)", async () => {
    jest.useFakeTimers()
    const moved = frame("v2")
    registerArtifactFrameCapturer("a1", moved.capturer)
    const pending = captureArtifactFrame("a1", "v1", { catchUpMs: 300 })
    const assertion = expect(pending).rejects.toBeInstanceOf(ArtifactPreviewOutdatedError)
    await jest.advanceTimersByTimeAsync(400)
    await assertion
    expect(moved.capture).not.toHaveBeenCalled()
  })

  it("waits for a frame still rendering the requested revision", async () => {
    jest.useFakeTimers()
    let content: string | null = null
    const rendering = frame(null, { shows: () => content })
    registerArtifactFrameCapturer("a1", rendering.capturer)
    const pending = captureArtifactFrame("a1", "v1")
    content = "v1"
    await jest.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toEqual(snapshot)
  })

  it("stops answering once the preview unmounts", async () => {
    const dispose = registerArtifactFrameCapturer("a1", frame("v1").capturer)
    dispose()
    expect(await captureArtifactFrame("a1", "v1")).toBeNull()
  })

  it("propagates a frame-side failure", async () => {
    registerArtifactFrameCapturer(
      "a1",
      frame("v1", {
        capture: async () => {
          throw new ArtifactFrameCaptureError("frame said no")
        },
      }).capturer
    )
    await expect(captureArtifactFrame("a1", "v1")).rejects.toBeInstanceOf(ArtifactFrameCaptureError)
  })
})
