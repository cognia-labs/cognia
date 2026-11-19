// Run: node --import tsx docs/evidence/2026-11-18-voice-tts-gap-audit.tts-boundary-probes.mjs
// Real orchestrator/provider/gate functions; transport/audio replaced, no network.
import assert from "node:assert/strict"
import { TTSOrchestrator } from "../../packages/tts/src/tts-orchestrator.ts"
import { DEFAULT_SPEECH_SETTINGS } from "../../packages/tts/src/types.ts"
import { setTtsHost } from "../../packages/tts/src/host.ts"
import { hasNoLeakingPii } from "../../packages/redact/src/index.ts"
import { generateLocalOpenAICompatibleTTS } from "../../packages/tts/src/providers/local-openai-compatible.ts"
import { generateOpenAITTS } from "../../packages/tts/src/providers/openai.ts"

globalThis.Audio = class {
  currentTime = 0
  duration = 1
  pause() {}
  async play() {
    this.onplay?.()
    queueMicrotask(() => this.onended?.())
  }
}
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text
  }
}
const sent = []
const gateInputs = []
const remoteVoice = {
  name: "Remote test voice",
  voiceURI: "remote:test",
  lang: "en-US",
  localService: false,
}
let spokenUtterance
globalThis.window = {
  speechSynthesis: {
    cancel() {},
    getVoices() {
      return [remoteVoice]
    },
    speak(utterance) {
      spokenUtterance = utterance
      utterance.onstart?.()
      queueMicrotask(() => utterance.onend?.())
    },
  },
}
const response = {
  ok: true,
  status: 200,
  mime: "audio/mpeg",
  bytes: new ArrayBuffer(4),
  text: async () => "",
  json: async () => ({}),
}
const settings = {
  ...DEFAULT_SPEECH_SETTINGS,
  ttsEnabled: true,
  ttsProvider: "openai",
  ttsFallbackEnabled: false,
  ttsCacheEnabled: false,
}
setTtsHost({
  allowCloudText(text) {
    gateInputs.push(text)
    return hasNoLeakingPii(text)
  },
  nativeProxyFetch: async (_url, init) => {
    sent.push(init.json)
    return response
  },
})
const original = "Contact alice@example.com"
await new TTSOrchestrator().speak(original, {
  speechSettings: settings,
  providerSettings: { openai: { apiKey: "synthetic-test-key" } },
})
assert.equal(hasNoLeakingPii(original), false)
assert.equal(sent[0].input, "Contact alice at example.com")
assert.equal(gateInputs.includes(original), false)
console.log(
  JSON.stringify({
    probe: "read-aloud-pii-after-normalization",
    rawPassesGate: false,
    rawGateCalled: false,
    capturedProviderText: sent[0].input,
  })
)

let gateCalls = 0
setTtsHost({
  allowCloudText() {
    gateCalls++
    return false
  },
})
await new TTSOrchestrator().speak(original, {
  speechSettings: { ...settings, ttsProvider: "system", systemVoice: remoteVoice.voiceURI },
})
assert.equal(gateCalls, 0)
assert.equal(spokenUtterance.voice.localService, false)
console.log(
  JSON.stringify({
    probe: "system-remote-voice-policy",
    localService: spokenUtterance.voice.localService,
    gateCalls,
    speakCalled: true,
  })
)

let browserFetchOptions
setTtsHost({})
globalThis.fetch = async (_url, init) => {
  browserFetchOptions = init
  return {
    ...response,
    headers: new Headers({ "content-type": "audio/mpeg" }),
    arrayBuffer: async () => new ArrayBuffer(4),
  }
}
await generateLocalOpenAICompatibleTTS("Private example", {
  baseUrl: "http://127.0.0.1:8880/v1",
  model: "test",
  voice: "test",
})
assert.equal(browserFetchOptions.redirect, undefined)
console.log(
  JSON.stringify({
    probe: "browser-local-redirect-policy",
    redirectOption: browserFetchOptions.redirect ?? "omitted (fetch default follows redirects)",
    networkUsed: false,
  })
)

const overlong = await generateOpenAITTS("x".repeat(5000), { apiKey: "synthetic-test-key" })
assert.equal(overlong.errorType, "text-too-long")
console.log(
  JSON.stringify({
    probe: "real-openai-adapter-overlong-result",
    success: overlong.success,
    errorType: overlong.errorType,
    providerMessage: overlong.providerMessage,
  })
)
