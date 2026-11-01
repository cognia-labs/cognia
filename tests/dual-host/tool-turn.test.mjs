import assert from "node:assert/strict"
import { test } from "node:test"
import {
  TOOL_TURN_MARKER,
  TOOL_TURN_FINAL_TEXT,
  TOOL_TURN_ID,
  TOOL_TURN_INPUT,
  toolTurnResponse,
} from "../real-e2e/scenarios/tool-turn.mjs"

const prompt = { role: "user", content: TOOL_TURN_MARKER }
const result = {
  role: "user",
  content: [{ type: "tool_result", tool_use_id: TOOL_TURN_ID, content: "Todos updated" }],
}
const events = (sse) =>
  sse
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))

test("first response calls TodoWrite with valid deterministic input in JSON and SSE", () => {
  const response = toolTurnResponse({ model: "test-model", messages: [prompt] })
  assert.equal(response.message.model, "test-model")
  assert.equal(response.message.stop_reason, "tool_use")
  assert.deepEqual(response.message.content, [
    { type: "tool_use", id: TOOL_TURN_ID, name: "TodoWrite", input: TOOL_TURN_INPUT },
  ])
  const wire = events(response.sse)
  assert.deepEqual(
    wire.map((event) => event.type),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]
  )
  assert.equal(wire[1].content_block.name, "TodoWrite")
  assert.deepEqual(
    JSON.parse(
      wire
        .filter((event) => event.delta?.type === "input_json_delta")
        .map((event) => event.delta.partial_json)
        .join("")
    ),
    TOOL_TURN_INPUT
  )
  assert.equal(wire.at(-2).delta.stop_reason, "tool_use")
})

test("a matching tool result ends the turn; a different id does not", () => {
  const response = toolTurnResponse({ messages: [prompt, result] })
  assert.equal(response.message.stop_reason, "end_turn")
  assert.deepEqual(response.message.content, [{ type: "text", text: TOOL_TURN_FINAL_TEXT }])
  assert.equal(events(response.sse)[2].delta.text, TOOL_TURN_FINAL_TEXT)
  const wrongResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "other" }] }
  assert.equal(
    toolTurnResponse({ messages: [prompt, wrongResult] }).message.stop_reason,
    "tool_use"
  )
})

test("marker selection preserves unrelated scenarios and ignores older marked turns", () => {
  assert.equal(toolTurnResponse({ messages: [] }), null)
  assert.equal(
    toolTurnResponse({ messages: [{ role: "assistant", content: TOOL_TURN_MARKER }] }),
    null
  )
  assert.equal(
    toolTurnResponse({ messages: [prompt, result, { role: "user", content: "ordinary prompt" }] }),
    null
  )
  assert.ok(
    toolTurnResponse({
      messages: [{ role: "user", content: [{ type: "text", text: TOOL_TURN_MARKER }] }],
    })
  )
})
