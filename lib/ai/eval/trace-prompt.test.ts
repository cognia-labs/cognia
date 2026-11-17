const listMessages = jest.fn(async () => [
  {
    role: "user",
    parts: [{ type: "text", text: "from the message store" }],
    metadata: { createdAt: 100 },
  },
])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...a: unknown[]) => listMessages(...(a as [])),
}))

import {
  defaultPromptLoader,
  resolveTracePrompt,
  resolveTracePrompts,
  TRACE_PROMPT_CLOCK_SKEW_MS,
  type SessionMessage,
  type SessionMessageLoader,
} from "./trace-prompt"

const userMessage = (text: string, createdAt = 100): SessionMessage => ({
  role: "user",
  parts: [{ type: "text", text }],
  metadata: { createdAt },
})
const assistantMessage = (text: string, createdAt = 100): SessionMessage => ({
  role: "assistant",
  parts: [{ type: "text", text }],
  metadata: { createdAt },
})

function loader(map: Record<string, SessionMessage[]>): SessionMessageLoader {
  return async (sessionId) => map[sessionId] ?? []
}

const trace = (sessionId: string, startTime = 10_000) => ({ sessionId, startTime })

describe("resolveTracePrompt", () => {
  it("returns the prompt of the turn that started the trace, not the session's first", async () => {
    const load = loader({
      s1: [
        userMessage("FIRST successful request", 1_000),
        assistantMessage("done", 2_000),
        userMessage("SECOND failing request", 5_000),
        assistantMessage("error", 6_000),
      ],
    })
    expect(await resolveTracePrompt(trace("s1", 1_200), load)).toBe("FIRST successful request")
    expect(await resolveTracePrompt(trace("s1", 5_300), load)).toBe("SECOND failing request")
  })

  it("ignores a message sent after the trace started (a queued next turn)", async () => {
    const load = loader({
      s1: [userMessage("current turn", 1_000), userMessage("typed while running", 4_000)],
    })
    expect(await resolveTracePrompt(trace("s1", 1_500), load)).toBe("current turn")
  })

  it("tolerates small clock skew between the message and the first span", async () => {
    const load = loader({ s1: [userMessage("just sent", 2_000)] })
    expect(await resolveTracePrompt(trace("s1", 2_000 - TRACE_PROMPT_CLOCK_SKEW_MS), load)).toBe(
      "just sent"
    )
    expect(
      await resolveTracePrompt(trace("s1", 2_000 - TRACE_PROMPT_CLOCK_SKEW_MS - 1), load)
    ).toBeUndefined()
  })

  it("returns nothing when no user message precedes the trace or times are unknown", async () => {
    const undated: SessionMessage = { role: "user", parts: [{ type: "text", text: "no time" }] }
    expect(
      await resolveTracePrompt(trace("s1", 10), loader({ s1: [userMessage("later", 9_000)] }))
    ).toBeUndefined()
    expect(await resolveTracePrompt(trace("s1"), loader({ s1: [undated] }))).toBeUndefined()
    expect(
      await resolveTracePrompt(trace("s1", 0), loader({ s1: [userMessage("x", 1)] }))
    ).toBeUndefined()
  })

  it("joins several text parts of one message", async () => {
    const load = loader({
      s1: [
        {
          role: "user",
          parts: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
          metadata: { createdAt: 100 },
        },
      ],
    })
    expect(await resolveTracePrompt(trace("s1"), load)).toBe("line one\nline two")
  })

  it("skips a user message with no text, falling back to the earlier one of the turn", async () => {
    const load = loader({
      s1: [
        userMessage("the real question", 100),
        { role: "user", parts: [{ type: "file", url: "x" }], metadata: { createdAt: 200 } },
      ],
    })
    expect(await resolveTracePrompt(trace("s1"), load)).toBe("the real question")
  })

  it("returns undefined for a blank id, an empty session, or a load failure", async () => {
    expect(await resolveTracePrompt(trace(""), loader({}))).toBeUndefined()
    expect(await resolveTracePrompt(trace("gone"), loader({}))).toBeUndefined()
    const throwing: SessionMessageLoader = async () => {
      throw new Error("db closed")
    }
    // A cleared session is a fallback to the preview, not a crash.
    expect(await resolveTracePrompt(trace("s1"), throwing)).toBeUndefined()
  })

  it("tolerates a message with no parts array", async () => {
    expect(
      await resolveTracePrompt(
        trace("s1"),
        loader({ s1: [{ role: "user", metadata: { createdAt: 1 } }] })
      )
    ).toBeUndefined()
  })
})

describe("resolveTracePrompts", () => {
  it("keys prompts by trace id", async () => {
    const load = loader({ s1: [userMessage("first")], s2: [userMessage("second")] })
    const out = await resolveTracePrompts(
      [
        { traceId: "t1", sessionId: "s1", startTime: 10_000 },
        { traceId: "t2", sessionId: "s2", startTime: 10_000 },
      ],
      load
    )
    expect(out).toEqual({ t1: "first", t2: "second" })
  })

  it("loads a shared session once and gives each trace its own turn", async () => {
    const load = jest.fn<ReturnType<SessionMessageLoader>, [string]>(async () => [
      userMessage("turn one", 1_000),
      userMessage("turn two", 5_000),
    ])
    const out = await resolveTracePrompts(
      [
        { traceId: "t1", sessionId: "s1", startTime: 1_100 },
        { traceId: "t2", sessionId: "s1", startTime: 5_100 },
      ],
      load
    )
    expect(out).toEqual({ t1: "turn one", t2: "turn two" })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("omits traces with no session, no recoverable prompt, or a failed load", async () => {
    const out = await resolveTracePrompts(
      [
        { traceId: "t1", sessionId: "", startTime: 10_000 },
        { traceId: "t2", sessionId: "gone", startTime: 10_000 },
      ],
      loader({})
    )
    expect(out).toEqual({})
    const throwing: SessionMessageLoader = async () => {
      throw new Error("db closed")
    }
    expect(
      await resolveTracePrompts([{ traceId: "t3", sessionId: "s1", startTime: 1 }], throwing)
    ).toEqual({})
  })
})

describe("defaultPromptLoader", () => {
  it("reads the real message store", async () => {
    expect(await resolveTracePrompt(trace("s1"), defaultPromptLoader())).toBe(
      "from the message store"
    )
    expect(listMessages).toHaveBeenCalledWith("s1")
  })
})
