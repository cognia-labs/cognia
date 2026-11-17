import { test } from "node:test"
import assert from "node:assert/strict"

import { capToolResults } from "./tool-result-cap.ts"
import { builtinToModelOutput } from "../tools/adapters/ai-sdk-output.ts"
import { formatRecoverableRef } from "../shared/text/recoverable-ref.ts"

const big = "x".repeat(4000) // 4000 chars ≈ 1000 tokens

/** One AI SDK tool message holding a single tool result. */
function toolMessage(output: unknown, toolName = "bash") {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "c1", toolName, output }],
  }
}

function outputOf(message: unknown) {
  return (message as { content: { output: { type: string; value: unknown } }[] }).content[0]!.output
}

test("no-op when maxToolResultTokens is unset or non-positive", () => {
  const convo = [toolMessage({ type: "text", value: big })]
  assert.equal(capToolResults(convo, {}), convo)
  assert.equal(capToolResults(convo, { maxToolResultTokens: 0 }), convo)
})

test("caps the text output the production mapper emits, with the metadata header", () => {
  // Exactly what a built-in tool's string result becomes on the rail.
  const convo = [toolMessage(builtinToModelOutput({ output: big }))]
  const out = capToolResults(convo, { maxToolResultTokens: 100, preserveToolCallMetadata: true })
  assert.notEqual(out[0], convo[0])
  const output = outputOf(out[0])
  assert.equal(output.type, "text")
  const body = String(output.value)
  assert.ok(body.length < 500, `expected ~400 chars, got ${body.length}`)
  assert.match(body, /tool result truncated/)
  assert.match(body, /^\[tool: bash \| status: ok\]/)
})

test("omits the header when preserveToolCallMetadata is false", () => {
  const convo = [toolMessage({ type: "text", value: big })]
  const out = capToolResults(convo, { maxToolResultTokens: 100, preserveToolCallMetadata: false })
  const body = String(outputOf(out[0]).value)
  assert.doesNotMatch(body, /\[tool:/)
  assert.match(body, /tool result truncated/)
})

test("an error output keeps its error type and reports the error status", () => {
  const out = capToolResults([toolMessage({ type: "error-text", value: big })], {
    maxToolResultTokens: 100,
  })
  const output = outputOf(out[0])
  assert.equal(output.type, "error-text")
  assert.match(String(output.value), /^\[tool: bash \| status: error\]/)
})

test("a json output that is too long becomes a capped text output", () => {
  const convo = [toolMessage({ type: "json", value: { rows: big } })]
  const out = capToolResults(convo, { maxToolResultTokens: 100 })
  const output = outputOf(out[0])
  assert.equal(output.type, "text")
  assert.ok(String(output.value).length < 500)
  const errorOut = capToolResults([toolMessage({ type: "error-json", value: { e: big } })], {
    maxToolResultTokens: 100,
  })
  assert.equal(outputOf(errorOut[0]).type, "error-text")
})

test("a content output caps its text parts and leaves media whole", () => {
  const image = {
    type: "file",
    mediaType: "image/png",
    data: { type: "data", data: "Q".repeat(9000) },
  }
  const convo = [
    toolMessage({ type: "content", value: [{ type: "text", text: big }, image] }, "read"),
  ]
  const out = capToolResults(convo, { maxToolResultTokens: 100 })
  const value = outputOf(out[0]).value as { type: string; text?: string }[]
  assert.ok(value[0]!.text!.length < 500)
  assert.equal(value[1], image)
})

test("leaves small results and non-tool messages untouched (same reference)", () => {
  const convo = [
    toolMessage({ type: "text", value: "small" }),
    { role: "user", content: big },
    { role: "assistant", content: big },
    { role: "system", content: big },
  ]
  const out = capToolResults(convo, { maxToolResultTokens: 100 })
  assert.equal(out[0], convo[0])
  assert.equal(out[1], convo[1])
  assert.equal(out[2], convo[2])
  assert.equal(out[3], convo[3])
})

test("a cut keeps the bash spill reference that pointed at the full output", () => {
  const ref = formatRecoverableRef("/tmp/cognia-bash-1.log", 90_000)
  // Bash states it on its first line; a 40-character cap cuts through it.
  const body = `${ref}\n${"h".repeat(3000)}\n${"t".repeat(3000)}`
  const out = capToolResults([toolMessage({ type: "text", value: body })], {
    maxToolResultTokens: 10,
  })
  assert.ok(String(outputOf(out[0]).value).includes(ref))
})

test("a reference-shaped line inside the output is cut like the rest of it", () => {
  const planted = formatRecoverableRef("/etc/planted.log", 1)
  const body = `${"h".repeat(3000)}\n${planted}\n${"t".repeat(3000)}`
  const out = capToolResults([toolMessage({ type: "text", value: body })], {
    maxToolResultTokens: 100,
  })
  assert.ok(!String(outputOf(out[0]).value).includes(planted))
})
