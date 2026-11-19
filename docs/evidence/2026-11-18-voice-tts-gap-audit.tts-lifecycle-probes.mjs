// Run: node --import tsx docs/evidence/2026-11-18-voice-tts-gap-audit.tts-lifecycle-probes.mjs
// Executes current production functions with only browser audio/provider seams replaced.
import assert from "node:assert/strict"
import { TTSOrchestrator } from "../../packages/tts/src/tts-orchestrator.ts"
import { DEFAULT_SPEECH_SETTINGS } from "../../packages/tts/src/types.ts"
import { setTtsHost } from "../../packages/tts/src/host.ts"

const speech = {
  pauseCount: 0,
  resumeCount: 0,
  cancel() {},
  pause() {
    this.pauseCount++
  },
  resume() {
    this.resumeCount++
  },
  getVoices() {
    return []
  },
  speak(utterance) {
    utterance.onstart?.()
  },
}
globalThis.window = { speechSynthesis: speech }
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text
  }
}
setTtsHost({ allowCloudText: () => true })
class AudioMock {
  currentTime = 0
  duration = 10
  async play() {
    this.onplay?.()
  }
  pause() {
    this.onpause?.()
  }
}
globalThis.Audio = AudioMock
const settings = {
  ...DEFAULT_SPEECH_SETTINGS,
  ttsEnabled: true,
  ttsProvider: "openai",
  ttsFallbackEnabled: false,
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const response = () => ({ success: true, audioData: new ArrayBuffer(4), mimeType: "audio/mpeg" })

const stopped = new TTSOrchestrator()
stopped.generateChunkAudio = async () => response()
let settled = false
void stopped.speak("Hello", { speechSettings: settings }).then(() => {
  settled = true
})
await wait(10)
stopped.stop()
await wait(20)
assert.equal(stopped.getState().playbackState, "stopped")
assert.equal(settled, false)
console.log(
  JSON.stringify({
    probe: "stop-buffered-playback-promise",
    state: stopped.getState().playbackState,
    settled,
  })
)

const fallback = new TTSOrchestrator()
fallback.generateChunkAudio = async () => ({
  success: false,
  error: "permanent provider failure",
  errorType: "api-error",
  status: 401,
})
void fallback.speak("Hello fallback", { speechSettings: { ...settings, ttsFallbackEnabled: true } })
await wait(10)
fallback.pause()
fallback.resume()
assert.equal(speech.pauseCount, 0)
assert.equal(speech.resumeCount, 0)
assert.equal(fallback.getState().currentProvider, "openai")
console.log(
  JSON.stringify({
    probe: "fallback-pause-resume",
    provider: fallback.getState().currentProvider,
    pauseCalls: speech.pauseCount,
    resumeCalls: speech.resumeCount,
    state: fallback.getState().playbackState,
  })
)
fallback.stop()

globalThis.Audio = class extends AudioMock {
  async play() {
    this.onplay?.()
    queueMicrotask(() => this.onended?.())
  }
}
const streaming = new TTSOrchestrator()
const lengths = []
streaming.generateChunkAudio = async ({ chunk }) => {
  lengths.push(chunk.length)
  return response()
}
await streaming.speakStream(
  (async function* () {
    yield "First phrase. "
    yield "x".repeat(5000)
  })(),
  { speechSettings: settings }
)
assert.deepEqual(lengths, [13, 5000])
console.log(
  JSON.stringify({ probe: "stream-fragment-provider-max", sentLengths: lengths, openaiMax: 4096 })
)
