import type { UIMessage } from "ai"

import {
  applyCodeRunCall,
  codeRunCallsOf,
  parseCodeRunCallEvent,
  preserveCodeRunCalls,
} from "./code-run-calls"

type Part = UIMessage["parts"][number]

/** The event the sidecar emits (`sidecar/src/tools/builtin/run-code/trace.ts`). */
function event(call: Record<string, unknown>, parent = "toolu_run") {
  return { type: "system", subtype: "code_run_call", parent_tool_use_id: parent, call }
}

function runCodePart(extra: Record<string, unknown> = {}): Part {
  return {
    type: "tool-run_code",
    toolCallId: "toolu_run",
    state: "input-available",
    input: { source: "…" },
    ...extra,
  } as unknown as Part
}

function transcript(...parts: Part[]): UIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "find it" }] },
    { id: "a1", role: "assistant", parts },
  ]
}

function callsOn(messages: UIMessage[]) {
  return codeRunCallsOf(messages[1]!.parts[0])
}

describe("parseCodeRunCallEvent", () => {
  it("reads the wire shape into the stored one", () => {
    expect(
      parseCodeRunCallEvent(
        event({
          id: "toolu_run/1",
          ordinal: 1,
          tool: "grep",
          state: "succeeded",
          duration_ms: 12.4,
          result_bytes: 300,
        })
      )
    ).toEqual({
      parentToolCallId: "toolu_run",
      call: {
        id: "toolu_run/1",
        ordinal: 1,
        tool: "grep",
        state: "succeeded",
        durationMs: 12,
        resultBytes: 300,
      },
    })
  })

  it("refuses an event without a parent, or with a malformed call", () => {
    const good = { id: "p/1", ordinal: 1, tool: "read", state: "running" }
    expect(parseCodeRunCallEvent(event(good, ""))).toBeNull()
    expect(parseCodeRunCallEvent(event({ ...good, ordinal: 0 }))).toBeNull()
    expect(parseCodeRunCallEvent(event({ ...good, ordinal: 1.5 }))).toBeNull()
    expect(parseCodeRunCallEvent(event({ ...good, tool: "not a tool" }))).toBeNull()
    expect(parseCodeRunCallEvent(event({ ...good, state: "maybe" }))).toBeNull()
    expect(parseCodeRunCallEvent({ ...event(good), subtype: "hook_fire" })).toBeNull()
  })

  it("keeps a failure kind only on a failed call, and only a well-formed one", () => {
    const failed = parseCodeRunCallEvent(
      event({ id: "p/1", ordinal: 1, tool: "read", state: "failed", failure: "not-found" })
    )
    expect(failed?.call.failure).toBe("not-found")
    const odd = parseCodeRunCallEvent(
      event({ id: "p/1", ordinal: 1, tool: "read", state: "failed", failure: "<b>x</b>" })
    )
    expect(odd?.call.failure).toBeUndefined()
    const succeeded = parseCodeRunCallEvent(
      event({ id: "p/1", ordinal: 1, tool: "read", state: "succeeded", failure: "not-found" })
    )
    expect(succeeded?.call.failure).toBeUndefined()
  })
})

describe("applyCodeRunCall", () => {
  it("lists nested calls on the run_code part in program order", () => {
    let messages = transcript(runCodePart())
    messages = applyCodeRunCall(
      messages,
      event({ id: "toolu_run/2", ordinal: 2, tool: "read", state: "running" })
    )
    messages = applyCodeRunCall(
      messages,
      event({ id: "toolu_run/1", ordinal: 1, tool: "grep", state: "running" })
    )
    messages = applyCodeRunCall(
      messages,
      event({ id: "toolu_run/1", ordinal: 1, tool: "grep", state: "succeeded", duration_ms: 5 })
    )
    expect(callsOn(messages)).toEqual([
      { id: "toolu_run/1", ordinal: 1, tool: "grep", state: "succeeded", durationMs: 5 },
      { id: "toolu_run/2", ordinal: 2, tool: "read", state: "running" },
    ])
  })

  it("never sets an ended call back to running", () => {
    let messages = transcript(runCodePart())
    messages = applyCodeRunCall(
      messages,
      event({ id: "toolu_run/1", ordinal: 1, tool: "grep", state: "failed", failure: "aborted" })
    )
    messages = applyCodeRunCall(
      messages,
      event({ id: "toolu_run/1", ordinal: 1, tool: "grep", state: "running" })
    )
    expect(callsOn(messages)?.[0]?.state).toBe("failed")
  })

  it("changes nothing when the parent call is not in the transcript", () => {
    const messages = transcript(runCodePart())
    const next = applyCodeRunCall(
      messages,
      event({ id: "other/1", ordinal: 1, tool: "grep", state: "running" }, "other")
    )
    expect(next).toBe(messages)
  })

  it("changes nothing for a malformed event", () => {
    const messages = transcript(runCodePart())
    expect(applyCodeRunCall(messages, event({ ordinal: 1 }))).toBe(messages)
  })

  it("leaves other parts and messages untouched", () => {
    const text = { type: "text", text: "hi" } as Part
    const messages = transcript(text, runCodePart())
    const next = applyCodeRunCall(
      messages,
      event({ id: "toolu_run/1", ordinal: 1, tool: "grep", state: "running" })
    )
    expect(next[0]).toBe(messages[0])
    expect(next[1]!.parts[0]).toBe(text)
  })
})

describe("codeRunCallsOf", () => {
  it("is null for a part without nested calls", () => {
    expect(codeRunCallsOf(runCodePart())).toBeNull()
    expect(codeRunCallsOf(runCodePart({ codeRunCalls: [] }))).toBeNull()
  })

  it("drops stored entries that do not validate", () => {
    const part = runCodePart({
      codeRunCalls: [
        { id: "p/2", ordinal: 2, tool: "read", state: "succeeded" },
        { id: "p/1", ordinal: 1, tool: "x y", state: "succeeded" },
        "junk",
      ],
    })
    expect(codeRunCallsOf(part)).toEqual([
      { id: "p/2", ordinal: 2, tool: "read", state: "succeeded" },
    ])
  })
})

describe("preserveCodeRunCalls", () => {
  const listed = runCodePart({
    codeRunCalls: [{ id: "toolu_run/1", ordinal: 1, tool: "grep", state: "running" }],
  })

  // An assistant snapshot is rebuilt from provider blocks, which know nothing
  // of a still-running program's calls.
  it("carries a running program's calls onto the snapshot that replaces its part", () => {
    const previous = transcript(listed)[1]
    const [kept] = preserveCodeRunCalls(previous, [runCodePart()])
    expect(codeRunCallsOf(kept)).toEqual([
      { id: "toolu_run/1", ordinal: 1, tool: "grep", state: "running" },
    ])
  })

  it("merges with calls the new part already carries", () => {
    const previous = transcript(listed)[1]
    const [kept] = preserveCodeRunCalls(previous, [
      runCodePart({
        codeRunCalls: [{ id: "toolu_run/2", ordinal: 2, tool: "read", state: "running" }],
      }),
    ])
    expect(codeRunCallsOf(kept)?.map((call) => call.ordinal)).toEqual([1, 2])
  })

  it("returns the parts unchanged when nothing was listed", () => {
    const parts = [runCodePart()]
    expect(preserveCodeRunCalls(undefined, parts)).toBe(parts)
    expect(preserveCodeRunCalls(transcript(runCodePart())[1], parts)).toBe(parts)
  })
})
