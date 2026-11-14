import type { UIMessage } from "ai"
import {
  ASIDE_CONTEXT_MAX_MESSAGES,
  ASIDE_TOOL_FACTS_PER_MESSAGE,
  ASIDE_TOOL_RESULT_EXCERPT_CHARS,
  buildAsideContext,
  prepareAsideContext,
  ASIDE_REFERENCE_HEADER,
  ASIDE_DELTA_HEADER,
  ASIDE_PINNED_CONTEXT_MAX_CHARS,
  summarizeAsideInheritance,
} from "./session-aside-context"

function msg(role: "user" | "assistant", text: string): UIMessage {
  return { id: `${role}-${text}`, role, parts: [{ type: "text", text }] } as UIMessage
}

describe("aside inheritance selection", () => {
  const parent = Array.from({ length: 30 }, (_, i) => msg("user", `parent ${i}`))

  it("uses the builder's exact selection and separately budgets pinned messages", () => {
    const pins = [parent[0].id, "deleted"]
    const summary = summarizeAsideInheritance(parent, { pins })
    const delivery = prepareAsideContext(parent, { pins })
    expect(delivery.context).toBe(summary.context)
    expect(summary.included).toEqual([parent[0].id, ...parent.slice(6).map((m) => m.id)])
    expect(summary.omitted).toEqual(parent.slice(1, 6).map((m) => m.id))
    expect(summary.pinnedIncluded).toEqual([parent[0].id])
    expect(summary.validPins).toEqual([parent[0].id])
    expect(delivery.context).toContain("Messages the user pinned from the main conversation")
  })

  it("delivers a newly added pin once on a delta and again on rebuild or edit", () => {
    const snapshot = prepareAsideContext(parent)
    const options = {
      pins: [parent[0].id],
      cursor: { ...snapshot.cursor!, sdkSessionId: "sdk" },
      resumeSdkSessionId: "sdk",
    }
    const delta = prepareAsideContext(parent, options)
    expect(delta.header).toBe(ASIDE_DELTA_HEADER)
    expect(delta.context).toContain("User: parent 0")
    expect(delta.context).not.toContain("User: parent 29")
    const cursor = { ...delta.cursor!, sdkSessionId: "sdk" }
    expect(prepareAsideContext(parent, { ...options, cursor }).context).toBe("")
    expect(
      prepareAsideContext(parent, { ...options, cursor, resumeSdkSessionId: "new" }).context
    ).toContain("User: parent 0")
    const edited = [
      { ...parent[0], parts: [{ type: "text" as const, text: "edited pin" }] },
      ...parent.slice(1),
    ]
    const rebuilt = prepareAsideContext(edited, { ...options, cursor })
    expect(rebuilt.header).toBe(ASIDE_REFERENCE_HEADER)
    expect(rebuilt.context).toContain("edited pin")
  })

  it("drops whole pinned messages within their separate budget and reports clipping", () => {
    const big = msg("user", "x".repeat(ASIDE_PINNED_CONTEXT_MAX_CHARS))
    const summary = summarizeAsideInheritance([big, ...parent], { pins: [big.id, parent[0].id] })
    expect(summary.pinnedIncluded).toEqual([parent[0].id])
    expect(summary.omitted).toContain(big.id)
    expect(summary.context).not.toContain("x".repeat(100))
    const single = summarizeAsideInheritance([big, ...parent], { pins: [big.id] })
    expect(single.truncated).toContain(big.id)
    expect(single.pinnedIncluded).toContain(big.id)
  })

  it("lists attachment identities without copying bytes into context", () => {
    const attachment = {
      id: "file",
      role: "user",
      parts: [
        {
          type: "file",
          filename: "photo.png",
          mediaType: "image/png",
          url: "data:image/png;base64,c2VjcmV0",
        },
      ],
    } as UIMessage
    const summary = summarizeAsideInheritance([attachment])
    expect(summary.attachments).toEqual([
      { messageId: "file", partIndex: 0, filename: "photo.png", mediaType: "image/png" },
    ])
    expect(summary.context).toContain("[attached file: photo.png (image/png)]")
    expect(summary.context).not.toContain("c2VjcmV0")
  })

  it("counts the original once when an extracted document produces multiple file parts", () => {
    const extractedContent = {
      attachmentId: "source",
      contentHash: "a".repeat(64),
      status: "ready",
      processor: { id: "test", version: "1" },
      segments: [{ id: "s", text: "body", locator: { type: "text", start: 0, end: 4 } }],
    }
    const document = {
      id: "document",
      role: "user",
      parts: [0, 1].map(() => ({
        type: "file",
        filename: "report.pdf",
        mediaType: "application/pdf",
        text: "extracted page",
        extractedContent,
      })),
    } as unknown as UIMessage
    expect(summarizeAsideInheritance([document]).attachments).toHaveLength(1)
  })
})

