import type { AgentEventEnvelope } from "../../shared/wire/outbound.ts"
type FixtureFrame =
  | { type: "agent_event"; envelope: AgentEventEnvelope }
  | {
      type: "event" | "session_ended" | "log" | "plugin_tool_exec" | "permission_request"
      [key: string]: unknown
    }
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import {
  canonicalEventFromWireMessage,
  canonicalEventsFromWireMessage,
  createEnvelopeEmitter,
} from "./envelope.ts"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(join(here, "../../../test-support/fixtures/agent-event-envelope.json"), "utf8")
)

test("canonical permission requests preserve SDK approval hints", () => {
  for (const value of [true, false]) {
    assert.deepEqual(
      canonicalEventFromWireMessage({
        type: "permission_request",
        requestId: "approval-1",
        toolName: "Edit",
        input: {},
        defaultToNo: value,
        suppressAlwaysAllowRule: value,
      }),
      {
        kind: "permission-request",
        requestId: "approval-1",
        toolName: "Edit",
        input: {},
        defaultToNo: value,
        suppressAlwaysAllowRule: value,
      }
    )
  }
})

function collectEmitter(extra = {}) {
  const out: FixtureFrame[] = []
  const emitter = createEnvelopeEmitter({
    sessionId: fixture.context.sessionId,
    runId: fixture.context.runId,
    attemptId: fixture.context.attemptId,
    hostRef: fixture.context.hostRef,
    runtime: fixture.context.runtime,
    turnRef: { id: fixture.context.turnId },
    emit: (msg) => out.push(msg as FixtureFrame),
    ...extra,
  })
  return { out, emitter }
}

test("fixture parity: wire messages produce the pinned envelopes (TS mirrors this)", () => {
  const { out, emitter } = collectEmitter()
  for (const c of fixture.cases) emitter(c.wire)

  const envelopes = out.filter((m) => m.type === "agent_event").map((m) => m.envelope)
  assert.equal(envelopes.length, fixture.cases.length)
  for (let i = 0; i < fixture.cases.length; i += 1) {
    const { timestamp, ...rest } = envelopes[i]!
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(rest, fixture.cases[i].envelope)
  }
})

test("raw legacy messages keep flowing unchanged, in order, before their envelope", () => {
  const { out, emitter } = collectEmitter()
  emitter(fixture.cases[0].wire)
  assert.deepEqual(out[0], fixture.cases[0].wire)
  assert.equal(out[1]!.type, "agent_event")
})

test("sequence is monotonic per emitter and ids embed session+turn+attempt", () => {
  const { out, emitter } = collectEmitter()
  for (const c of fixture.cases) emitter(c.wire)
  const seqs = out.filter((m) => m.type === "agent_event").map((m) => m.envelope.sequence)
  assert.deepEqual(seqs, [0, 1, 2])
  for (const m of out.filter((m) => m.type === "agent_event")) {
    assert.equal(m.envelope.eventId, `s1:t1:a1:${m.envelope.sequence}`)
  }
})

test("messages without a canonical projection are not enveloped", () => {
  const { out, emitter } = collectEmitter()
  emitter({ type: "plugin_tool_exec", sessionId: "s1", toolUseId: "t", name: "x", args: {} })
  emitter({ type: "log", level: "info", message: "hi" })
  assert.equal(out.filter((m) => m.type === "agent_event").length, 0)
  assert.equal(out.length, 2)
})

test("canonicalEventFromWireMessage maps the remaining kinds", () => {
  assert.deepEqual(canonicalEventFromWireMessage({ type: "session_ended", sessionId: "s1" }), {
    kind: "lifecycle",
    phase: "ended",
  })
  assert.deepEqual(
    canonicalEventFromWireMessage({
      type: "capability_error",
      sessionId: "s1",
      capability: "steer",
      command: "steer",
    }),
    { kind: "capability-error", capability: "steer", command: "steer" }
  )
  assert.equal(canonicalEventFromWireMessage(null), null)
  assert.equal(canonicalEventFromWireMessage({ type: "ready" }), null)
  const interrupted = canonicalEventFromWireMessage({
    type: "permission_interrupted",
    sessionId: "s1",
    requestId: "r",
    reason: "closed",
  })
  assert.deepEqual(interrupted, {
    kind: "warning",
    code: "permission_interrupted",
    message: "closed",
  })
})

test("a runtime warning becomes a canonical warning hosts can show", () => {
  assert.deepEqual(
    canonicalEventFromWireMessage({
      type: "runtime_warning",
      sessionId: "s1",
      code: "tool_surface_capped",
      message: "openai/gpt-x accepts at most 128 tool definitions per request",
    }),
    {
      kind: "warning",
      code: "tool_surface_capped",
      message: "openai/gpt-x accepts at most 128 tool definitions per request",
    }
  )
  assert.deepEqual(canonicalEventFromWireMessage({ type: "runtime_warning", sessionId: "s1" }), {
    kind: "warning",
    code: "runtime_warning",
    message: "",
  })
})

test("a raw SDK message is projected semantically, not swallowed as a diagnostic", () => {
  // Before the exhaustive mapping every `type: "event"` except compact_boundary
  // became `{ kind: "diagnostic" }`, which is how 30 of the 39 union members
  // reached consumers as opaque blobs.
  const events = canonicalEventsFromWireMessage({
    type: "event",
    sessionId: "s1",
    event: {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    },
  })
  assert.deepEqual(events, [
    { kind: "tool-call", toolName: "Bash", input: { command: "ls" }, toolCallId: "t1" },
  ])
})

