const rootRequire = require("node:module").createRequire(process.cwd() + "/package.json")
const fs = require("node:fs")
const assert = require("node:assert/strict")
const ts = rootRequire("typescript")
function load(file, mocks = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (name in mocks) return mocks[name]
      throw new Error("Unmocked dependency: " + name)
    },
    mod,
    mod.exports
  )
  return mod.exports
}
const captureSource = load("lib/voice/live/capture-worklet-source.ts")
const { MicCapture } = load("lib/voice/live/capture.ts", {
  "./capture-worklet-source": captureSource,
})
const reducer = load("lib/voice/live/reducer.ts", {
  "@cognia/redact": {
    hasNoLeakingPii: () => true,
    hasNoLeakingPiiDeep: () => true,
    redactText: (text) => ({ redacted: text }),
  },
  "@cognia/provider-routing/error-classifier": {},
})
const { createLiveVoiceTurnPersister } = load("lib/voice/live/persist-turns.ts")
function stream() {
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true
    },
  }
  return { track, getTracks: () => [track], getAudioTracks: () => [track] }
}
async function main() {
  let releaseDevice
  const first = stream(),
    late = stream()
  const capture = new MicCapture({
    sampleRate: 24000,
    frameSamples: 480,
    onFrame() {},
    initialStream: first,
    getUserMedia: () =>
      new Promise((resolve) => {
        releaseDevice = resolve
      }),
    audioContextFactory: () => ({
      sampleRate: 24000,
      state: "running",
      audioWorklet: { addModule: async () => {} },
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      resume: async () => {},
      close: async () => {},
    }),
    createWorkletNode: () => ({
      port: { onmessage: null, postMessage() {} },
      connect() {},
      disconnect() {},
    }),
    createModuleUrl: () => "mock-worklet",
    revokeModuleUrl() {},
  })
  await capture.start()
  const switching = capture.setDevice("second-mic")
  await capture.dispose()
  releaseDevice(late)
  const error = await switching.then(
    () => null,
    (error) => error
  )
  assert.match(error.message, /null/)
  assert.equal(first.track.stopped, true)
  assert.equal(late.track.stopped, false)
  console.log(
    JSON.stringify({
      probe: "late microphone switch after dispose",
      error: error.message,
      originalTrackStopped: first.track.stopped,
      lateTrackStopped: late.track.stopped,
    })
  )
  late.track.stop()

  const { createGoogle } = await import(rootRequire.resolve("@ai-sdk/google"))
  const provider = createGoogle({ apiKey: "synthetic-unused" })
  const provenance = { provider: "google", modelOrResource: "synthetic", region: "global" }
  let stored = []
  const persister = createLiveVoiceTurnPersister({
    sessionId: "same-call",
    startedAt: 1000,
    provenance,
    loadExisting: async () => stored,
    persist: async (_id, messages) => {
      stored = messages
    },
  })
  let state = reducer.createInitialLiveVoiceState()
  for (const text of ["before reconnect", "after reconnect"]) {
    const mapper = provider.experimental_realtime("synthetic")
    const event = mapper.parseServerEvent({
      serverContent: { inputTranscription: { text, finished: true } },
    })
    state = reducer.reduceLiveVoiceServerEvent(state, event)
    await persister.append(state.turns)
  }
  await persister.flush(state.turns)
  assert.equal(state.turns.length, 1)
  assert.equal(state.turns[0].text, "after reconnect")
  assert.equal(stored[0].parts[0].text, "before reconnect")
  console.log(
    JSON.stringify({
      probe: "Google fresh mapper in same persister on reconnect",
      visible: state.turns,
      stored: stored.map((message) => ({ id: message.id, text: message.parts[0].text })),
    })
  )

  const mapper = provider.experimental_realtime("synthetic")
  let batched = reducer.createInitialLiveVoiceState()
  for (const part of [
    { text: "hello ", finished: false },
    { text: "world", finished: true },
  ]) {
    batched = reducer.reduceLiveVoiceServerEvent(
      batched,
      mapper.parseServerEvent({ serverContent: { inputTranscription: part } })
    )
  }
  stored = []
  const batchedPersister = createLiveVoiceTurnPersister({
    sessionId: "batched",
    startedAt: 1000,
    provenance,
    loadExisting: async () => stored,
    persist: async (_id, messages) => {
      stored = messages
    },
  })
  await batchedPersister.append(batched.turns)
  assert.equal(stored[0].parts[0].text, "hello world")
  console.log(
    JSON.stringify({
      probe: "F02 control: final-only append retains full transcript",
      storedText: stored[0].parts[0].text,
    })
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