describe("buildAsideContext", () => {
  it("returns nothing for an empty conversation", () => {
    expect(buildAsideContext([])).toBe("")
  })

  it("renders the conversation with speaker labels", () => {
    const out = buildAsideContext([msg("user", "hello"), msg("assistant", "hi")])
    expect(out).toBe("User: hello\n\nAssistant: hi")
  })

  it("keeps only the most recent turns", () => {
    const messages = Array.from({ length: ASIDE_CONTEXT_MAX_MESSAGES + 5 }, (_, i) =>
      msg("user", `m${i}`)
    )
    const out = buildAsideContext(messages)
    // The oldest fall away; the newest — what the user is most likely asking
    // about — always survive.
    expect(out).not.toContain("m0")
    expect(out).toContain(`m${ASIDE_CONTEXT_MAX_MESSAGES + 4}`)
  })

  it("drops whole messages from the oldest end to fit the char budget", () => {
    const out = buildAsideContext([msg("user", "A".repeat(50)), msg("user", "keep me")], {
      maxChars: 40,
    })
    // A half message reads as an interrupted speaker, which the model imitates.
    expect(out).toMatch(/^\[1 .*omitted\]\nUser: keep me$/)
    expect(out.length).toBeLessThanOrEqual(40)
  })

  it("truncates rather than dropping when one message alone exceeds the budget", () => {
    const out = buildAsideContext([msg("user", "B".repeat(100))], { maxChars: 20 })
    expect(out).toHaveLength(20)
    // Keeps the END — the most recent thing said.
    expect(out).toBe(`User: …${"B".repeat(13)}`)
  })

  it("skips messages with no quotable text", () => {
    const toolOnly = { id: "t", role: "assistant", parts: [] } as unknown as UIMessage
    expect(buildAsideContext([toolOnly, msg("user", "only me")])).toBe("User: only me")
  })

  it("returns nothing when the caller allows no budget", () => {
    expect(buildAsideContext([msg("user", "x")], { maxMessages: 0 })).toBe("")
    expect(buildAsideContext([msg("user", "x")], { maxChars: 0 })).toBe("")
  })

  it("tells the aside what the main thread learned from its tools", () => {
    const toolTurn = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-Read",
          toolCallId: "c1",
          state: "output-available",
          input: { file_path: "/repo/src/config.ts" },
          output: "export const PORT = 4173",
        },
        {
          type: "tool-Bash",
          toolCallId: "c2",
          state: "output-error",
          input: { command: "pnpm test" },
          errorText: "3 tests failed\nat foo.test.ts",
        },
        {
          type: "tool-Edit",
          toolCallId: "c3",
          state: "output-available",
          input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b\nc" },
          output: "ok",
        },
      ],
    } as unknown as UIMessage
    const out = buildAsideContext([msg("user", "why is the port wrong?"), toolTurn])
    expect(out).toContain("[tool Read config.ts → export const PORT = 4173]")
    expect(out).toContain("[tool Bash pnpm test failed: 3 tests failed]")
    expect(out).toMatch(/\[tool Edit a\.ts: \+\d+ −\d+ lines\]/)
  })

  it("does not let tool-only rows use up the window without contributing", () => {
    const empty = (i: number) =>
      ({ id: `e${i}`, role: "assistant", parts: [] }) as unknown as UIMessage
    const messages = [
      msg("user", "the question"),
      ...Array.from({ length: ASIDE_CONTEXT_MAX_MESSAGES + 4 }, (_, i) => empty(i)),
    ]
    expect(buildAsideContext(messages)).toBe("User: the question")
  })

  it("quotes a bounded excerpt of a large tool result and the tail of a long burst", () => {
    const big = "x".repeat(ASIDE_TOOL_RESULT_EXCERPT_CHARS * 3)
    const burst = {
      id: "a2",
      role: "assistant",
      parts: Array.from({ length: ASIDE_TOOL_FACTS_PER_MESSAGE + 3 }, (_, i) => ({
        type: "tool-Grep",
        toolCallId: `g${i}`,
        state: "output-available",
        input: { pattern: `p${i}` },
        output: i === ASIDE_TOOL_FACTS_PER_MESSAGE + 2 ? big : "hit",
      })),
    } as unknown as UIMessage
    const out = buildAsideContext([burst])
    expect(out).toContain("[3 earlier tool calls omitted]")
    expect(out).not.toContain("Grep p0 ")
    expect(out).toContain(`Grep p${ASIDE_TOOL_FACTS_PER_MESSAGE + 2}`)
    expect(out).toContain("…]")
    expect(out.length).toBeLessThan(big.length)
  })
})

