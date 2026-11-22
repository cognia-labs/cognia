import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

// Run from the repository root. Real receiver methods, fake live network carriers.
const ts = createRequire(path.join(process.cwd(), "package.json"))("typescript")
const files = {
  companion: "lib/tauri/transport-companion.ts",
  rtc: "lib/tauri/transport-rtc.ts",
  subscription: "lib/notifications/remote-subscription.ts",
}
const dependencies = {
  "@/lib/connectivity/lan-classify": { classifyWsHost: () => "ws-tunnel" },
  "./companion-contract": { onHostContractChange: () => () => {} },
  "./pinned-fetch": { usesNativePinnedRoute: () => false },
  "@/lib/tauri/datachannel-framing": { RtcChunkReassembler: class {} },
  "@/lib/execution/personal-sink": { unverifiedPersonalSinkContext: () => ({}) },
}
const loaded = {}

function load(name) {
  if (loaded[name]) return loaded[name].exports
  const file = files[name]
  const module = { exports: {} }
  loaded[name] = module
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  function cjsRequire(spec) {
    if (spec === "./transport-rtc") return load("rtc")
    return dependencies[spec] ?? {}
  }
  new Function("module", "exports", "require", outputText)(module, module.exports, cjsRequire)
  return module.exports
}

const { CompanionTransport } = load("companion")
const { TransportRtc } = load("rtc")
const { subscribeRemoteNotifications } = load("subscription")
const companion = new CompanionTransport({
  configProvider: () => ({ baseUrl: "https://tunnel.example" }),
})
const rtc = new TransportRtc({
  persistEventCursor: false,
  rendezvousId: "test",
  signalingRoomDescriptor: { roomId: "test" },
})
companion.ws = { readyState: 0 }
companion.connectionState = "connected"
companion.rtc = rtc
rtc.state = "open"
rtc.sendRawFrame = () => {}

const calls = []
subscribeRemoteNotifications({
  transport: companion,
  hostKey: "test-host",
  notifyFn: async (input) => {
    calls.push(input)
    return "row"
  },
})
const topic = "notification://remote"
const payload = { id: "one-publication", source: "scheduler", level: "warning", title: "Synthetic" }
const wsEvent = JSON.stringify({ type: topic, seq: 3, payload })
const rtcEvent = { kind: "event", event: topic, seq: 3, payload }
companion.handleWsMessage(wsEvent)
companion.handleWsMessage(wsEvent)
assert.equal(calls.length, 1, "same WS-sequence frame dispatched more than once")
rtc.acceptRtcEvent(rtcEvent)
rtc.acceptRtcEvent(rtcEvent)
assert.equal(calls.length, 2, "different lanes did not deliver the same publication twice")
assert.deepEqual(calls[0], calls[1])
console.log(JSON.stringify({ sameWsSequence: 1, sameHostFrameAcrossWsAndRtc: calls.length }))
