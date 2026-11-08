import {
  closePlayback,
  getPlaybackRequest,
  requestPlayback,
  subscribePlaybackRequest,
} from "./playback-request"
import type { TerminalRecording } from "./types"

const rec = { id: "r1" } as TerminalRecording

afterEach(() => closePlayback())

describe("playback request", () => {
  it("holds the requested recording until closed, notifying on each change", () => {
    const listener = jest.fn()
    const off = subscribePlaybackRequest(listener)
    requestPlayback(rec)
    requestPlayback(rec)
    expect(getPlaybackRequest()).toBe(rec)
    closePlayback()
    expect(getPlaybackRequest()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    requestPlayback(rec)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