it("keeps parent formatting and marks attachments without copying their bytes or URLs", () => {
  const message = {
    id: "structured",
    role: "user",
    parts: [
      { type: "text", text: "root:\r\n  child: true\n\n```ts\n  run()\n```" },
      { type: "reasoning", text: "do not include" },
      { type: "file", filename: "photo.jpg", mediaType: "image/jpeg", url: "data:secret" },
    ],
  } as unknown as UIMessage
  expect(buildAsideContext([message])).toBe(
    "User: root:\n  child: true\n\n```ts\n  run()\n```\n[attached file: photo.jpg (image/jpeg)]"
  )
})

it("marks dropped rows once and does not repeat the snapshot's omissions on a delta", () => {
  const parent = Array.from({ length: 30 }, (_, i) => msg("user", `row ${i}`))
  const full = prepareAsideContext(parent)
  expect(full.context).toMatch(/^\[6 earlier messages not included\]\nUser: row 6/)
  expect(full.cursor?.parentMessageId).toBe(parent.at(-1)!.id)
  const next = msg("assistant", "new answer")
  const delta = prepareAsideContext([...parent, next], {
    cursor: { ...full.cursor!, sdkSessionId: "sdk" },
    resumeSdkSessionId: "sdk",
  })
  expect(delta.context).toBe("Assistant: new answer")
  expect(delta.header).toBe(ASIDE_DELTA_HEADER)
  expect(delta.cursor?.parentMessageId).toBe(next.id)
})

it("keeps labels and advances the cursor for a clipped completed message", () => {
  const oversized = msg("assistant", "x".repeat(9000))
  const full = prepareAsideContext([oversized])
  expect(full.context).toHaveLength(8000)
  expect(full.context).toMatch(/^Assistant: …x/)
  expect(full.cursor?.parentMessageId).toBe(oversized.id)
  const cursor = { ...full.cursor!, sdkSessionId: "sdk" }
  expect(prepareAsideContext([oversized], { cursor, resumeSdkSessionId: "sdk" }).context).toBe("")
})

it("counts only omitted new rows in an oversized delta", () => {
  const parent = [msg("user", "old context")]
  const full = prepareAsideContext(parent)
  const newRows = Array.from({ length: 26 }, (_, i) => msg("user", `new ${i}`))
  const delta = prepareAsideContext([...parent, ...newRows], {
    cursor: { ...full.cursor!, sdkSessionId: "sdk" },
    resumeSdkSessionId: "sdk",
  })
  expect(delta.context).toMatch(/^\[2 earlier messages not included\]/)
  expect(delta.context.match(/earlier messages not included/g)).toHaveLength(1)
  expect(delta.cursor?.parentMessageId).toBe(newRows.at(-1)!.id)
})