test("one SDK message can produce several envelopes, each with its own sequence", () => {
  const { out, emitter } = collectEmitter()
  emitter({
    type: "event",
    sessionId: "s1",
    event: {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    },
  })

  const envelopes = out.filter((m) => m.type === "agent_event").map((m) => m.envelope)
  assert.deepEqual(
    envelopes.map((e) => e.event.kind),
    ["text-delta", "tool-call"]
  )
  assert.deepEqual(
    envelopes.map((e) => e.sequence),
    [0, 1]
  )
})

test("the partial-stream latch is per emitter, so attempts do not leak into each other", () => {
  const assistant = {
    type: "event",
    sessionId: "s1",
    event: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
  }
  const streamed = {
    type: "event",
    sessionId: "s1",
    event: {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "h" } },
    },
  }

  const first = collectEmitter()
  first.emitter(streamed)
  first.emitter(assistant)
  assert.deepEqual(
    first.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["text-delta"],
    "the assistant echo must not duplicate the streamed text"
  )

  // A fresh emitter (a new attempt) starts unlatched.
  const second = collectEmitter()
  second.emitter(assistant)
  assert.deepEqual(
    second.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["text-delta"]
  )
})

test("the structured-output expectation reaches the mapper, per emitter", () => {
  const result = { type: "result", subtype: "success", is_error: false, result: "prose" }
  const frames = [
    { type: "event", sessionId: "s1", event: result },
    { type: "session_ended", sessionId: "s1", result },
  ]

  const expecting = collectEmitter({ expectStructuredOutput: true })
  for (const frame of frames) expecting.emitter(frame)
  assert.deepEqual(
    expecting.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["structured-output", "failure"],
    "a schema was requested and none came back"
  )

  // The default must stay OFF: a session that never asked for a schema would
  // otherwise have every successful turn rewritten into a failure.
  const plain = collectEmitter()
  for (const frame of frames) plain.emitter(frame)
  assert.deepEqual(
    plain.out.filter((m) => m.type === "agent_event").map((m) => m.envelope.event.kind),
    ["lifecycle"]
  )
})

test("a turn publishes exactly one terminal event, from its end", () => {
  // The Claude rail emits the `result` frame, then a `session_ended` carrying
  // it; the AI SDK rail does the same. Settling on both put a `failure` and an
  // `ended` (or an early `ended` and a late `failure`) on one turn.
  const terminal = (frames: Record<string, unknown>[]) => {
    const { out, emitter } = collectEmitter()
    for (const frame of frames) emitter(frame as Parameters<typeof emitter>[0])
    return out
      .filter((m) => m.type === "agent_event")
      .map((m) => m.envelope.event)
      .filter((e) => e.kind === "failure" || e.kind === "lifecycle")
      .map((e) => (e.kind === "failure" ? `failure:${e.code}` : `lifecycle:${e.phase}`))
  }
  const failed404 = {
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 404,
  }
  assert.deepEqual(
    terminal([
      { type: "event", sessionId: "s1", event: failed404 },
      { type: "session_ended", sessionId: "s1", error: "HTTP 404", result: failed404 },
    ]),
    ["failure:api_error"]
  )
  const capped = { type: "result", subtype: "error_max_turns", is_error: true }
  assert.deepEqual(
    terminal([
      { type: "event", sessionId: "s1", event: capped },
      { type: "session_ended", sessionId: "s1", result: capped },
    ]),
    ["failure:error_max_turns"]
  )
  // A steer's first answer is not the end of the turn.
  const answered = { type: "result", subtype: "success", is_error: false }
  assert.deepEqual(
    terminal([
      { type: "event", sessionId: "s1", event: answered },
      { type: "event", sessionId: "s1", event: { ...failed404 } },
      { type: "session_ended", sessionId: "s1", error: "HTTP 404", result: failed404 },
    ]),
    ["failure:api_error"]
  )
})

test("a session_ended with no result still synthesizes the failure", () => {
  // Thrown stream faults, interrupts and the pre-dispatch guards all emit a
  // bare `session_ended` — nothing else reports those.
  assert.deepEqual(
    canonicalEventsFromWireMessage({ type: "session_ended", sessionId: "s1", error: "boom" }),
    [{ kind: "failure", code: "session_error", message: "boom" }]
  )
})

test("a session_ended keeps the turn's own code, and only a code", () => {
  assert.deepEqual(
    canonicalEventsFromWireMessage({
      type: "session_ended",
      sessionId: "s1",
      error: "member_usage_cap_reached",
      code: "member_usage_cap_reached",
      httpStatus: 429,
    }),
    [{ kind: "failure", code: "member_usage_cap_reached", message: "member_usage_cap_reached" }]
  )
  assert.deepEqual(
    canonicalEventsFromWireMessage({
      type: "session_ended",
      sessionId: "s1",
      error: "boom",
      code: "free text with spaces",
    }),
    [{ kind: "failure", code: "session_error", message: "boom" }]
  )
})

test("a session_ended carrying a SUCCESSFUL result ends the turn cleanly", () => {
  assert.deepEqual(
    canonicalEventsFromWireMessage({
      type: "session_ended",
      sessionId: "s1",
      result: { type: "result", subtype: "success", is_error: false },
    }),
    [{ kind: "lifecycle", phase: "ended" }]
  )
})
