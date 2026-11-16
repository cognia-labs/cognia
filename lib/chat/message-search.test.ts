import type { UIMessage } from "ai"

// Wrapped, not replaced, so a test can count calls to the real function.
jest.mock("@/lib/inbox/extract-plain-text", () => {
  const actual = jest.requireActual("@/lib/inbox/extract-plain-text")
  return { ...actual, extractPlainText: jest.fn(actual.extractPlainText) }
})
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import {
  buildMessageSearchIndex,
  findIndexedMessageHits,
  findMessageHits,
  stepHitIndex,
} from "./message-search"

const msg = (id: string, parts: unknown[]): UIMessage => ({ id, role: "user", parts }) as UIMessage
const textMsg = (id: string, text: string) => msg(id, [{ type: "text", text }])

describe("findMessageHits", () => {
  it("returns matching messages in conversation order with their index", () => {
    const hits = findMessageHits(
      [textMsg("a", "deploy the worker"), textMsg("b", "unrelated"), textMsg("c", "DEPLOY again")],
      "deploy"
    )
    expect(hits).toEqual([
      { id: "a", index: 0, count: 1 },
      { id: "c", index: 2, count: 1 },
    ])
  })

  it("matches case-insensitively", () => {
    expect(findMessageHits([textMsg("a", "Worker")], "wOrKeR")).toHaveLength(1)
  })

  it("counts repeated and overlapping occurrences within one message", () => {
    expect(findMessageHits([textMsg("a", "aaa")], "aa")[0].count).toBe(2)
  })

  it("returns nothing for a blank or whitespace-only query", () => {
    // Matching everything would make next/prev navigation meaningless.
    expect(findMessageHits([textMsg("a", "anything")], "")).toEqual([])
    expect(findMessageHits([textMsg("a", "anything")], "   ")).toEqual([])
  })

  it("ignores leading/trailing whitespace in the query", () => {
    expect(findMessageHits([textMsg("a", "worker")], "  worker  ")).toHaveLength(1)
  })

  it("searches inside code blocks", () => {
    // A `parts[].type === "text"` walk would miss this entirely.
    const hits = findMessageHits(
      [msg("a", [{ type: "code", text: "const worker = 1", language: "ts" }])],
      "worker"
    )
    expect(hits).toHaveLength(1)
  })

  it("searches an A2UI surface's plain-text mirror", () => {
    const hits = findMessageHits(
      [msg("a", [{ type: "a2ui", plainTextMirror: "Approve deployment?" }])],
      "deployment"
    )
    expect(hits).toHaveLength(1)
  })

  it("tolerates a message with no parts", () => {
    expect(findMessageHits([msg("a", []), textMsg("b", "hit")], "hit")).toEqual([
      { id: "b", index: 1, count: 1 },
    ])
  })

  it("returns nothing for an empty conversation", () => {
    expect(findMessageHits([], "x")).toEqual([])
  })

  it("reuses extracted text across successive queries", () => {
    let partsReads = 0
    const message = { id: "a", role: "user" } as UIMessage
    Object.defineProperty(message, "parts", {
      get: () => {
        partsReads++
        return [{ type: "text", text: "deploy the worker" }]
      },
    })

    const index = buildMessageSearchIndex([message])
    expect(findIndexedMessageHits(index, "deploy")).toHaveLength(1)
    expect(findIndexedMessageHits(index, "worker")).toHaveLength(1)
    expect(partsReads).toBe(1)
  })

  it("indexes the typed text, not the context envelope in front of it", () => {
    // Find-in-conversation matches what the bubble shows. A hit inside the
    // envelope would jump to a message whose visible text has no such word.
    const { text } = composeTurnText(
      "typed words",
      [{ kind: "references", text: "SECRET SNAPSHOT" }],
      { nonce: "abcdef0123" }
    )
    const [entry] = buildMessageSearchIndex([textMsg("a", text)])

    expect(entry.text).toContain("typed words")
    expect(entry.text).not.toContain("secret snapshot")
    expect(entry.text).not.toContain("cognia_context_")
    expect(findIndexedMessageHits([entry], "SECRET")).toEqual([])
  })
})

describe("stepHitIndex", () => {
  it("advances forward", () => {
    expect(stepHitIndex(0, 1, 3)).toBe(1)
  })

  it("wraps past the last hit back to the first", () => {
    expect(stepHitIndex(2, 1, 3)).toBe(0)
  })

  it("wraps backwards from the first hit to the last", () => {
    expect(stepHitIndex(0, -1, 3)).toBe(2)
  })

  it("returns -1 when there are no hits", () => {
    expect(stepHitIndex(0, 1, 0)).toBe(-1)
  })

  it("resolves the only hit from an unset current index", () => {
    expect(stepHitIndex(-1, 1, 1)).toBe(0)
  })
})

describe("buildMessageSearchIndex caching", () => {
  it("derives each message's text once and again only for a replaced message", async () => {
    const { extractPlainText } = await import("@/lib/inbox/extract-plain-text")
    const a = { id: "a", role: "user", parts: [{ type: "text", text: "Alpha" }] } as UIMessage
    const b = { id: "b", role: "assistant", parts: [{ type: "text", text: "Be" }] } as UIMessage
    expect(buildMessageSearchIndex([a, b]).map((entry) => entry.text)).toEqual(["alpha", "be"])
    jest.mocked(extractPlainText).mockClear()
    // A streamed frame: the old row is the same object, the reply is new.
    const grown = { ...b, parts: [{ type: "text", text: "Beta" }] } as UIMessage
    expect(buildMessageSearchIndex([a, grown]).map((entry) => entry.text)).toEqual([
      "alpha",
      "beta",
    ])
    expect(extractPlainText).toHaveBeenCalledTimes(1)
  })
})
