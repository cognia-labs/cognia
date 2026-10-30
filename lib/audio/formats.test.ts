import { canTranscodeAudio, normalizeAudioMime, validateAudioRequest } from "./formats"

it.each(["audio/aac", "audio/x-aac", "audio/aacp", "audio/mp4", "audio/m4a", "audio/x-m4a"])(
  "admits %s as a shared input format for WAV/SILK",
  (mime) => {
    expect(canTranscodeAudio(mime, "audio/silk")).toBe(true)
    expect(canTranscodeAudio(mime, "audio/wav")).toBe(true)
    expect(canTranscodeAudio("audio/wav", mime)).toBe(false)
    expect(() =>
      validateAudioRequest({
        bytes: new Uint8Array([1]),
        source: { mimeType: mime },
        target: "silk",
      })
    ).not.toThrow()
  }
)
it("normalizes M4A aliases and parameters without admitting arbitrary file types", () => {
  expect(normalizeAudioMime(" Audio/X-M4A; codecs=mp4a.40.2")).toBe("audio/mp4")
  expect(canTranscodeAudio("video/mp4", "audio/silk")).toBe(false)
  expect(canTranscodeAudio("audio/webm", "audio/wav")).toBe(false)
  expect(() =>
    validateAudioRequest({
      bytes: new Uint8Array(),
      source: { mimeType: "audio/aac" },
      target: "silk",
    })
  ).toThrow("empty")
})
