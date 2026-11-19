// Production orchestrator/provider/cache flow; injectable transport, cache I/O wait, and audio boundaries.
// No network, microphone, secrets, or product writes.
import assert from "node:assert/strict"
import { TTSOrchestrator } from "../../packages/tts/src/tts-orchestrator.ts"
import { ttsCache } from "../../packages/tts/src/tts-cache.ts"
import { DEFAULT_SPEECH_SETTINGS } from "../../packages/tts/src/types.ts"
import { setTtsHost } from "../../packages/tts/src/host.ts"
import { hasNoLeakingPii } from "../../packages/redact/src/index.ts"
import { createPushableStream } from "../../lib/utils/pushable-stream.ts"

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
globalThis.window = { speechSynthesis: { cancel() {} } }
let audioStarts = 0
globalThis.Audio = class {
  currentTime = 0
  duration = 1
  pause() {}
  async play() {
    audioStarts++
    this.onplay?.()
    queueMicrotask(() => this.onended?.())
  }
}
setTtsHost({
  allowCloudText: hasNoLeakingPii,
  nativeProxyFetch: async () => ({
    ok: true,
    status: 200,
    mime: "audio/mpeg",
    bytes: new ArrayBuffer(4),
    text: async () => "",
    json: async () => ({}),
  }),
})
const speechSettings = {
  ...DEFAULT_SPEECH_SETTINGS,
  ttsEnabled: true,
  ttsProvider: "openai",
  ttsCacheEnabled: true,
  ttsFallbackEnabled: false,
}
const options = { speechSettings, providerSettings: { openai: { apiKey: "synthetic-test-key" } } }
const originalGet = ttsCache.get
const originalSet = ttsCache.set
ttsCache.get = async () => null
for (const mode of ["buffered", "stream"]) {
  const entered = deferred()
  const release = deferred()
  ttsCache.set = async () => {
    entered.resolve()
    await release.promise
  }
  const orchestrator = new TTSOrchestrator()
  audioStarts = 0
  const run =
    mode === "buffered"
      ? orchestrator.speak("A complete sentence.", options)
      : orchestrator.speakStream(
          (async function* () {
            yield "A complete sentence."
          })(),
          options
        )
  await entered.promise
  orchestrator.stop()
  release.resolve()
  await run
  assert.equal(audioStarts, mode === "stream" ? 1 : 0)
  assert.equal(orchestrator.getState().playbackState, "stopped")
  console.log(
    JSON.stringify({ probe: "cancel-during-cache-write", mode, audioStartsAfterStop: audioStarts })
  )
}
ttsCache.get = originalGet
ttsCache.set = originalSet

const unhandled = []
const captureUnhandled = (reason) => {
  unhandled.push(String(reason))
}
const captureHandled = () => {}
process.on("unhandledRejection", captureUnhandled)
process.on("rejectionHandled", captureHandled)
const tokens = createPushableStream()
const orchestrator = new TTSOrchestrator()
let userErrors = 0
let settled = false
const run = orchestrator
  .speakStream(tokens.stream, {
    speechSettings: { ...speechSettings, ttsCacheEnabled: false },
    onError() {
      userErrors++
    },
  })
  .then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
tokens.push("A complete sentence.")
await wait(30)
assert.equal(settled, false)
assert.equal(userErrors, 0)
assert.equal(orchestrator.getState().playbackState, "loading")
assert.equal(unhandled.length, 1)
console.log(
  JSON.stringify({
    probe: "failure-before-token-source-closes",
    unhandled,
    settled,
    userErrors,
    state: orchestrator.getState().playbackState,
  })
)
tokens.close()
await run
await wait(0)
assert.equal(userErrors, 1)
process.removeListener("unhandledRejection", captureUnhandled)
process.removeListener("rejectionHandled", captureHandled)
