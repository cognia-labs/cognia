import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CODE_RUN_CALL_SUBTYPE,
  codeRunCallFrame,
  nestedToolCallId,
  traceableToolName,
} from "./trace.ts"

test("a nested call's id is its parent's id and its place in the program", () => {
  assert.equal(nestedToolCallId("toolu_1", 3), "toolu_1/3")
})

test("the frame is a system event in the session's stream, carrying safe facts only", () => {
  assert.deepEqual(
    codeRunCallFrame("s-1", {
      parentToolCallId: "toolu_1",
      call: {
        ordinal: 1,
        tool: "read",
        state: "failed",
        failure: "not-found",
        durationMs: 12,
      },
    }),
    {
      type: "event",
      sessionId: "s-1",
      event: {
        type: "system",
        subtype: CODE_RUN_CALL_SUBTYPE,
        parent_tool_use_id: "toolu_1",
        call: {
          id: "toolu_1/1",
          ordinal: 1,
          tool: "read",
          state: "failed",
          failure: "not-found",
          duration_ms: 12,
        },
      },
    }
  )
})

test("a running call carries no end facts", () => {
  const frame = codeRunCallFrame(undefined, {
    parentToolCallId: "p",
    call: { ordinal: 1, tool: "glob", state: "running" },
  })
  assert.deepEqual(frame.event.call, { id: "p/1", ordinal: 1, tool: "glob", state: "running" })
})

test("a name the program made up is not echoed into the trace", () => {
  assert.equal(traceableToolName("content_search"), "content_search")
  assert.equal(traceableToolName("x".repeat(65)), "unknown")
  assert.equal(traceableToolName("a b"), "unknown")
  assert.equal(traceableToolName(42), "unknown")
})
