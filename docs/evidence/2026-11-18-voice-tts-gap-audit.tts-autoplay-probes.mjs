// Run: node --import tsx docs/evidence/2026-11-18-voice-tts-gap-audit.tts-autoplay-probes.mjs
// Real React/RTL, real hook source and pushable stream. Only settings/port/logging are mocked.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { resolve } from "node:path"
import { createPushableStream } from "../../lib/utils/pushable-stream.ts"
import { canAutoPlayTTS } from "../../packages/tts/src/auto-play-gates.ts"

const require = createRequire(`${process.cwd()}/package.json`)
const ts = require("typescript")
const envRequire = createRequire(require.resolve("jest-environment-jsdom"))
const { JSDOM } = envRequire("jsdom")
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = require("react")
const { renderHook, act, cleanup } = require("@testing-library/react")
const calls = []
const flags = { ttsEnabled: true, ttsAutoPlay: true }
const speech = {
  readAloud: {
    async speakChatMessageStream(stream, options) {
      const call = { id: options.messageId, chunks: [] }
      calls.push(call)
      for await (const text of stream) call.chunks.push(text)
    },
    async speakChatMessage(options) {
      calls.push({ id: options.messageId, whole: options.text })
    },
  },
}
const mocks = {
  react: React,
  "@/stores/settings": { useSettingsStore: (selector) => selector({ settings: flags }) },
  "@cognia/tts/auto-play-gates": { canAutoPlayTTS },
  "@/lib/modules/ports": { loadPort: async () => speech },
  "@/lib/utils/pushable-stream": { createPushableStream },
  "@cognia/logging": { loggers: { tts: { warn() {} } } },
}
const path = resolve("hooks/chat/use-chat-auto-play-tts.ts")
const source = ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: path })(
  (id) => {
    if (id in mocks) return mocks[id]
    throw new Error(`Unexpected dependency ${id}`)
  },
  module,
  module.exports
)
const { useChatAutoPlayTTS } = module.exports
const assistant = (text) => ({ id: "a1", role: "assistant", parts: [{ type: "text", text }] })
const flush = () => act(async () => {})

const first = renderHook((props) => useChatAutoPlayTTS(props), {
  initialProps: { messages: [assistant("Hello")], status: "streaming" },
})
await flush()
first.rerender({ messages: [assistant("Hello final tail")], status: "idle" })
await flush()
assert.equal(calls.length, 1)
assert.deepEqual(calls[0].chunks, ["Hello"])
console.log(
  JSON.stringify({
    probe: "autoplay-final-delta",
    message: "Hello final tail",
    spoken: calls[0].chunks.join(""),
  })
)
cleanup()
calls.length = 0

const previous = assistant("Previous answer")
const second = renderHook((props) => useChatAutoPlayTTS(props), {
  initialProps: { messages: [previous], status: "idle" },
})
await flush()
second.rerender({
  messages: [
    previous,
    { id: "u2", role: "user", parts: [{ type: "text", text: "Next question" }] },
  ],
  status: "streaming",
})
await flush()
assert.equal(calls.length, 1)
assert.equal(calls[0].id, "a1")
assert.deepEqual(calls[0].chunks, ["Previous answer"])
console.log(
  JSON.stringify({
    probe: "autoplay-replays-previous-turn",
    newAssistantExists: false,
    spoken: calls[0].chunks.join(""),
  })
)
cleanup()
dom.window.close()
