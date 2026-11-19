const rootRequire = require("node:module").createRequire(process.cwd() + "/package.json")
// Read-only behavioral probes: current source, mocked media/network boundaries.
const fs = require("node:fs")
const assert = require("node:assert/strict")
const ts = rootRequire("typescript")

function load(file, mocks = {}) {
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  new Function("require", "module", "exports", source)(
    (name) => {
      if (name in mocks) return mocks[name]
      throw new Error("Unmocked dependency: " + name)
    },
    mod,
    mod.exports
  )
  return mod.exports
}

const gate = load("lib/voice/live/audio-gate.ts")
const { LiveVoiceController } = load("lib/voice/live/controller.ts", {
  "./audio-gate": gate,
  "./capture": {},
  "./context": {
    buildLiveVoiceContextEvent: (text) => ({ type: "conversation-item-create", item: { text } }),
  },
  "./pcm-codec": { encodeUplinkAudio: () => "AA==", resampleAudio: (a) => a },
  "./playback": {},
  "./transport": {},
  "./tool-runtime": {},
  "./reducer": {
    createInitialLiveVoiceState: () => ({
      phase: "idle",
      turns: [],
      assistantDraft: "",
      muted: false,
    }),
    assertLiveVoicePayloadPiiSafe: () => {},
    classifyLiveVoiceError: (error) => ({
      code: "network",
      message: error.message,
      retryable: true,
    }),
    reduceLiveVoiceServerEvent: (state, event) =>
      event.type === "session-updated" ? { ...state, phase: "listening" } : state,
  },
  "@/lib/telemetry/events/track-event": { trackEvent: async () => {} },
})

const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
const session = {
  provider: "openai",
  connection: "ephemeral",
  capabilities: {
    inputSampleRate: 24000,
    outputSampleRate: 24000,
    supportsServerVad: true,
    supportsInputTranscript: true,
    supportsOutputTranscript: true,
    supportsTools: true,
  },
}

function harness({ deferCapture, reconnect } = {}) {
  const captures = [],
    sockets = []
  let release
  const controller = new LiveVoiceController({
    session,
    adapter: {},
    reconnectSession: reconnect,
    sleep: async () => {},
    createCapture: (options) => {
      const capture = {
        muted: false,
        disposed: false,
        sampleRateMatches: true,
        start: () =>
          deferCapture
            ? new Promise((resolve) => {
                release = resolve
              })
            : Promise.resolve(),
        dispose: async () => {
          capture.disposed = true
        },
        setMuted: (value) => {
          capture.muted = value
        },
        onFrame: options.onFrame,
      }
      captures.push(capture)
      return capture
    },
    createPlayback: () => ({
      state: "idle",
      stop() {},
      interrupt() {},
      playedMs() {
        return 0
      },
      endTurn() {},
    }),
    createTransport: (options) => {
      const socket = {
        closed: false,
        sent: [],
        connect: async () => {
          options.onOpen()
          options.onServerEvent({ type: "session-updated" })
        },
        send: (event) => socket.sent.push(event),
        close: () => {
          socket.closed = true
        },
        hooks: options,
      }
      sockets.push(socket)
      return socket
    },
  })
  return { controller, captures, sockets, release: () => release() }
}

;(async () => {
  const captureRace = harness({ deferCapture: true })
  await captureRace.controller.start()
  await tick()
  await captureRace.controller.stop()
  captureRace.release()
  await tick()
  assert.equal(captureRace.controller.getSnapshot().phase, "listening")
  assert.equal(captureRace.captures[0].disposed, false)
  assert.notEqual(captureRace.controller.capture, null)
  console.log(
    JSON.stringify({
      probe: "end during capture initialization",
      phaseAfterEnd: captureRace.controller.getSnapshot().phase,
      captureDisposed: captureRace.captures[0].disposed,
      retainedCapture: captureRace.controller.capture !== null,
    })
  )
  await captureRace.controller.stop()

  let releaseMint
  const reconnectRace = harness({
    reconnect: () =>
      new Promise((resolve) => {
        releaseMint = resolve
      }),
  })
  await reconnectRace.controller.start()
  await tick()
  reconnectRace.captures[0].onFrame({ samples: new Float32Array([0]), rms: 0 })
  reconnectRace.sockets[0].hooks.onClose()
  await tick()
  await reconnectRace.controller.stop()
  releaseMint({ session, adapter: {}, sessionConfig: {} })
  await tick()
  assert.equal(reconnectRace.sockets.length, 2)
  assert.equal(reconnectRace.sockets[1].closed, false)
  assert.equal(reconnectRace.controller.getSnapshot().phase, "listening")
  console.log(
    JSON.stringify({
      probe: "end during successful reconnect mint",
      socketCount: reconnectRace.sockets.length,
      newSocketClosed: reconnectRace.sockets[1].closed,
      phaseAfterEnd: reconnectRace.controller.getSnapshot().phase,
      captureCount: reconnectRace.captures.length,
    })
  )
  await reconnectRace.controller.stop()

  const approval = harness()
  await approval.controller.start()
  await tick()
  const releaseGate = approval.controller.gate.suspend()
  approval.controller.setMuted(true)
  approval.controller.setMuted(false)
  assert.equal(approval.controller.gate.suspended, true)
  assert.equal(approval.captures[0].muted, false)
  console.log(
    JSON.stringify({
      probe: "user unmute during approval",
      approvalGateSuspended: approval.controller.gate.suspended,
      microphoneMuted: approval.captures[0].muted,
    })
  )
  releaseGate()
  await approval.controller.stop()
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
