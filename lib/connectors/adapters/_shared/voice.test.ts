import { normalizeInboundVoice } from "./voice"
it("preserves original identity, conversion and an ASR hint for any platform", () => {
  expect(
    normalizeInboundVoice({
      url: "https://media.example.org/a.silk",
      convertedWavUrl: "https://media.example.org/a.wav",
      transcript: " Hi ",
    })
  ).toEqual({
    type: "voice",
    url: "https://media.example.org/a.wav",
    rawUrl: "https://media.example.org/a.silk",
    mimeType: "audio/wav",
    transcript: "Hi",
  })
})
it.each([
  "file:///a.wav",
  "http://127.0.0.1/a.wav",
  "https://u:p@example.org/a.wav",
  "javascript:x",
])("refuses unsafe optional conversion %s", (convertedWavUrl) => {
  expect(
    normalizeInboundVoice({
      url: "https://media.example.org/a.silk",
      mimeType: "audio/silk",
      convertedWavUrl,
    })
  ).toEqual({ type: "voice", url: "https://media.example.org/a.silk", mimeType: "audio/silk" })
})
