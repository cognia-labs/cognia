import {
  MAX_TRANSCRIPT_MESSAGES,
  formatTranscript,
  getSessionTranscriptText,
} from "./entity-transcript"

jest.mock("@/lib/execution/personal-visibility", () => {
  const { withholdForReaders } = jest.requireActual<
    typeof import("@cognia/plugin-contract/types/execution/personal-visibility")
  >("@cognia/plugin-contract/types/execution/personal-visibility")
  return {
    preparePersonalHistory: async <T extends { id: string; metadata?: unknown }>(
      _sessionId: string | undefined,
      messages: readonly T[]
    ) => ({ ...withholdForReaders(messages, []), readers: [] }),
  }
})

const listRecentMessagesMock = jest.fn()
jest.mock("@/lib/db/messages", () => ({
  listRecentMessages: (...args: unknown[]) => listRecentMessagesMock(...args),
}))

type Parts = Parameters<typeof formatTranscript>[0][number]["parts"]

function text(value: string): Parts {
  return [{ type: "text", text: value }] as unknown as Parts
}

describe("formatTranscript", () => {
  it("labels each turn with its role", () => {
    const out = formatTranscript([
      { role: "user", parts: text("how do I restack?") },
      { role: "assistant", parts: text("run /stack restack") },
    ])
    expect(out).toBe("user: how do I restack?\n\nassistant: run /stack restack")
  })

  it("skips turns that project to nothing rather than emitting a blank role", () => {
    const out = formatTranscript([
      { role: "user", parts: text("look at this") },
      { role: "assistant", parts: [] as unknown as Parts },
    ])
    expect(out).toBe("user: look at this")
  })

  it("returns null when nothing in the conversation is readable", () => {
    // A transcript of nothing but images or bare tool results. Staging an empty
    // chip that claims to carry a conversation is the failure this prevents.
    expect(formatTranscript([{ role: "assistant", parts: [] as unknown as Parts }])).toBeNull()
    expect(formatTranscript([])).toBeNull()
  })

  it("keeps the TAIL and says how much it dropped", () => {
    const messages = Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 3 }, (_, i) => ({
      role: "user",
      parts: text(`m${i}`),
    }))
    const out = formatTranscript(messages)!
    expect(out).toContain("Earlier 3 message(s)")
    // The last message survives, the first three do not.
    expect(out).toContain(`m${MAX_TRANSCRIPT_MESSAGES + 2}`)
    expect(out).not.toContain("m0:")
    expect(out.split("\n\n").filter((l) => l.startsWith("user: "))).toHaveLength(
      MAX_TRANSCRIPT_MESSAGES
    )
  })

  it("does not announce a cut that did not happen", () => {
    const messages = Array.from({ length: MAX_TRANSCRIPT_MESSAGES }, (_, i) => ({
      role: "user",
      parts: text(`m${i}`),
    }))
    expect(formatTranscript(messages)).not.toContain("Earlier")
  })

  it("counts a truncation notice as not-readable on its own", () => {
    // 41 unreadable messages: the notice would be the only line. It must not
    // pass as a transcript.
    const messages = Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 1 }, () => ({
      role: "user",
      parts: [] as unknown as Parts,
    }))
    expect(formatTranscript(messages)).toBeNull()
  })
})

describe("getSessionTranscriptText", () => {
  it("applies whole-message personal filtering to a side chat transcript too", async () => {
    listRecentMessagesMock.mockResolvedValue([
      { id: "public", role: "user", parts: text("visible aside question") },
      {
        id: "private",
        role: "assistant",
        parts: text("PRIVATE_ASIDE_BODY"),
        metadata: {
          personalMarks: [{ person: { kind: "local-person" }, source: "test", markedAt: 1 }],
        },
      },
    ])
    const body = await getSessionTranscriptText("aside")
    expect(body).toContain("visible aside question")
    expect(body).toContain("[Withheld: personal content of Host owner]")
    expect(body).not.toContain("PRIVATE_ASIDE_BODY")
  })

  beforeEach(() => {
    listRecentMessagesMock.mockReset()
  })

  it("withholds the entire personal message before projecting reference text", async () => {
    listRecentMessagesMock.mockResolvedValue([
      {
        id: "private",
        role: "assistant",
        parts: [
          { type: "text", text: "private snippet" },
          { type: "tool-PrivateTool", input: { title: "private title" }, output: "private result" },
        ],
        metadata: {
          personalMarks: [{ person: { kind: "local-person" }, source: "test", markedAt: 1 }],
        },
      },
    ])
    expect(await getSessionTranscriptText("source")).toBe(
      "assistant: [Withheld: personal content of Host owner]"
    )
  })

  // The whole point of the change: `listMessages` read every row of the session
  // WITH its `parts` (a single tool result can be tens of KB) only to keep the
  // last 40. One over-read tells the formatter a cut happened.
  it("reads only the tail, plus one message to detect a cut", async () => {
    listRecentMessagesMock.mockResolvedValue([{ role: "user", parts: text("hi") }])
    await getSessionTranscriptText("s1")
    expect(listRecentMessagesMock).toHaveBeenCalledWith("s1", MAX_TRANSCRIPT_MESSAGES + 1)
  })

  it("returns null for a session with no messages", async () => {
    listRecentMessagesMock.mockResolvedValue([])
    expect(await getSessionTranscriptText("s1")).toBeNull()
  })

  it("announces the cut without claiming to know its size", async () => {
    listRecentMessagesMock.mockResolvedValue(
      Array.from({ length: MAX_TRANSCRIPT_MESSAGES + 1 }, (_, i) => ({
        role: "user",
        parts: text(`m${i}`),
      }))
    )
    const out = await getSessionTranscriptText("s1")
    // Not "[Earlier 1 message(s) …]" — the over-read exposes one dropped
    // message, but the session may hold thousands more that were never read.
    expect(out).toContain("[Earlier messages of this conversation are not included")
    expect(out).not.toContain("Earlier 1 message")
    expect(out).toContain(`most recent ${MAX_TRANSCRIPT_MESSAGES}`)
  })

  it("says nothing about a cut when the session fits", async () => {
    listRecentMessagesMock.mockResolvedValue([{ role: "user", parts: text("only") }])
    expect(await getSessionTranscriptText("s1")).toBe("user: only")
  })
})