describe("incremental aside delivery", () => {
  const parent = [msg("user", "question"), msg("assistant", "answer")]
  const full = prepareAsideContext(parent)
  const cursor = { ...full.cursor!, sdkSessionId: "sdk" }
  it("sends a full reference snapshot initially and nothing on an unchanged resume", () => {
    expect(full.header).toBe(ASIDE_REFERENCE_HEADER)
    expect(full.context).toContain("User: question")
    expect(prepareAsideContext(parent, { cursor, resumeSdkSessionId: "sdk" })).toEqual({
      header: ASIDE_DELTA_HEADER,
      context: "",
    })
  })
  it("sends only new messages on the same provider history", () => {
    const delivery = prepareAsideContext([...parent, msg("user", "next")], {
      cursor,
      resumeSdkSessionId: "sdk",
    })
    expect(delivery.context).toBe("User: next")
    expect(delivery.header).toBe(ASIDE_DELTA_HEADER)
    expect(delivery.cursor?.parentMessageId).toBe("user-next")
  })
  it.each([undefined, "another-sdk"])(
    "resends the snapshot on changed or cleared SDK identity: %s",
    (resumeSdkSessionId) => {
      expect(prepareAsideContext(parent, { cursor, resumeSdkSessionId }).context).toBe(full.context)
    }
  )
  it("resends after edits, branch removal, truncation, or parent clearing", () => {
    const edited = [{ ...parent[0], parts: [{ type: "text" as const, text: "edited" }] }, parent[1]]
    for (const messages of [edited, parent.slice(0, 1), []]) {
      const delivery = prepareAsideContext(messages, { cursor, resumeSdkSessionId: "sdk" })
      expect(delivery.header).toBe(ASIDE_REFERENCE_HEADER)
      expect(delivery.context).not.toBe("")
    }
  })
  it("marks streamed content without acknowledging it, then delivers its final form", () => {
    const stream = prepareAsideContext(parent, { inProgressMessageId: parent[1].id })
    expect(stream.context).toContain("still in progress")
    expect(stream.cursor?.parentMessageId).toBe(parent[0].id)
    const final = prepareAsideContext(parent, {
      cursor: { ...stream.cursor!, sdkSessionId: "sdk" },
      resumeSdkSessionId: "sdk",
    })
    expect(final.context).toBe("Assistant: answer")
  })
  it("never acknowledges completed messages displaced by an oversized streaming tail", () => {
    const long = msg("assistant", "x".repeat(9000))
    const delivery = prepareAsideContext([parent[0], long], { inProgressMessageId: long.id })
    expect(delivery.cursor).toBeUndefined()
  })
  it("keeps rebuilding-lane snapshots complete regardless of a stored cursor", () => {
    expect(prepareAsideContext(parent, { cursor }).context).toBe(full.context)
    expect(prepareAsideContext(parent, { cursor }).context).toBe(full.context)
  })
})

it("acknowledges an empty parent once, then sends only subsequent messages", () => {
  const initial = prepareAsideContext([msg("user", "old")])
  const cleared = prepareAsideContext([], {
    cursor: { ...initial.cursor!, sdkSessionId: "sdk" },
    resumeSdkSessionId: "sdk",
  })
  expect(cleared.context).toContain("no visible messages")
  expect(cleared.cursor?.parentMessageId).toBeNull()
  const cursor = { ...cleared.cursor!, sdkSessionId: "sdk" }
  expect(prepareAsideContext([], { cursor, resumeSdkSessionId: "sdk" }).context).toBe("")
  expect(
    prepareAsideContext([msg("user", "new")], { cursor, resumeSdkSessionId: "sdk" }).context
  ).toBe("User: new")
})

it("sends a full empty-parent snapshot after clearing retires the cursor and resume id", () => {
  const cleared = prepareAsideContext([], { parentClearedAt: 100 })
  expect(cleared).toEqual({
    header: ASIDE_REFERENCE_HEADER,
    context: "[The main conversation currently has no visible messages.]",
    cursor: expect.objectContaining({ parentMessageId: null }),
  })
  expect(
    prepareAsideContext([], {
      parentClearedAt: 100,
      cursor: { ...cleared.cursor!, sdkSessionId: "fresh-sdk" },
      resumeSdkSessionId: "fresh-sdk",
    }).context
  ).toBe("")
})

it("does not advance past a streaming assistant when a parent steer follows it", () => {
  const question = msg("user", "question")
  const streaming = msg("assistant", "partial")
  const steer = msg("user", "also check this")
  const delivery = prepareAsideContext([question, streaming, steer], {
    inProgressMessageId: streaming.id,
  })
  expect(delivery.cursor?.parentMessageId).toBe(question.id)
  expect(delivery.context).toContain("still in progress")
  const final = prepareAsideContext(
    [question, { ...streaming, parts: [{ type: "text", text: "final answer" }] }, steer],
    {
      cursor: { ...delivery.cursor!, sdkSessionId: "sdk" },
      resumeSdkSessionId: "sdk",
    }
  )
  expect(final.context).toContain("final answer")
  expect(final.cursor?.parentMessageId).toBe(steer.id)
})
