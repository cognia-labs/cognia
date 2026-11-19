// Run from repository root: node docs/evidence/2026-11-18-voice-tts-gap-audit.adversarial-dictation-probes.mjs
// Production component, real React/RTL; browser recognition is an EventTarget double.
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import vm from "node:vm"

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
const { render, act, fireEvent, cleanup } = require("@testing-library/react")
const instances = []
class Recognition extends dom.window.EventTarget {
  active = false
  starts = 0
  stops = 0
  constructor() {
    super()
    instances.push(this)
  }
  start() {
    this.starts++
    this.active = true
    this.dispatchEvent(new dom.window.Event("start"))
  }
  stop() {
    this.stops++
    if (this.active) {
      this.active = false
      queueMicrotask(() => this.dispatchEvent(new dom.window.Event("end")))
    }
  }
}
window.SpeechRecognition = Recognition
const stub = () => null
const mocks = {
  react: React,
  "react/jsx-runtime": require("react/jsx-runtime"),
  "@/components/ui/button": { Button: (props) => React.createElement("button", props) },
  "@/components/ui/spinner": { Spinner: stub },
  "@/lib/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
  "lucide-react": { MicIcon: stub, SquareIcon: stub },
}
const path = "components/ai-elements/speech-input.tsx"
const source = ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText
const module = { exports: {} }
vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: path })(
  (name) => {
    if (name in mocks) return mocks[name]
    throw new Error(`Unexpected dependency ${name}`)
  },
  module,
  module.exports
)
const { SpeechInput } = module.exports
const listening = []
const transcribed = []
const props = {
  lang: "en-US",
  onListeningChange: (value) => listening.push(value),
  onTranscriptionChange: (value) => transcribed.push(value),
}

const disabledView = render(React.createElement(SpeechInput, props))
fireEvent.click(disabledView.getByRole("button"))
assert.equal(instances[0].active, true)
disabledView.rerender(React.createElement(SpeechInput, { ...props, disabled: true }))
assert.equal(disabledView.getByRole("button").disabled, true)
assert.equal(instances[0].active, true)
const result = new dom.window.Event("result")
Object.assign(result, {
  resultIndex: 0,
  results: [{ isFinal: true, 0: { transcript: "late dictation" } }],
})
act(() => instances[0].dispatchEvent(result))
assert.deepEqual(transcribed, ["late dictation"])
console.log(
  JSON.stringify({
    probe: "disable-active-dictation",
    buttonDisabled: true,
    recognizerActive: true,
    callbacksAfterDisable: transcribed.length,
  })
)
cleanup()
instances.length = 0
listening.length = 0

const languageView = render(React.createElement(SpeechInput, props))
fireEvent.click(languageView.getByRole("button"))
languageView.rerender(React.createElement(SpeechInput, { ...props, lang: "zh-CN" }))
await act(async () => {
  await Promise.resolve()
})
assert.equal(instances[0].active, false)
assert.equal(instances[1].active, false)
assert.equal(languageView.getByRole("button").getAttribute("data-listening"), "true")
fireEvent.click(languageView.getByRole("button"))
assert.equal(instances[1].starts, 0)
assert.deepEqual(listening, [true])
console.log(
  JSON.stringify({
    probe: "language-change-during-dictation",
    renderedListening: true,
    recognizerActive: false,
    newRecognizerStartsAfterClick: instances[1].starts,
    parentListeningEvents: listening,
  })
)
cleanup()
dom.window.close()
