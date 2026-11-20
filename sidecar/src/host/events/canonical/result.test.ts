import test from "node:test"
import assert from "node:assert/strict"
import { fromResult, terminalEventsFromSessionEnded } from "./result.ts"
import { createSdkMappingState } from "./index.ts"

const ended = (fields: Record<string, unknown>, expectStructuredOutput = false) =>
  terminalEventsFromSessionEnded(
    { type: "session_ended", sessionId: "s1", ...fields },
    createSdkMappingState({ expectStructuredOutput })
  )

test("result timing is portable and preserves zero queue waits", () => {
  const events = ended({
    result: {
      subtype: "success",
      first_text_post_ms: 12,
      first_text_post_queue_wait_ms: 0,
      first_text_post_queued_behind: "retry_backoff",
      first_stream_post_ms: 8,
    },
  })
  assert.deepEqual(events, [
    {
      kind: "lifecycle",
      phase: "ended",
      timing: {
        firstTextMs: 12,
        firstTextQueueWaitMs: 0,
        firstTextQueueReason: "retry-backoff",
        firstStreamMs: 8,
      },
    },
  ])
})

test("a result frame alone settles nothing", () => {
  assert.deepEqual(fromResult({ type: "result", subtype: "success" }, createSdkMappingState()), [])
})

test("missing requested structured output settles as a retryable failure", () => {
  assert.deepEqual(ended({ result: { type: "result", subtype: "success" } }, true), [
    {
      kind: "failure",
      code: "structured_output_missing",
      message: "the turn completed but returned no structured_output for the requested json_schema",
      retryable: true,
    },
  ])
})

test("a turn ceiling is a non-retryable failure coded by its subtype", () => {
  assert.deepEqual(
    ended({ result: { type: "result", subtype: "error_max_turns", is_error: true } }),
    [{ kind: "failure", code: "error_max_turns", message: "error_max_turns" }]
  )
})

test("a reply cut at the token limit or refused is not a clean end", () => {
  for (const [stop, code] of [
    ["max_tokens", "max_tokens"],
    ["refusal", "refusal"],
  ]) {
    const [event] = ended({
      result: { type: "result", subtype: "success", is_error: false, stop_reason: stop },
    })
    assert.equal(event!.kind, "failure")
    assert.equal(event!.code, code)
  }
})

test("an upstream 404 riding on subtype:success is coded api_error with the status", () => {
  const [event] = ended({
    result: {
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 404,
      result: "There's an issue with the selected model (claude-sonnet-4-5).",
    },
  })
  assert.equal(event!.kind, "failure")
  assert.equal(event!.code, "api_error")
  assert.match(String(event!.message), /^HTTP 404: /)
})

test("an error end keeps the turn's code, else the result's, else session_error", () => {
  assert.deepEqual(
    ended({
      error: "HTTP 404: model not found",
      result: { type: "result", subtype: "success", is_error: true, api_error_status: 404 },
    }),
    [{ kind: "failure", code: "error", message: "HTTP 404: model not found" }]
  )
  assert.deepEqual(
    ended({
      error: "stream reset",
      result: { type: "result", subtype: "error_during_execution", is_error: true },
    }),
    [{ kind: "failure", code: "error_during_execution", message: "stream reset", retryable: true }]
  )
  assert.deepEqual(ended({ error: "boom", code: "member_usage_cap_reached" }), [
    { kind: "failure", code: "member_usage_cap_reached", message: "boom" },
  ])
  assert.deepEqual(
    ended({ error: "boom", result: { type: "result", subtype: "success", is_error: false } }),
    [{ kind: "failure", code: "session_error", message: "boom" }]
  )
})

test("a stopped turn is interrupted, not ended", () => {
  assert.deepEqual(
    ended({
      interrupted: true,
      result: {
        type: "result",
        subtype: "success",
        is_error: false,
        terminal_reason: "aborted_streaming",
      },
    }),
    [{ kind: "lifecycle", phase: "interrupted" }]
  )
})

test("a bare end with no result stays a clean end", () => {
  assert.deepEqual(ended({}), [{ kind: "lifecycle", phase: "ended" }])
})
