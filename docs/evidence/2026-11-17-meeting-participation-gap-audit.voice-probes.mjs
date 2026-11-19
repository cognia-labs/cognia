/**
 * Read-only product-code audit probe. Uses synthetic audio objects only.
 * Run from the repository root:
 *   rtk proxy node docs/evidence/2026-11-17-meeting-participation-gap-audit.voice-probes.mjs
 * No network, browser, credentials, real microphone, or product source writes.
 * TypeScript is transpiled in memory from the current checkout.
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"

const require = createRequire(path.resolve("package.json"))
const ts = require("typescript")
const root = process.cwd()
const artifactDirectory = path.join(root, ".cache/meeting-participation-audit-20261117")
fs.mkdirSync(artifactDirectory, { recursive: true })
const sourcePaths = ["lib/voice/live/capture.ts", "lib/voice/live/capture-worklet-source.ts"]
const loaded = new Map()

function loadTypeScript(file) {
  const absolute = path.resolve(root, file)
  if (loaded.has(absolute)) return loaded.get(absolute).exports
  const mod = { exports: {} }
  loaded.set(absolute, mod)
  const source = fs.readFileSync(absolute, "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const relativeRequire = (name) =>
    name.startsWith(".")
      ? loadTypeScript(path.resolve(path.dirname(absolute), `${name}.ts`))
      : require(name)
  new Function("require", "module", "exports", compiled)(relativeRequire, mod, mod.exports)
  return mod.exports
}

function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function fakeStream() {
  const track = {
    enabled: true,
    stopCalls: 0,
    stop() {
      this.stopCalls++
    },
  }
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => [track],
  }
}

const { MicCapture } = loadTypeScript("lib/voice/live/capture.ts")

function harness(options = {}) {
  const stream = fakeStream()
  const node = { connect() {}, disconnect() {} }
  const context = {
    sampleRate: 24000,
    state: "running",
    audioWorklet: { addModule: options.addModule ?? (async () => {}) },
    createMediaStreamSource: () => node,
    close: async () => {},
    resume: async () => {},
  }
  const capture = new MicCapture({
    sampleRate: 24000,
    frameSamples: 480,
    onFrame() {},
    getUserMedia: options.getUserMedia ?? (async () => stream),
    initialStream: options.initialStream,
    audioContextFactory: () => context,
    createWorkletNode: () => ({
      ...node,
      port: { onmessage: null, postMessage() {} },
    }),
    createModuleUrl: () => "memory://synthetic-worklet",
    revokeModuleUrl() {},
  })
  return { capture, stream }
}

async function disposeWhileStartAcquiresStream() {
  const pending = deferred()
  const h = harness({ getUserMedia: () => pending.promise })
  const starting = h.capture.start()
  await h.capture.dispose()
  pending.resolve(h.stream)
  await starting
  const observation = {
    scenario: "dispose while start awaits getUserMedia",
    isRunningAfterDispose: h.capture.isRunning,
    trackStopCalls: h.stream.track.stopCalls,
    safeExpectation: "Capture remains stopped and the late stream is released.",
  }
  observation.defectReproduced =
    observation.isRunningAfterDispose && observation.trackStopCalls === 0
  await h.capture.dispose()
  return observation
}

async function disposeWhileStartLoadsWorklet() {
  const pending = deferred()
  const initialStream = fakeStream()
  const h = harness({ initialStream, addModule: () => pending.promise })
  const starting = h.capture.start()
  // start() reaches addModule synchronously because the stream was preflighted.
  await h.capture.dispose()
  pending.resolve()
  await starting
  const observation = {
    scenario: "dispose while start awaits addModule with a preflight stream",
    isRunningAfterDispose: h.capture.isRunning,
    trackStopCalls: initialStream.track.stopCalls,
    safeExpectation: "Capture remains stopped and its preflight stream is released.",
  }
  observation.defectReproduced =
    observation.isRunningAfterDispose && observation.trackStopCalls === 0
  await h.capture.dispose()
  return observation
}

async function disposeWhileDeviceSwitchAcquiresStream() {
  const pending = deferred()
  let calls = 0
  const h = harness({
    getUserMedia: () => (++calls === 1 ? Promise.resolve(h.stream) : pending.promise),
  })
  await h.capture.start()
  const switching = h.capture.setDevice("synthetic-mic-2")
  await h.capture.dispose()
  const next = fakeStream()
  pending.resolve(next)
  let error = null
  try {
    await switching
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const observation = {
    scenario: "dispose while setDevice awaits getUserMedia",
    error,
    previousTrackStopCalls: h.stream.track.stopCalls,
    nextTrackStopCalls: next.track.stopCalls,
    safeExpectation: "The late replacement stream is released without touching a disposed context.",
  }
  observation.defectReproduced =
    Boolean(error?.includes("createMediaStreamSource")) && observation.nextTrackStopCalls === 0
  // Explicit cleanup of the synthetic object that the product code lost.
  next.track.stop()
  return observation
}

const observations = [
  await disposeWhileStartAcquiresStream(),
  await disposeWhileStartLoadsWorklet(),
  await disposeWhileDeviceSwitchAcquiresStream(),
]
const result = {
  auditedAt: new Date().toISOString(),
  root,
  nodeVersion: process.version,
  typescriptVersion: ts.version,
  scope: "Synthetic injected streams only; no network, real devices, accounts, or meetings.",
  sources: sourcePaths.map((file) => ({
    path: file,
    sha256: createHash("sha256")
      .update(fs.readFileSync(path.join(root, file)))
      .digest("hex"),
  })),
  observations,
  allDefectsReproduced: observations.every((observation) => observation.defectReproduced),
}
fs.writeFileSync(
  path.join(artifactDirectory, "voice-lifecycle-results.json"),
  `${JSON.stringify(result, null, 2)}\n`
)
console.log(JSON.stringify(result, null, 2))
if (!result.allDefectsReproduced) process.exitCode = 1
